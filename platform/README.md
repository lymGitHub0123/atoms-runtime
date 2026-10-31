# Atoms Runtime（v2）

> 按「每任务一个容器 + 持久化目录 + Agent 自验证 + 构建部署」实现的智能体应用运行时。
> 当前部署在 `<your-host>`：控制面 `:13579`，反代/产物 `:24680`。

## 1. 架构

```
浏览器（工作台 UI，由控制面托管）
   │ SSE（Agent 步骤流）        │ iframe（预览）
   ▼                            ▼
控制面 :13579                 反代 :24680
 ├─ 任务 API（创建/查询/删除）   ├─ /preview/{taskId}/  → 127.0.0.1:{20000-21000}
 ├─ Agent 工具循环              │     （HTTP + WebSocket，Vite HMR）
 ├─ 部署（快照 → builder → 发布）└─ /apps/{slug}/        → releases/vN（静态）
 └─ 登录 / 配额 / 闲置回收
        │ docker
        ▼
atoms-sandbox:1（node22 + pnpm，非 root uid 10001）
   /workspace ← /data/atoms-demo-v2/data/admin/{taskId}/code
```

## 2. 目录分层

```
/data/atoms-demo-v2/
├── apps/control/            # 控制面代码 + ui + .env（600）
├── runtime/                 # Dockerfile、proxy.mjs、static-server.mjs、状态 json
├── tools/                   # 独立 Node 22、chrome-headless-shell、puppeteer
├── data/{uid}/{taskId}/
│   ├── code/                # 唯一可变工作区（runtime 挂载）
│   ├── versions/vN.tar.gz   # 部署时的源码快照
│   ├── releases/vN/         # 不可变产物（静态站/构建结果）
│   └── shots/               # browser_check 截图
└── logs/
```

## 3. Agent 循环

工具：`list_files / write_file / read_file / run / dev_server / plan_checks / check_http / browser_check / finish`

```
plan_checks（把需求拆成验收项）
        → 写/改文件 → dev_server 启动预览（Vite HMR）
        → check_http（接口：method/body/状态码/响应片段）
        → browser_check（按键盘/点击/输入 + 断言文本/元素/输入值/控制台错误）
        → 失败原因回灌给模型继续修（最多 40 步）
        → 全部验收项通过才允许 finish
```

- `finish` 有门禁：没有验收清单、改完代码没重新验收、有按钮却没做交互、断言没过，都会被拒绝并返回原因
- 迭代是**秒级热更**，不做构建；构建只发生在部署时
- 沙箱没有 curl/git/ps/pkill，预览启停统一用 `dev_server`
- Vite 预览必须带 `--base=/preview/{taskId}/`；但业务代码里的接口路径要跟着应用根走（`import.meta.env.BASE_URL` 或相对路径），不能写死预览前缀，否则发布后 404

## 4. 部署流程

```
POST /api/tasks/:id/deploy  (SSE 日志)
1. 快照 code → versions/vN.tar.gz（排除 node_modules/dist）
2. 解压快照到 releases/.build-vN，用 builder 容器（非 root）装依赖和构建
3. 产物落到 releases/vN（不可变）：
   · 静态 / SPA → 只留构建结果
   · 服务端应用 → 留完整运行目录（含 node_modules），部署容器挂这一份
4. 发布后自检：资源逐个请求（404 / HTML 回退页判失败）+ 重放这轮验收过的接口和页面操作
5. 发布指针：published.json[slug] = { dir, version, kind }
6. 反代 /apps/{slug}/ 读取指针 → 静态文件（SPA fallback）
```

回滚：`POST /api/tasks/:id/rollback {version}`，界面选历史版本。回滚会先起旧版本、跑一遍自检，失败自动退回原版本；快照和产物都保留。

### 4.1 容器化部署（SSR / 后端）

判据：`package.json` 有 `start` 脚本，或依赖里出现 `next / nuxt / express / fastify / koa / @nestjs/core`。

```
快照 → 解压到 releases/vN → （Vite 项目按根路径构建：npx vite build --base=/）
→ 从 22000–23000 分配端口（同一个 slug 复用原端口）
→ docker run deploy-{slug}，挂载 releases/vN（不再挂工作区），注入 PORT=5173
→ 健康检查（60s 内 / 返回 <500）
→ 静态资源自检 + 重放验收
→ 反代 {slug}.<your-host>.sslip.io:24680 → 127.0.0.1:{port}
```

- 容器应用用**子域名根路径**访问，避免路径前缀破坏 `/_next`、`/api` 这类绝对资源
- `/apps/{slug}/` 对容器应用会 302 跳转到子域名
- 重新部署会重建同名容器；删除任务会一并删除 `deploy-{slug}` 并下线发布
- 应用必须监听 `process.env.PORT`（Express 示例默认 3000，容器里注入 5173）

## 5. 账号与运维

- 账号：`USERS="admin:change-me,alice:change-me"`（未设置时退化为 `ADMIN_PASSWORD` 单账号）
- 目录按账号隔离：`/data/{uid}/{taskId}/`；任务列表与所有任务接口都按 uid 过滤，跨账号访问返回 404
- 登录 Cookie 携带用户名 + HMAC 签名，7 天有效；`POST /api/logout` 退出
- 配额：`MAX_TASKS`（默认 20 个运行中任务）
- 资源上限：沙箱 `1g/1 CPU/512 进程`，部署容器 `512m/0.75 CPU`（`SANDBOX_MEMORY`、`DEPLOY_MEMORY` 等可调）
- 并发：同一个任务的聊天、部署、回滚、删除互斥，第二个请求返回 409
- 文件接口用 `realpath` 判断目录边界，`../` 与软链接越界返回 404
- 闲置回收：`TASK_TTL_HOURS`（默认 6 小时），销毁容器但**保留工作区与产物**
- 端口池：20000–21000，只绑 `127.0.0.1`，公网仅见 24680
- 服务：`systemctl status atoms-control atoms-proxy`；日志 `journalctl -u atoms-control -f`

> 预览 `/preview/{taskId}/` 与产物 `/apps/{slug}/` 目前是公开链接（id 随机不可枚举）。需要更严格时可加一次性 token 或登录态校验。

## 6. API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 口令登录 |
| GET/POST | `/api/tasks` | 列表 / 创建（建目录、起容器、注册预览） |
| GET/DELETE | `/api/tasks/:id` | 详情 / 删除（销毁容器） |
| GET/POST | `/api/tasks/:id/files` | 文件树 / 读写 |
| POST | `/api/tasks/:id/chat` | 触发 Agent（SSE：step / message / done / error） |
| POST | `/api/tasks/:id/deploy` | 快照 + 构建 + 发布（SSE 日志） |
| GET | `/api/tasks/:id/versions` | 可回滚的历史版本 |
| POST | `/api/tasks/:id/rollback` | 切到历史版本（先起服务再验收） |

## 7. 自检

`ops/selfcheck.mjs` 不需要模型，跑一遍鉴权、越权、路径越界、静态发布、服务端发布、两次发布、回滚和清理：

```bash
node ops/selfcheck.mjs http://127.0.0.1:13579 admin <password>
```

`ops/cleanroom.mjs` 只用仓库文件起一套临时控制面 + 反代，再跑上面的自检，用来验证新环境能不能重建：

```bash
node ops/cleanroom.mjs .
```

`ops/regress.mjs` 是模型回归评测：10 条固定需求（2048、贪吃蛇、待办、留言板、仪表盘等）逐条生成，记录是否通过验收、耗时和检查项数量；`--deploy` 会连发布和回放一起跑：

```bash
node ops/regress.mjs http://127.0.0.1:13579 admin <password> --deploy
```

## 8. 已知限制

1. 单机 Docker，无 K8s 调度；多用户隔离只到「目录 + 容器」
2. 路径式部署要求 Vite `base` 正确（已由控制面强制）
3. 未接 AgentSandbox（执行层已抽象为可替换，接口见下）
4. 静态产物由 Node 反代直读文件，量大时应换 Nginx/对象存储

## 9. 后续接 AgentSandbox

执行层只依赖四类操作：`create / exec / writeFile / exposePort`。把 `runTool` 与任务创建里的 docker 调用抽成 `SandboxProvider`，即可在 Docker、OpenSandbox、阿里云 AgentSandbox（兼容 E2B API）之间切换，业务与 UI 不变。