# Atoms Runtime

> 一个按「**每个任务一个容器 + 独立持久化目录 + Agent 自验证 + 一键构建部署**」实现的智能体应用运行时。
>
> 面试 Demo：**http://<your-host>:13579**（登录账号见提交文档，不在此公开）

## 它解决什么问题

大多数「AI 生成应用」的 Demo 停在"生成一段代码"：代码能不能跑、依赖装没装、页面有没有报错，全靠人肉验证。

Atoms Runtime 把这件事做完整：

```
一句话需求
  → 起一个隔离容器，挂载该任务专属目录
  → Agent 在容器里写代码、装依赖、起 dev server
  → Agent 自己用 HTTP + 无头浏览器验证（状态码、可见文本、控制台报错、截图）
  → 失败把错误回灌给模型继续改（最多 20 步）
  → 点部署：快照 + 构建 + 发布
```

## 在线 Demo

| 入口 | 地址 |
| --- | --- |
| 工作台（需登录） | http://<your-host>:13579 |
| 静态 SPA 示例（React 2048） | http://<your-host>:24680/apps/af208933/ |
| 容器应用示例（Express 留言板） | http://83341a65.<your-host>.sslip.io:24680/ |

演示路径见文末「3 分钟演示」。

## 架构

```
浏览器（工作台，由控制面托管）
   │ SSE（Agent 步骤流）              │ iframe（实时预览）
   ▼                                  ▼
控制面 :13579                       反代 :24680
 ├─ 任务 API（创建/查询/删除）          ├─ /preview/{taskId}/  → 沙箱 dev server（HTTP + WS）
 ├─ Agent 工具循环（最多 20 步）        ├─ /apps/{slug}/       → 静态产物（releases/vN）
 ├─ 部署（快照 / 构建 / 发布）          └─ {slug}.<host>.sslip.io → 部署容器 127.0.0.1:22xxx
 ├─ 账号 / 配额 / 闲置回收
 └─ 登录（HMAC Cookie）
        │ docker
        ▼
atoms-sandbox:1（node22 + pnpm，非 root uid 10001）
   /workspace ← /data/atoms-demo-v2/data/{uid}/{taskId}/code
```

## 目录分层

```
/data/atoms-demo-v2/
├── apps/control/            # 控制面代码 + ui + .env（600）
├── runtime/                 # Dockerfile、proxy、static-server、状态 json
├── tools/                   # 独立 Node 22、chrome-headless-shell、puppeteer
├── data/{uid}/{taskId}/
│   ├── code/                # 唯一可变工作区（runtime 挂载）
│   ├── versions/vN.tar.gz   # 部署时源码快照
│   ├── releases/vN/         # 不可变静态产物
│   └── shots/               # browser_check 截图
└── logs/
```

## Agent 工具

`list_files / write_file / read_file / run / check_http / browser_check / finish`

- 迭代是**秒级热更**（容器内 dev server），构建只在部署时发生
- 沙箱无 curl/git，验证统一走内置工具
- 前端项目必须带 `--base=/preview/{taskId}/`，由提示词强制

## 两种部署模式

| 模式 | 判据 | 产物 | 访问方式 |
| --- | --- | --- | --- |
| 静态 / SPA | 无 `start`，有 vite 或 build 脚本 | `releases/vN` 静态文件 | `/apps/{slug}/` |
| 容器 | 有 `start` 脚本，或依赖 next/express/fastify/koa/nest | 端口 22000–23000 的常驻容器 | `{slug}.<host>.sslip.io:24680` |

容器应用用子域名根路径，避免 `/apps/x/` 前缀破坏 `/_next`、`/api` 等绝对资源。

## 关键设计

1. **每任务一个容器 + 独立目录**：`/data/{uid}/{taskId}`，容器只挂 `code/`；Agent 看不到别人的快照和产物。
2. **账号即隔离**：`USERS` 配置账号，Cookie 带 uid，所有任务接口按 uid 过滤，跨账号 404。
3. **Agent 自验证**：`check_http` 看状态与文本，`browser_check` 用无头 Chrome 看控制台报错并截图；失败回灌重试。
4. **不可变产物 + 指针发布**：`releases/vN` 不覆盖，发布记录切换指针；删除任务会删两个容器（沙箱 + 部署）并下线链接。
5. **运维兜底**：`MAX_TASKS` 配额、6 小时闲置回收（容器销毁、工作区保留）、部署端口池 22000–23000、预览端口池 20000–21000。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 用户名 + 密码 |
| GET/POST | `/api/tasks` | 列表 / 创建（建目录 + 起沙箱） |
| GET/PATCH/DELETE | `/api/tasks/:id` | 详情 / 改名 / 删除（删两个容器 + 下线） |
| GET/POST | `/api/tasks/:id/files` | 文件树 / 读写 |
| GET/POST | `/api/tasks/:id/exec` | 在沙箱执行命令 |
| POST | `/api/tasks/:id/chat` | 触发 Agent（SSE：step / message / done / error） |
| POST | `/api/tasks/:id/deploy` | 快照 + 构建 + 发布（SSE 日志） |

## 快速开始

前置：Linux（或 WSL2）+ Docker + Node 22。

```bash
# 1. 构建沙箱镜像
cd ops && docker build -t atoms-sandbox:1 -f sandbox.Dockerfile .

# 2. 放置运行时文件
sudo mkdir -p /data/atoms-demo-v2/{apps/control,runtime,data,logs}

# 3. 配置环境变量（不要提交）
cat > /data/atoms-demo-v2/apps/control/.env <<'EOF'
DASHSCOPE_API_KEY=sk-xxx
LLM_MODEL=deepseek-v4.1-flash
LLM_BASE_URL=https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
LLM_EXTRA_BODY={"enable_thinking":false}
USERS=admin:change-me,alice:change-me
AUTH_SECRET=<random>
PUBLIC_PROXY_BASE=http://<your-ip>:24680
PUBLIC_APP_HOST_SUFFIX=<your-ip>.sslip.io
PUBLIC_APP_PORT=24680
EOF

# 4. 启动（或改用 systemd unit：platform/atoms-control.service、ops/atoms-proxy.service）
node platform/server.mjs          # 控制面 :13579
node ops/proxy.mjs                # 反代 :24680
```

## 3 分钟演示

1. 打开工作台 → 用提交文档里提供的账号登录
2. 新建任务，输入「用 Express 做一个留言板：server.js 提供 GET/POST /api/messages，数据存 data.json；public/index.html 展示列表并可提交；start 脚本 node server.js，监听 process.env.PORT || 3000」
3. 看左侧 Agent Flow：写文件 → `npm install express` → 起服务 → `check_http` → `browser_check`（控制台 0 报错）
4. 点「部署」→ 日志出现「启动部署容器 deploy-xxxx · 端口 22xxx」→ 弹出地址，复制
5. 打开容器应用地址，发一条留言；换浏览器/无痕再打开，数据还在（服务端 data.json）
6. 回到工作台，点「文件」看源码、点任务卡片 `×` 删除 → 容器与发布链接一起回收

再演示静态模式：新建「用 react 写一个 2048」→ 预览即热更 → 部署得到 `/apps/{slug}/`（不启容器）。

## 取舍（面试答辩）

1. **Agent 循环用工具调用，不做一次性代码生成**：因为"能不能跑"才是生成器的核心价值；代价是单任务 Token 消耗约为一次性生成的 10 倍。
2. **部署分静态/容器两条路**：静态不启容器（省资源、天然稳定）；只有需要常驻进程的 SSR/API/WebSocket 才起容器，避免"为静态文件跑一个 nginx"。
3. **容器应用走子域名而不是路径前缀**：路径前缀会破坏 `/_next`、`/api`；子域名用 sslip.io，无需 DNS 配置即可公网访问。
4. **删除任务保留工作区**：容器销毁、文件保留，便于误删恢复；需要彻底删除可加 purge。
5. **未接 AgentSandbox**：执行层只依赖 `create/exec/writeFile/exposePort` 四类操作，抽象成 Provider 后可在 Docker / OpenSandbox / 阿里云 AgentSandbox（E2B 兼容）之间切换。

## 已知限制

- 单机 Docker，无 K8s 调度；隔离粒度到「容器 + 用户目录」
- 演示环境是 HTTP，账号密码明文传输，仅适合短期评审
- 预览与发布链接目前是公开的（id/slug 随机不可枚举）
- 容器应用要求 `start` 脚本监听 `process.env.PORT`
- Node 服务构建/安装依赖受 npm 源速度影响

## 目录

```
platform/
  server.mjs        控制面：任务 / Agent / 部署 / 鉴权
  ui/               工作台（原生 JS，三栏布局）
  README.md         更细的架构与运维说明
ops/
  sandbox.Dockerfile
  proxy.mjs         反代：预览（含 WS）· 静态产物 · 子域名路由
  static-server.mjs 沙箱内静态服务（支持 base）
  browser-check.mjs 无头 Chrome 验证
  *.service         systemd 单元
docs/screenshots/   工作台 / 文件树 / 部署 / 预览截图
```