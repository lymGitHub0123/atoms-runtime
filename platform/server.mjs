/**
 * Atoms Runtime 控制面
 * - 任务：目录隔离 + 容器 + 预览端口
 * - Agent：带工具循环，SSE 推送每一步，支持多轮对话
 * - 部署：源码快照 → builder → releases → /apps/{slug}/
 * - 登录：口令 + HMAC Cookie（可选，设置 ADMIN_PASSWORD 后启用）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 13579);
const ROOT = process.env.ATOMS_ROOT || "/data/atoms-demo-v2";
const IMAGE = process.env.SANDBOX_IMAGE || "atoms-sandbox:1";
const UID = process.env.SANDBOX_UID || "10001";
const APP_PORT_MIN = Number(process.env.APP_PORT_MIN || 20000);
const APP_PORT_MAX = Number(process.env.APP_PORT_MAX || 21000);
const CONTAINER_PORT = 5173;
const DEPLOY_PORT_MIN = Number(process.env.DEPLOY_PORT_MIN || 22000);
const DEPLOY_PORT_MAX = Number(process.env.DEPLOY_PORT_MAX || 23000);
const APP_HOST_SUFFIX = (process.env.PUBLIC_APP_HOST_SUFFIX || "").replace(/^\.+/, "");
const PUBLIC_APP_PORT = process.env.PUBLIC_APP_PORT || "24680";
const PROXY_PORT = Number(
  process.env.PROXY_PORT ||
    (() => {
      try {
        return new URL(process.env.PUBLIC_PROXY_BASE || "").port;
      } catch {
        return 0;
      }
    })() ||
    24680,
);
const STATE_FILE = path.join(ROOT, "runtime/tasks.json");
const PREVIEW_MAP = path.join(ROOT, "runtime/preview.json");
const PUBLISH_FILE = path.join(ROOT, "runtime/published.json");
const UI_DIR = path.join(ROOT, "apps/control/ui");

const LLM = {
  key: (process.env.DASHSCOPE_API_KEY || "").trim(),
  base: (process.env.LLM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, ""),
  model: process.env.LLM_MODEL || "qwen3.8-max",
  extra: (() => {
    try {
      return process.env.LLM_EXTRA_BODY ? JSON.parse(process.env.LLM_EXTRA_BODY) : {};
    } catch {
      return {};
    }
  })(),
};

const MAX_TASKS = Number(process.env.MAX_TASKS || 20);
const TTL_HOURS = Number(process.env.TASK_TTL_HOURS || 6);
const SANDBOX_MEMORY = process.env.SANDBOX_MEMORY || "1g";
const SANDBOX_CPUS = process.env.SANDBOX_CPUS || "1";
const SANDBOX_PIDS = process.env.SANDBOX_PIDS || "512";
const DEPLOY_MEMORY = process.env.DEPLOY_MEMORY || "512m";
const DEPLOY_CPUS = process.env.DEPLOY_CPUS || "0.75";
const NODE_BIN = process.env.TOOLS_NODE || "/data/atoms-demo-v2/tools/node/bin/node";
const BROWSER_BIN = process.env.BROWSER_CHECK || "/data/atoms-demo-v2/tools/pw/browser-check.mjs";

const taskLocks = new Set();
function lockTask(id) {
  if (taskLocks.has(id)) return false;
  taskLocks.add(id);
  return true;
}
function unlockTask(id) {
  taskLocks.delete(id);
}

const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();
const SECRET = process.env.AUTH_SECRET || ADMIN_PASSWORD || "atoms-demo";

/** 账号来源：USERS="admin:pass,alice:pass"；只配 ADMIN_PASSWORD 时退化为单账号 admin */
const USERS = (() => {
  const raw = (process.env.USERS || "").trim();
  const items = raw
    ? raw.split(",").map((x) => x.trim()).filter(Boolean)
    : ADMIN_PASSWORD
      ? [`admin:${ADMIN_PASSWORD}`]
      : [];
  return items
    .map((item) => {
      const index = item.indexOf(":");
      if (index <= 0) return null;
      const name = item.slice(0, index).trim();
      const password = item.slice(index + 1);
      if (!/^[a-z0-9_-]{2,24}$/i.test(name) || !password) return null;
      const salt = crypto.randomBytes(12).toString("hex");
      const hash = crypto.scryptSync(password, salt, 32).toString("hex");
      return { name, salt, hash };
    })
    .filter(Boolean);
})();
const AUTH_ENABLED = USERS.length > 0;

function verifyUser(name, password) {
  const record = USERS.find((x) => x.name === name);
  if (!record) return false;
  const hash = crypto.scryptSync(String(password || ""), record.salt, 32);
  return crypto.timingSafeEqual(hash, Buffer.from(record.hash, "hex"));
}
const COOKIE = "atoms_auth";

/* ---------------- utils ---------------- */

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

const loadTasks = () => {
  const state = readJson(STATE_FILE, { tasks: {} });
  for (const task of Object.values(state.tasks)) {
    if (!task.uid) task.uid = "admin";
  }
  return state;
};

function saveTasks(state) {
  writeJson(STATE_FILE, state);
  const map = {};
  for (const task of Object.values(state.tasks)) {
    if (task.status === "running") map[task.id] = task.port;
  }
  writeJson(PREVIEW_MAP, map);
}

const taskRoot = (task) => path.join(ROOT, "data", task.uid || "admin", task.id);
const taskCode = (task) => path.join(taskRoot(task), "code");

function ensureInside(root, target) {
  const base = fs.realpathSync(root);
  const full = path.resolve(base, target || ".");
  const rel = path.relative(base, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("路径越界");
  if (fs.existsSync(full)) {
    const real = fs.realpathSync(full);
    const realRel = path.relative(base, real);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) throw new Error("路径越界");
    return real;
  }
  return full;
}

function normalizeRel(input) {
  return String(input || "")
    .trim()
    .replace(/^\/workspace\/?/, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function writeFile(task, relPath, content) {
  const root = taskCode(task);
  const full = ensureInside(root, normalizeRel(relPath));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  try {
    fs.chownSync(full, Number(UID), Number(UID));
  } catch {
    /* ignore */
  }
  return path.relative(root, full);
}

function readFile(task, relPath) {
  const full = ensureInside(taskCode(task), normalizeRel(relPath));
  return fs.readFileSync(full, "utf8");
}

function listFiles(task, depth = 3) {
  const root = taskCode(task);
  const out = [];
  const walk = (dir, prefix, level) => {
    if (level > depth) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist", ".cache"].includes(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(path.join(dir, entry.name), rel, level + 1);
      } else {
        out.push(rel);
      }
    }
  };
  try {
    walk(root, "", 1);
  } catch {
    return [];
  }
  return out;
}

function detectStack(task) {
  try {
    const file = path.join(taskCode(task), "package.json");
    if (!fs.existsSync(file)) return "原生 HTML/JS";
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const parts = [];
    if (deps.next) parts.push("Next.js");
    else if (deps.nuxt) parts.push("Nuxt");
    else if (deps.react) parts.push("React 18");
    else if (deps.vue) parts.push("Vue 3");
    if (deps.express) parts.push("Express");
    else if (deps.fastify) parts.push("Fastify");
    else if (deps.koa) parts.push("Koa");
    if (deps.vite) parts.push("Vite");
    if (pkg.scripts?.start) parts.push("服务端");
    return parts.length ? parts.join(" + ") : "Node";
  } catch {
    return "未知";
  }
}

function docker(args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        out: String(stdout || ""),
        err: String(stderr || ""),
      });
    });
  });
}

async function allocatePort(state) {
  const used = new Set(Object.values(state.tasks).map((task) => task.port).filter(Boolean));
  for (let port = APP_PORT_MIN; port <= APP_PORT_MAX; port += 1) {
    if (used.has(port)) continue;
    const free = await new Promise((resolve) => {
      const s = http.createServer();
      s.once("error", () => resolve(false));
      s.once("listening", () => s.close(() => resolve(true)));
      s.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error("端口池已满");
}

/* ---------------- auth ---------------- */

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sign = (value) => crypto.createHmac("sha256", SECRET).update(value).digest("base64url");

function makeToken(user) {
  const payload = b64url(JSON.stringify({ u: user, exp: Date.now() + 7 * 864e5 }));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (sign(payload) !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.exp || data.exp <= Date.now()) return null;
    return typeof data.u === "string" && data.u ? data.u : null;
  } catch {
    return null;
  }
}

function currentUser(req) {
  if (!AUTH_ENABLED) return "admin";
  const cookie = req.headers.cookie || "";
  const match = cookie.match(new RegExp(`${COOKIE}=([^;]+)`));
  return verifyToken(match?.[1]);
}

/* ---------------- agent tools ---------------- */

const TOOLS = [
  { type: "function", function: { name: "list_files", description: "列出 /workspace 文件", parameters: { type: "object", properties: {} } } },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "写入文件到 /workspace（自动建目录）",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
  },
  { type: "function", function: { name: "read_file", description: "读取 /workspace 文件", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  {
    type: "function",
    function: {
      name: "run",
      description: "在沙箱执行命令；background=true 后台运行（启动 dev server 用）。需要脚本验证的验收项可带 checkId（可选 expect 匹配输出）",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          background: { type: "boolean" },
          timeout: { type: "number" },
          checkId: { type: "string" },
          expect: { type: "string" },
        },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_checks",
      description: "写代码前先把需求拆成用户视角的验收项，每个交互至少一条。finish 前所有验收项必须通过。",
      parameters: {
        type: "object",
        properties: {
          checks: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, desc: { type: "string" } },
              required: ["id", "desc"],
            },
          },
        },
        required: ["checks"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dev_server",
      description: "启动/重启/停止预览服务。修改代码后重启用它，不要用 ps/pkill（沙箱里没有）。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "restart", "stop"] },
          cmd: { type: "string", description: "启动命令，start/restart 时必填" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_http",
      description: "从宿主机请求应用接口，返回状态码与响应片段。服务端接口验收用这个，带 checkId 表示该验收项通过。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          body: { type: "string" },
          headers: { type: "object" },
          expect: { type: "string" },
          expectStatus: { type: "number" },
          checkId: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_check",
      description: "无头浏览器打开预览页。actions 按顺序按键/点击/输入，expect 断言结果；页面操作过才可能通过 finish。带 checkIds 表示这些验收项通过。",
      parameters: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["press", "click", "fill", "wait", "reload"] },
                key: { type: "string" },
                selector: { type: "string" },
                value: { type: "string" },
                ms: { type: "number" },
              },
              required: ["type"],
            },
          },
          expect: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: [
                    "textContains",
                    "textNotContains",
                    "selectorExists",
                    "selectorCount",
                    "inputValue",
                    "urlContains",
                    "consoleErrors",
                    "requestFailures",
                    "noPageOverflow",
                  ],
                },
                selector: { type: "string" },
                value: { type: "string" },
                min: { type: "number" },
                max: { type: "number" },
                equals: { type: "number" },
              },
              required: ["type"],
            },
          },
          viewport: {
            type: "object",
            properties: { width: { type: "number" }, height: { type: "number" } },
            description: "可选视口，例如 400x860 测窄屏",
          },
          checkIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  { type: "function", function: { name: "finish", description: "任务完成；验收未通过会被拒绝", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
];

const SYSTEM_PROMPT = `你是 Atoms Runtime 里的工程 Agent，在隔离 Linux 沙箱中工作，工作目录 /workspace，容器用户 agent。

工具：list_files / write_file / read_file / run / dev_server / check_http / browser_check / plan_checks / finish。

工作顺序：
1. 先 plan_checks：把需求拆成用户视角、可执行的验收项，每个交互至少一条。
   例：需求「做一个 2048」→ 按 ↑ 方块向上移动 / 按 → 方块向右移动 / 两个相同数字合并后分数增加 / 新游戏清零。
   每项起一个短 id，后面 check_http、browser_check 带上这个 id。
2. 再写代码，小步修改。写完用 dev_server 启动或重启预览（不要用 ps/pkill）：
   · 纯 HTML：cmd = node /opt/static-server.mjs /workspace 5173 /preview/{taskId}/
   · React/Vite：先 run "npm install --no-audit --no-fund"，再 dev_server cmd = npx vite --host 0.0.0.0 --port 5173 --base=/preview/{taskId}/
   · 服务端应用：npm install，dev_server cmd = PORT=5173 node server.js（或你的 start 命令）
3. 验收（这一步不能省）：
   · 每个交互控件都要用 browser_check 的 actions 真实操作一次，并用 expect 断言结果；只截图不算验收。
   · 例：按 ↑ 后断言方块位置或分数变化；点「添加」后断言列表里出现新内容；刷新后断言数据还在。
   · 服务端接口用 check_http（method/body/expectStatus/expect），并带 checkId。
   · 没法用浏览器或接口证明的（依赖数量、构建产物、文件内容），用 run 跑脚本并带 checkId；列验收项时就要想好怎么验证。
   · 修完必须重新验收；最后一次改代码之后的结果才算数。
4. 所有验收项通过后才调用 finish，summary 写清功能和访问方式。没过的 finish 会被拒绝，你会拿到原因。

约束：
· 最多 40 步，别把步数耗在重启服务上，用 dev_server。
· 验收要稳定：随机应用（2048 新方块、贪吃蛇食物）不要断言精确棋盘，断言不变量（如按 ↑ 后每列方块连续贴顶、分数增加、无控制台错误）。
· 达成 2048、游戏结束这类难以在界面上稳定触发的检查，用 run 跑逻辑脚本并带 checkId，不要靠 UI 碰运气。
· 同一断言连续失败两次，就换验证方式（reload、换选择器、改断言）；验收项本身不可验证或太不稳定时，重新 plan_checks 换掉，不要原样重试。
· 同一条命令或同一个检查不要连续重跑；连续两次没有新信息就换方法：读代码、改映射、重新 plan_checks。方向类逻辑用四组固定棋盘做单元测试，失败就直接改映射。
· 前端请求同源接口时，路径跟着应用根走：Vite 用 import.meta.env.BASE_URL + 'api/xxx'，纯 HTML 用相对路径 './api/xxx'。绝对不要写死 /preview/{taskId}/，部署时应用挂在根路径，写死会导致发布后全部请求 404。
· 纯 HTML 用相对路径引用资源（./style.css），不要用 /style.css。
· Vite 项目 package.json 必须同时有 dev 和 build 脚本。
· 服务端应用必须监听 process.env.PORT（预览时是 5173），静态目录用绝对路径（path.join(__dirname, ...)）。
· 沙箱里没有 curl / git / wget / ps / pkill。
· 文件 path 用相对路径（如 index.html、src/App.jsx），不要写 /workspace/ 前缀。
· 中文界面，视觉精致；业务数据不要存 localStorage（主题偏好可以）。`;

async function callModel(messages) {
  const body = JSON.stringify({
    model: LLM.model,
    messages,
    tools: TOOLS,
    tool_choice: "auto",
    temperature: 0.4,
    ...LLM.extra,
  });
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(`${LLM.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${LLM.key}` },
        body,
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`模型调用失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

async function runTool(task, name, args, gate) {
  switch (name) {
    case "list_files":
      return { ok: true, output: listFiles(task).join("\n") || "(空目录)" };
    case "write_file": {
      const rel = writeFile(task, args.path, args.content ?? "");
      if (gate) {
        gate.dirty = true;
        gate.callCounts.clear();
        gate.checkFails.clear();
        gate.unstable.clear();
        gate.blockedSpecs.clear();
      }
      return { ok: true, output: `已写入 ${rel}` };
    }
    case "read_file":
      return { ok: true, output: readFile(task, args.path).slice(0, 12000) };
    case "plan_checks": {
      const checks = Array.isArray(args.checks) ? args.checks.slice(0, 12) : [];
      if (!checks.length) return { ok: false, error: "至少给一条验收项" };
      const next = new Map();
      const list = [];
      for (const item of checks) {
        const id = String(item.id || "").trim().slice(0, 40);
        const desc = String(item.desc || "").trim().slice(0, 160);
        if (!id || !desc) continue;
        next.set(id, desc);
        list.push(`${id}: ${desc}`);
      }
      if (gate) {
        gate.checks = next;
        for (const id of [...gate.verified]) if (!next.has(id)) gate.verified.delete(id);
        gate.checkFails.clear();
        gate.unstable.clear();
        gate.blockedSpecs.clear();
        gate.callCounts.clear();
        gate.nudged = false;
        gate.needNudge = false;
      }
      return { ok: list.length > 0, output: `验收项 ${list.length} 条：\n${list.join("\n")}` };
    }
    case "dev_server": {
      const action = String(args.action || "restart");
      const pidfile = "/tmp/atoms-preview.pid";
      const base = ["exec", "-u", "agent", "-w", "/workspace", task.container];
      if (action !== "start") {
        await docker([...base, "sh", "-lc", `if [ -f ${pidfile} ]; then kill $(cat ${pidfile}) 2>/dev/null; rm -f ${pidfile}; fi; sleep 1`], { timeout: 20000 });
        if (action === "stop") return { ok: true, output: "预览已停止" };
      }
      const cmd = String(args.cmd || "").trim();
      if (!cmd) return { ok: false, error: "start/restart 需要 cmd" };
      const res = await docker(["exec", "-d", "-u", "agent", "-w", "/workspace", task.container, "sh", "-lc", `echo $$ > ${pidfile}; exec ${cmd}`], { timeout: 20000 });
      return { ok: res.code === 0, output: res.code === 0 ? "预览已启动" : res.err || res.out || "启动失败" };
    }
    case "run": {
      const base = ["exec", "-u", "agent", "-w", "/workspace", task.container];
      if (args.background) {
        const res = await docker(["exec", "-d", "-u", "agent", "-w", "/workspace", task.container, "sh", "-lc", args.cmd], { timeout: 20000 });
        return { ok: res.code === 0, output: res.code === 0 ? "已后台启动" : (res.err || res.out || "启动失败") };
      }
      const timeout = Math.min(Math.max(Number(args.timeout) || 60, 5), 180) * 1000;
      const res = await docker([...base, "sh", "-lc", args.cmd], { timeout });
      const output = `${res.out}${res.err ? `\n[stderr]\n${res.err}` : ""}`.slice(-8000);
      if (gate && res.code === 0 && args.checkId && gate.checks.has(String(args.checkId))) {
        if (!args.expect || output.includes(String(args.expect))) gate.verified.add(String(args.checkId));
      }
      return { ok: res.code === 0, exit: res.code, output };
    }
    case "browser_check": {
      const url = `http://127.0.0.1:${task.port}/preview/${task.id}/`;
      const shotDir = path.join(taskRoot(task), "shots");
      fs.mkdirSync(shotDir, { recursive: true });
      const shot = path.join(shotDir, `check-${Date.now()}.png`);
      const spec = {
        actions: Array.isArray(args.actions) ? args.actions : [],
        expect: Array.isArray(args.expect) ? args.expect : [],
        ...(args.viewport ? { viewport: args.viewport } : {}),
      };
      const ids = Array.isArray(args.checkIds) ? args.checkIds.map(String) : [];
      const key = JSON.stringify(spec);

      if (gate) {
        const blocked = ids.filter((id) => gate.unstable.has(id));
        if (blocked.length) {
          gate.needNudge = true;
          return {
            ok: false,
            error: `验收项 ${blocked.join("、")} 已连续失败 3 次。先重新 plan_checks，换成能稳定验证的断言（随机结果用不变量），再继续。`,
          };
        }
        if (gate.blockedSpecs.has(key)) {
          gate.needNudge = true;
          return { ok: false, error: "同一套检查已连续失败 3 次。换一种验证方式，或改代码后再试。" };
        }
      }

      const specPath = path.join(ROOT, "runtime", `spec-${task.id}-${Date.now()}.json`);
      fs.writeFileSync(specPath, JSON.stringify(spec));
      const raw = await new Promise((resolve) => {
        execFile(
          NODE_BIN,
          [BROWSER_BIN, url, shot, "2500", specPath],
          { timeout: 120000, cwd: path.dirname(BROWSER_BIN), maxBuffer: 2 * 1024 * 1024 },
          (_error, stdout) => resolve(String(stdout || "")),
        );
      });
      fs.rmSync(specPath, { force: true });
      try {
        const data = JSON.parse(raw);
        const actionsRun = (data.actions || []).length;
        if (gate) {
          gate.browserOk = Boolean(data.ok);
          gate.browserAt = Date.now();
          gate.buttons = Math.max(gate.buttons, Number(data.buttons) || 0);
          gate.inputs = Math.max(gate.inputs, Number(data.inputs) || 0);
          gate.actionsRun += actionsRun;
          gate.expectsRun += spec.expect.length;
          if (data.ok && spec.actions.length && spec.expect.length) gate.browserSpec = spec;
          if (data.ok) gate.dirty = false;
          for (const id of Array.isArray(args.checkIds) ? args.checkIds : []) {
            if (data.ok && gate.checks.has(String(id))) gate.verified.add(String(id));
          }
        }
        const failures = data.failures || [];
        let hint = "";
        if (gate) {
          if (data.ok) {
            gate.failCounts.delete(key);
            for (const id of ids) {
              gate.checkFails.delete(id);
              gate.unstable.delete(id);
            }
          } else {
            gate.browserFailTotal += 1;
            const count = (gate.failCounts.get(key) || 0) + 1;
            gate.failCounts.set(key, count);
            if (count >= 3) gate.blockedSpecs.add(key);
            const unstableNow = [];
            for (const id of ids) {
              const times = (gate.checkFails.get(id) || 0) + 1;
              gate.checkFails.set(id, times);
              if (times >= 3) {
                gate.unstable.add(id);
                unstableNow.push(id);
              }
            }
            if (unstableNow.length) {
              gate.needNudge = true;
              hint = `验收项 ${unstableNow.join("、")} 连续失败 3 次。先重新 plan_checks，换成能稳定验证的断言；不要继续原样重试。`;
            } else if (count >= 2) {
              hint = "同一个断言已经失败两次。换一种验证方式（reload 后重测、改选择器、改断言），不要原样重试。";
            }
          }
        }
        const summary = `标题=${data.title || "-"}；文本=${String(data.text || "").slice(0, 60)}；动作=${actionsRun}；断言失败=${failures.length}；控制台错误=${(data.errors || []).length}`;
        return {
          ok: Boolean(data.ok),
          status: data.status,
          title: data.title,
          buttons: data.buttons,
          inputs: data.inputs,
          failures,
          hint,
          errors: data.errors || [],
          requestFailures: data.requestFailures || [],
          screenshot: data.screenshot,
          output: [failures.length ? `${summary}\n${failures.join("\n")}` : summary, hint].filter(Boolean).join("\n"),
        };
      } catch {
        if (gate) gate.browserOk = false;
        return { ok: false, error: "浏览器检查失败", output: raw.slice(0, 300) };
      }
    }
    case "check_http": {
      const target = `http://127.0.0.1:${task.port}${args.path || "/"}`;
      const started = Date.now();
      const init = { method: args.method || "GET", headers: args.headers || {}, signal: AbortSignal.timeout(8000) };
      if (args.body != null && init.method !== "GET") init.body = String(args.body);
      try {
        const res = await fetch(target, init);
        const text = await res.text();
        const expectMatched = args.expect ? text.includes(args.expect) : true;
        const statusMatched = args.expectStatus ? res.status === Number(args.expectStatus) : true;
        const ok = res.ok && expectMatched && statusMatched;
        if (gate) {
          gate.httpOk = ok;
          if (ok && args.checkId && gate.checks.has(String(args.checkId))) gate.verified.add(String(args.checkId));
          if (ok && args.path) {
            const rec = {
              method: init.method,
              path: args.path,
              body: init.body ?? null,
              expect: args.expect || null,
              expectStatus: args.expectStatus || null,
            };
            const key = JSON.stringify(rec);
            if (!gate.httpChecks.some((item) => JSON.stringify(item) === key)) gate.httpChecks.push(rec);
          }
        }
        return {
          ok,
          status: res.status,
          ms: Date.now() - started,
          expectMatched,
          statusMatched,
          snippet: text.slice(0, 600),
        };
      } catch (error) {
        if (gate) gate.httpOk = false;
        return { ok: false, error: String(error.message || error) };
      }
    }
    default:
      return { ok: false, error: "未知工具" };
  }
}

function gateProblems(gate) {
  const problems = [];
  if (gate.checks.size === 0) problems.push("还没用 plan_checks 列出验收项");
  const missing = [...gate.checks.keys()].filter((id) => !gate.verified.has(id));
  if (missing.length) problems.push(`这些验收项还没通过：${missing.join("、")}`);
  if (gate.dirty) problems.push("最后一次改代码之后没有重新验收");
  if (!gate.browserOk) problems.push("browser_check 还没通过（或最后一次失败）");
  if (gate.buttons > 0 && gate.actionsRun === 0) problems.push("页面有按钮，但一次交互检查都没做");
  if (gate.buttons > 0 && gate.expectsRun === 0) problems.push("做了操作但没有写断言（expect）");
  return problems;
}

function gateSnapshot(gate) {
  return {
    plan: [...gate.checks.entries()].map(([id, desc]) => ({ id, desc })),
    http: gate.httpChecks,
    browser: gate.browserSpec,
    at: new Date().toISOString(),
  };
}

async function runAgent(task, prompt, send) {
  const events = [];
  const gate = {
    checks: new Map(),
    verified: new Set(),
    dirty: false,
    browserOk: false,
    httpOk: null,
    buttons: 0,
    inputs: 0,
    actionsRun: 0,
    expectsRun: 0,
    httpChecks: [],
    browserSpec: null,
    failCounts: new Map(),
    checkFails: new Map(),
    unstable: new Set(),
    blockedSpecs: new Set(),
    callCounts: new Map(),
    browserFailTotal: 0,
    nudged: false,
    needNudge: false,
  };
  const record = (event) => {
    if (event.type === "step" && event.result) {
      const text =
        event.result.output ||
        event.result.error ||
        event.result.snippet ||
        (event.result.status ? `HTTP ${event.result.status}` : "") ||
        event.args?.summary ||
        (event.tool === "finish" ? "完成" : JSON.stringify(event.result).slice(0, 200));
      const meta =
        event.tool === "browser_check" || event.tool === "check_http" || event.tool === "plan_checks"
          ? JSON.stringify(event.args || {}).slice(0, 400)
          : "";
      events.push({ tool: event.tool, ok: Boolean(event.result.ok), text: String(text).slice(0, 240), meta });
    }
  };
  const emit = (event) => {
    record(event);
    send(event);
  };
  const history = (task.messages || []).slice(-12).map((m) => ({ role: m.role, content: m.content }));
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: `需求：${prompt}\n\n（任务 ID: ${task.id}；预览 base 路径：/preview/${task.id}/，Vite dev server 必须带 --base=/preview/${task.id}/）` },
  ];

  for (let step = 1; step <= 40; step += 1) {
    if (step === 33) {
      messages.push({ role: "user", content: "只剩 7 步。优先保证核心功能可验证、所有验收项通过后 finish；不要新增功能，也不要原样重复失败的断言。" });
    }
    const payload = await callModel(messages);
    const message = payload.choices?.[0]?.message ?? {};
    const calls = message.tool_calls ?? [];
    if (message.content) emit({ type: "message", step, text: message.content });
    if (calls.length === 0) {
      const problems = gateProblems(gate);
      if (problems.length) {
        messages.push({ role: "assistant", content: message.content || "" });
        messages.push({ role: "user", content: `验收还没过：${problems.join("；")}。请继续修复并用 plan_checks 里的 checkId 完成验收，再 finish。` });
        continue;
      }
      emit({ type: "done", step, summary: message.content || "完成" });
      return { summary: message.content || "完成", events, checks: gateSnapshot(gate), verified: true };
    }
    messages.push({ role: "assistant", content: message.content || null, tool_calls: calls });

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = {};
      }
      if (name === "finish") {
        const problems = gateProblems(gate);
        if (problems.length) {
          const rejected = { ok: false, error: `验收未通过：${problems.join("；")}。修好后再 finish。` };
          emit({ type: "step", step, tool: "finish", args, result: rejected });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(rejected) });
          continue;
        }
        emit({ type: "step", step, tool: "finish", args, result: { ok: true } });
        emit({ type: "done", step, summary: args.summary || "完成" });
        return { summary: args.summary || "完成", events, checks: gateSnapshot(gate), verified: true };
      }
      emit({ type: "step", step, tool: name, args });
      const callKey = `${name}|${JSON.stringify(args).slice(0, 400)}`;
      const repeats = (gate.callCounts.get(callKey) || 0) + 1;
      gate.callCounts.set(callKey, repeats);
      let result;
      if (repeats > 3) {
        result = { ok: false, error: "同一个工具调用已经重复 3 次，先停下来想清楚，换一种做法或直接改代码，不要原样重试。" };
      } else {
        result = await runTool(task, name, args, gate);
      }
      emit({ type: "step", step, tool: name, args, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ tool: name, ...result }).slice(0, 12000) });
    }
    if ((gate.needNudge || gate.browserFailTotal >= 5) && !gate.nudged) {
      gate.nudged = true;
      const unstable = [...gate.unstable];
      messages.push({
        role: "user",
        content: unstable.length
          ? `验收项 ${unstable.join("、")} 连续失败 3 次。不要继续重试：先 plan_checks 把这些项换成能稳定验证的断言（随机游戏用不变量，不要断言具体分数或位置），再继续。`
          : "页面检查已经失败多次。停止原样重试：每次 browser_check 都会重新加载页面，随机应用不要断言精确分数或方块位置；把依赖多步的操作合并到一次 browser_check，用不变量断言；验收项本身不稳定就重新 plan_checks 换掉。",
      });
    }
  }
  send({ type: "done", step: 40, summary: "未通过验收（达到步数上限）" });
  return { summary: "未通过验收（达到步数上限）", events, verified: false };
}

/* ---------------- deploy ---------------- */

async function allocateDeployPort(published) {
  const used = new Set(
    Object.values(published.apps || {})
      .map((app) => app.port)
      .filter(Boolean),
  );
  for (let port = DEPLOY_PORT_MIN; port <= DEPLOY_PORT_MAX; port += 1) {
    if (used.has(port)) continue;
    const free = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error("部署端口池已满");
}

async function waitHealthy(port, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

function appUrl(slug) {
  return APP_HOST_SUFFIX ? `http://${slug}.${APP_HOST_SUFFIX}:${PUBLIC_APP_PORT}/` : `/apps/${slug}/`;
}

function runStream(cmd, args, onLine) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const pipe = (stream) => {
      let buf = "";
      stream.on("data", (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      stream.on("end", () => buf && onLine(buf));
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, status: res.status, type: res.headers.get("content-type") || "", html: await res.text() };
  } catch (error) {
    return { ok: false, status: 0, type: "", html: "", error: String(error.message || error) };
  }
}

async function findBrokenAssets(baseUrl) {
  const page = await fetchPage(baseUrl);
  if (!page.ok) return [`首页 ${baseUrl} 返回 ${page.status || page.error}`];
  const refs = [...page.html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((ref) => ref && !ref.startsWith("//") && !/^(https?:|data:|mailto:|javascript:|#)/i.test(ref) && !ref.startsWith("/api/"));
  const broken = [];
  for (const ref of [...new Set(refs)].slice(0, 25)) {
    const target = new URL(ref, baseUrl).toString();
    const pathname = new URL(target).pathname;
    const looksLikeAsset = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|json)$/i.test(pathname);
    const res = await fetchPage(target);
    if (!res.ok) broken.push(`${ref} → ${res.status || res.error}`);
    else if (looksLikeAsset && /text\/html/i.test(res.type)) broken.push(`${ref} → 返回了 HTML 回退页`);
  }
  return broken;
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

function deployPathFor(task, value) {
  const prefix = `/preview/${task.id}`;
  const p = String(value || "/");
  return p.startsWith(prefix) ? p.slice(prefix.length) || "/" : p;
}

async function runBrowserSpec(url, spec) {
  const specPath = path.join(ROOT, "runtime", `deploy-spec-${Date.now()}.json`);
  const shot = path.join(ROOT, "runtime", `deploy-check-${Date.now()}.png`);
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const raw = await new Promise((resolve) => {
    execFile(NODE_BIN, [BROWSER_BIN, url, shot, "2500", specPath], { timeout: 120000, cwd: path.dirname(BROWSER_BIN), maxBuffer: 2 * 1024 * 1024 }, (_error, stdout) => resolve(String(stdout || "")));
  });
  fs.rmSync(specPath, { force: true });
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, error: raw.slice(0, 200) || "浏览器检查失败" };
  }
}

async function replayVerification(task, kind, baseUrl, serverPort) {
  const checks = task.checks || {};
  const failures = [];
  let ran = 0;

  if (kind === "server") {
    for (const item of (checks.http || []).slice(0, 8)) {
      const p = deployPathFor(task, item.path);
      const method = item.method || "GET";
      const target = `http://127.0.0.1:${serverPort}${p}`;
      try {
        const init = { method, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000) };
        if (item.body && method !== "GET") init.body = item.body;
        const res = await fetch(target, init);
        const text = await res.text();
        ran += 1;
        if (!res.ok) failures.push(`${method} ${p} → ${res.status}`);
        else if (item.expectStatus && res.status !== Number(item.expectStatus)) failures.push(`${method} ${p} 状态应为 ${item.expectStatus}，实际 ${res.status}`);
        else if (item.expect && !text.includes(item.expect)) failures.push(`${method} ${p} 响应里没有「${item.expect}」`);
      } catch (error) {
        failures.push(`${method} ${p} → ${String(error.message || error).slice(0, 80)}`);
      }
    }
  }

  const spec = checks.browser;
  if (spec?.actions?.length && spec?.expect?.length) {
    const data = await runBrowserSpec(baseUrl, spec);
    ran += 1;
    if (!data.ok) failures.push(`发布后交互失败：${(data.failures || []).join("；") || data.error || "未知原因"}`);
  }

  return { ran, failures };
}

async function startServerContainer(task, slug, releaseDir, port) {
  const container = `deploy-${slug}`;
  await docker(["rm", "-f", container], { timeout: 30000 });
  const run = await docker([
    "run",
    "-d",
    "--name",
    container,
    "--restart",
    "unless-stopped",
    "-v",
    `${releaseDir}:/workspace`,
    "-w",
    "/workspace",
    "-e",
    "PORT=5173",
    "-e",
    "NODE_ENV=production",
    "-p",
    `127.0.0.1:${port}:5173`,
    "--memory",
    DEPLOY_MEMORY,
    "--cpus",
    DEPLOY_CPUS,
    IMAGE,
    "sh",
    "-lc",
    "npm run start",
  ]);
  if (run.code !== 0) return { ok: false, error: run.err || "部署容器启动失败" };

  const healthy = await waitHealthy(port, 60000);
  if (!healthy) {
    const logs = await docker(["logs", "--tail", "30", container], { timeout: 15000 });
    return { ok: false, error: "部署容器 60 秒内未通过健康检查（检查 start 是否监听 process.env.PORT）", logs: (logs.out + logs.err).slice(-1200) };
  }
  return { ok: true, container };
}

async function deploy(task, send) {
  const code = taskCode(task);
  const versionsDir = path.join(taskRoot(task), "versions");
  const releasesRoot = path.join(taskRoot(task), "releases");
  fs.mkdirSync(versionsDir, { recursive: true });
  fs.mkdirSync(releasesRoot, { recursive: true });

  const existing = fs.readdirSync(versionsDir).filter((f) => /^v\d+\.tar\.gz$/.test(f));
  const version = existing.length + 1;
  const slug = task.id.slice(0, 8);
  const snapshot = path.join(versionsDir, `v${version}.tar.gz`);
  const releaseDir = path.join(releasesRoot, `v${version}`);
  const buildDir = path.join(releasesRoot, `.build-v${version}`);

  send({ type: "log", text: `快照源码 → v${version}` });
  const tarCode = await new Promise((resolve) => {
    const child = spawn("tar", ["-czf", snapshot, "--exclude=node_modules", "--exclude=dist", "--exclude=.git", "-C", code, "."]);
    child.on("close", (c) => resolve(c ?? 0));
  });
  if (tarCode !== 0) {
    send({ type: "error", message: "快照失败" });
    return;
  }

  let pkg = null;
  if (fs.existsSync(path.join(code, "package.json"))) {
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(code, "package.json"), "utf8"));
    } catch {
      pkg = null;
    }
  }
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const ssrFramework = ["next", "nuxt", "@nestjs/core", "hapi", "@hapi/hapi"].some((name) => Boolean(deps[name]));
  const hasVite = Boolean(deps.vite) && !ssrFramework;
  const hasBuild = Boolean(pkg?.scripts?.build);
  const hasStart = Boolean(pkg?.scripts?.start);
  const serverFrameworks = ["next", "nuxt", "express", "fastify", "koa", "@nestjs/core", "hapi", "@hapi/hapi"];
  const isServer = hasStart || serverFrameworks.some((name) => Boolean(deps[name]));

  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  if ((await runCmd("tar", ["-xzf", snapshot, "-C", buildDir])) !== 0) {
    send({ type: "error", message: "解压快照失败" });
    return;
  }
  await runCmd("chown", ["-R", `${UID}:${UID}`, buildDir]);

  const runBuilder = async (dir, command) => {
    send({ type: "log", text: `构建: ${command}` });
    const args = [
      "run",
      "--rm",
      "-v",
      `${dir}:/workspace`,
      "-w",
      "/workspace",
      "-u",
      "agent",
      IMAGE,
      "sh",
      "-lc",
      `if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi && ${command}`,
    ];
    return runStream("docker", args, (line) => send({ type: "log", text: line }));
  };

  const published = readJson(PUBLISH_FILE, { apps: {} });
  published.apps = published.apps || {};

  if (isServer) {
    fs.rmSync(releaseDir, { recursive: true, force: true });
    fs.renameSync(buildDir, releaseDir);

    if (hasBuild) {
      const buildCmd = hasVite ? "npx vite build --base=/" : "npm run build";
      const exit = await runBuilder(releaseDir, buildCmd);
      if (exit !== 0) {
        send({ type: "error", message: `构建失败（exit ${exit}）` });
        return;
      }
    }

    const existingApp = published.apps[slug];
    const port = existingApp?.kind === "server" && existingApp.port ? existingApp.port : await allocateDeployPort(published);
    send({ type: "log", text: `启动部署环境（端口 ${port}）` });
    const started = await startServerContainer(task, slug, releaseDir, port);
    if (!started.ok) {
      if (started.logs) send({ type: "log", text: started.logs });
      send({ type: "error", message: started.error });
      return;
    }

    const broken = await findBrokenAssets(`http://127.0.0.1:${port}/`);
    if (broken.length) {
      await docker(["rm", "-f", `deploy-${slug}`], { timeout: 30000 });
      send({ type: "error", message: `发布后资源检查失败：${broken.slice(0, 5).join("；")}` });
      return;
    }

    const replay = await replayVerification(task, "server", `http://127.0.0.1:${port}/`, port);
    if (replay.failures.length) {
      await docker(["rm", "-f", `deploy-${slug}`], { timeout: 30000 });
      send({ type: "error", message: `发布后验收失败：${replay.failures.slice(0, 4).join("；")}` });
      return;
    }
    if (replay.ran) send({ type: "log", text: `发布后回放验收 ${replay.ran} 项通过` });

    const url = appUrl(slug);
    published.apps[slug] = {
      slug,
      taskId: task.id,
      version,
      kind: "server",
      port,
      container: `deploy-${slug}`,
      dir: releaseDir,
      url,
      at: new Date().toISOString(),
    };
    writeJson(PUBLISH_FILE, published);

    const state = loadTasks();
    if (state.tasks[task.id]) {
      state.tasks[task.id].published = { slug, version, url, at: new Date().toISOString(), port, kind: "server" };
      saveTasks(state);
    }
    send({ type: "log", text: `已发布（容器）: ${url}` });
    send({ type: "done", slug, version, url, kind: "server" });
    return;
  }

  /* ---------- 静态 / SPA ---------- */
  const doBuild = hasBuild || hasVite;
  const distBase = buildDir;
  if (doBuild) {
    send({ type: "log", text: hasVite ? "构建静态产物（Vite）" : "构建静态产物（build 脚本）" });
    const buildCmd = hasVite ? `npx vite build --base=/apps/${slug}/` : "npm run build";
    const exit = await runBuilder(buildDir, buildCmd);
    if (exit !== 0) {
      send({ type: "error", message: `构建失败（exit ${exit}）` });
      return;
    }
  }

  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  if (doBuild) {
    const dist = ["dist", "build", "out"].map((d) => path.join(distBase, d)).find((d) => fs.existsSync(d));
    if (!dist) {
      send({ type: "error", message: "构建完成但没有找到 dist/build/out" });
      return;
    }
    fs.cpSync(dist, releaseDir, { recursive: true });
  } else {
    send({ type: "log", text: "无构建脚本，按静态产物处理" });
    for (const entry of fs.readdirSync(distBase, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", ".cache"].includes(entry.name)) continue;
      fs.cpSync(path.join(distBase, entry.name), path.join(releaseDir, entry.name), { recursive: true });
    }
  }
  fs.rmSync(buildDir, { recursive: true, force: true });

  const url = `/apps/${slug}/`;
  published.apps[slug] = {
    slug,
    taskId: task.id,
    version,
    dir: releaseDir,
    kind: doBuild ? "spa" : "static",
    url,
    at: new Date().toISOString(),
  };
  writeJson(PUBLISH_FILE, published);

  const baseUrl = `http://127.0.0.1:${PROXY_PORT}${url}`;
  const broken = await findBrokenAssets(baseUrl);
  const replay = broken.length ? { ran: 0, failures: [] } : await replayVerification(task, "static", baseUrl, 0);
  if (broken.length || replay.failures.length) {
    delete published.apps[slug];
    writeJson(PUBLISH_FILE, published);
    const reasons = [...broken, ...replay.failures].slice(0, 4).join("；");
    send({ type: "error", message: `发布后验收失败：${reasons}` });
    return;
  }
  if (replay.ran) send({ type: "log", text: `发布后回放验收 ${replay.ran} 项通过` });

  const state = loadTasks();
  if (state.tasks[task.id]) {
    state.tasks[task.id].published = { slug, version, url, at: new Date().toISOString(), kind: doBuild ? "spa" : "static" };
    saveTasks(state);
  }
  send({ type: "log", text: `已发布：${url}` });
  send({ type: "done", slug, version, url, kind: doBuild ? "spa" : "static" });
}

/* ---------------- http ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function serveUi(req, res, url) {
  let rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  try {
    rel = decodeURIComponent(rel);
    const full = ensureInside(UI_DIR, rel);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(fs.readFileSync(full));
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  const user = currentUser(req);

  if (url.pathname === "/api/health") return json(res, 200, { ok: true, model: LLM.model, auth: AUTH_ENABLED, tasks: Object.keys(loadTasks().tasks).length, user, proxyBase: process.env.PUBLIC_PROXY_BASE || "" });

  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    if (!AUTH_ENABLED) return json(res, 200, { ok: true, user: "admin" });
    const name = String(body.username || "").trim();
    if (!verifyUser(name, body.password)) return json(res, 401, { error: "用户名或密码不正确" });
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": `${COOKIE}=${makeToken(name)}; Path=/; HttpOnly; Max-Age=604800; SameSite=Lax`,
    });
    return res.end(JSON.stringify({ ok: true, user: name }));
  }

  if (url.pathname === "/api/logout" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": `${COOKIE}=; Path=/; Max-Age=0` });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (url.pathname.startsWith("/api/") && !user) return json(res, 401, { error: "未登录" });

  if (url.pathname === "/api/tasks" && req.method === "GET") {
    const tasks = Object.values(loadTasks().tasks)
      .filter((t) => (t.uid || "admin") === user)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json(res, 200, tasks);
  }

  if (url.pathname === "/api/tasks" && req.method === "POST") {
    const body = await readBody(req);
    const state = loadTasks();
    const running = Object.values(state.tasks).filter((t) => t.status === "running").length;
    if (running >= MAX_TASKS) return json(res, 429, { error: `任务数已达上限（${MAX_TASKS}），请先删除旧任务` });
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const port = await allocatePort(state);
    const uid = user;
    const dir = taskCode({ uid, id });
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.chownSync(path.join(ROOT, "data", uid, id), Number(UID), Number(UID));
      fs.chownSync(dir, Number(UID), Number(UID));
    } catch {
      /* ignore */
    }
    const container = `atoms-${id}`;
    const run = await docker(["run", "-d", "--name", container, "-v", `${dir}:/workspace`, "-p", `127.0.0.1:${port}:${CONTAINER_PORT}`, "--memory", SANDBOX_MEMORY, "--memory-swap", SANDBOX_MEMORY, "--cpus", SANDBOX_CPUS, "--pids-limit", SANDBOX_PIDS, IMAGE]);
    if (run.code !== 0) return json(res, 500, { error: run.err || "容器启动失败" });
    const task = {
      id,
      uid,
      name: String(body.name || "未命名任务").slice(0, 60),
      prompt: String(body.prompt || "").slice(0, 2000),
      container,
      port,
      status: "running",
      createdAt: new Date().toISOString(),
      preview: `/preview/${id}/`,
      messages: [],
      events: [],
      lastActiveAt: new Date().toISOString(),
    };
    state.tasks[id] = task;
    saveTasks(state);
    return json(res, 201, task);
  }

  if (parts[0] === "api" && parts[1] === "tasks" && parts[2]) {
    const id = parts[2];
    const state = loadTasks();
    const task = state.tasks[id];
    if (!task || (task.uid || "admin") !== user) return json(res, 404, { error: "任务不存在" });

    if (parts.length === 3 && req.method === "GET") return json(res, 200, { ...task, stack: detectStack(task) });

    if (parts.length === 3 && req.method === "PATCH") {
      const body = await readBody(req);
      if (typeof body.name === "string" && body.name.trim()) {
        task.name = body.name.trim().slice(0, 60);
        state.tasks[id] = task;
        saveTasks(state);
      }
      return json(res, 200, task);
    }

    if (parts.length === 3 && req.method === "DELETE") {
      if (!lockTask(id)) return json(res, 409, { error: "任务正在运行，稍后再试" });
      try {
        await docker(["rm", "-f", task.container], { timeout: 30000 });
        const deployedSlug = task.id.slice(0, 8);
        await docker(["rm", "-f", `deploy-${deployedSlug}`], { timeout: 30000 });
        delete state.tasks[id];
        saveTasks(state);

        const published = readJson(PUBLISH_FILE, { apps: {} });
        let changed = false;
        for (const [slug, app] of Object.entries(published.apps || {})) {
          if (app.taskId === id) {
            delete published.apps[slug];
            changed = true;
          }
        }
        if (changed) writeJson(PUBLISH_FILE, published);
      } finally {
        unlockTask(id);
      }
      return json(res, 200, { ok: true });
    }

    if (parts[3] === "versions" && req.method === "GET") {
      const releasesRoot = path.join(taskRoot(task), "releases");
      let versions = [];
      try {
        versions = fs
          .readdirSync(releasesRoot)
          .filter((name) => /^v\d+$/.test(name))
          .map((name) => {
            const v = Number(name.slice(1));
            return { version: v, current: task.published?.version === v, at: fs.statSync(path.join(releasesRoot, name)).mtime.toISOString() };
          })
          .sort((a, b) => b.version - a.version);
      } catch {
        versions = [];
      }
      return json(res, 200, { versions, published: task.published || null });
    }

    if (parts[3] === "rollback" && req.method === "POST") {
      const body = await readBody(req);
      const version = Number(body.version);
      if (!Number.isInteger(version) || version < 1) return json(res, 400, { error: "版本号不对" });
      const releasesRoot = path.join(taskRoot(task), "releases");
      const releaseDir = path.join(releasesRoot, `v${version}`);
      if (!fs.existsSync(releaseDir)) return json(res, 404, { error: `v${version} 没有可用的发布产物` });
      if (!lockTask(id)) return json(res, 409, { error: "这个任务正在运行，稍后再试" });
      try {
        const published = readJson(PUBLISH_FILE, { apps: {} });
        const slug = task.id.slice(0, 8);
        const app = published.apps?.[slug];
        if (!app) return json(res, 400, { error: "这个任务还没有发布过" });
        const previous = { dir: app.dir, version: app.version };

        if (app.kind === "server") {
          const started = await startServerContainer(task, slug, releaseDir, app.port);
          if (!started.ok) {
            if (previous.dir) await startServerContainer(task, slug, previous.dir, app.port);
            return json(res, 500, { error: started.error });
          }
          const broken = await findBrokenAssets(`http://127.0.0.1:${app.port}/`);
          const replay = broken.length ? { failures: broken } : await replayVerification(task, "server", `http://127.0.0.1:${app.port}/`, app.port);
          if (replay.failures.length) {
            if (previous.dir) await startServerContainer(task, slug, previous.dir, app.port);
            return json(res, 500, { error: `v${version} 验收失败：${replay.failures.slice(0, 3).join("；")}` });
          }
        }

        app.version = version;
        app.dir = releaseDir;
        app.at = new Date().toISOString();
        writeJson(PUBLISH_FILE, published);

        const state = loadTasks();
        if (state.tasks[id]) {
          state.tasks[id].published = { ...(state.tasks[id].published || {}), version, at: app.at };
          saveTasks(state);
        }
        return json(res, 200, { ok: true, version, url: app.url });
      } finally {
        unlockTask(id);
      }
    }

    if (parts[3] === "files" && req.method === "GET") {
      const rel = url.searchParams.get("path");
      if (!rel) return json(res, 200, { files: listFiles(task) });
      try {
        return json(res, 200, { path: rel, content: readFile(task, rel) });
      } catch {
        return json(res, 404, { error: "读取失败" });
      }
    }

    if (parts[3] === "files" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.path) return json(res, 400, { error: "缺少 path" });
      writeFile(task, body.path, body.content ?? "");
      return json(res, 200, { ok: true });
    }

    if (parts[3] === "exec" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, await runTool(task, "run", body));
    }

    if (parts[3] === "chat" && req.method === "POST") {
      const body = await readBody(req);
      const message = String(body.message || "").trim();
      if (!message) return json(res, 400, { error: "消息为空" });
      if (!lockTask(id)) return json(res, 409, { error: "这个任务正在运行，等它结束再发" });

      const fresh = loadTasks();
      fresh.tasks[id].messages.push({ role: "user", content: message, at: new Date().toISOString() });
      fresh.tasks[id].lastActiveAt = new Date().toISOString();
      fresh.tasks[id].run = "running";
      saveTasks(fresh);

      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      try {
        const result = await runAgent(task, message, send);
        const latest = loadTasks();
        latest.tasks[id].messages.push({ role: "assistant", content: result.summary, at: new Date().toISOString() });
        latest.tasks[id].events = [...(latest.tasks[id].events || []), ...result.events].slice(-80);
        if (result.checks) latest.tasks[id].checks = result.checks;
        latest.tasks[id].run = null;
        latest.tasks[id].verify = {
          ok: Boolean(result.verified),
          reason: result.verified ? "" : String(result.summary || "").slice(0, 300),
          at: new Date().toISOString(),
        };
        saveTasks(latest);
      } catch (error) {
        send({ type: "error", message: String(error.message || error) });
        const latest = loadTasks();
        if (latest.tasks[id]) {
          latest.tasks[id].run = null;
          latest.tasks[id].verify = { ok: false, reason: String(error.message || error).slice(0, 300), at: new Date().toISOString() };
          saveTasks(latest);
        }
      } finally {
        res.end();
        unlockTask(id);
      }
      return;
    }

    if (parts[3] === "deploy" && req.method === "POST") {
      if (!lockTask(id)) return json(res, 409, { error: "这个任务正在运行，等它结束再部署" });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
      let outcome = { ok: false, message: "部署没有返回结果" };
      const send = (event) => {
        if (event.type === "done") outcome = { ok: true, version: event.version, url: event.url, kind: event.kind };
        if (event.type === "error") outcome = { ok: false, message: event.message };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      try {
        await deploy(task, send);
      } catch (error) {
        outcome = { ok: false, message: String(error.message || error) };
        send({ type: "error", message: outcome.message });
      } finally {
        const latest = loadTasks();
        if (latest.tasks[id]) {
          latest.tasks[id].deploy = { ...outcome, at: new Date().toISOString() };
          saveTasks(latest);
        }
        res.end();
        unlockTask(id);
      }
      return;
    }
  }

  if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });

  serveUi(req, res, url);
});

// 闲置回收：超时的运行中容器会被销毁，工作区保留
setInterval(async () => {
  const state = loadTasks();
  const cutoff = Date.now() - TTL_HOURS * 3600 * 1000;
  let changed = false;
  for (const task of Object.values(state.tasks)) {
    if (task.status !== "running") continue;
    const last = new Date(task.lastActiveAt || task.createdAt).getTime();
    if (last < cutoff) {
      await docker(["rm", "-f", task.container], { timeout: 30000 });
      task.status = "stopped";
      changed = true;
      console.log(`[cleanup] stopped ${task.id}`);
    }
  }
  if (changed) saveTasks(state);
}, 10 * 60 * 1000);

// 启动时清理孤儿发布记录（任务已被删除但发布条目还在）
(() => {
  const tasks = loadTasks().tasks;
  const published = readJson(PUBLISH_FILE, { apps: {} });
  let changed = false;
  for (const [slug, app] of Object.entries(published.apps || {})) {
    if (!tasks[app.taskId]) {
      delete published.apps[slug];
      changed = true;
    }
  }
  if (changed) writeJson(PUBLISH_FILE, published);
})();

(function recoverInterrupted() {
  const state = loadTasks();
  let changed = false;
  for (const task of Object.values(state.tasks)) {
    if (task.run === "running") {
      task.run = null;
      task.verify = { ok: false, reason: "服务重启，任务中断", at: new Date().toISOString() };
      changed = true;
    }
  }
  if (changed) saveTasks(state);
})();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[atoms-control] :${PORT} root=${ROOT} model=${LLM.model} auth=${Boolean(ADMIN_PASSWORD)}`);
});