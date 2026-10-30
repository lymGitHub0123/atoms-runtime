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
  const full = path.resolve(root, target || ".");
  if (!full.startsWith(path.resolve(root))) throw new Error("路径越界");
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
      description: "在沙箱执行命令；background=true 后台运行（启动 dev server 用）",
      parameters: { type: "object", properties: { cmd: { type: "string" }, background: { type: "boolean" }, timeout: { type: "number" } }, required: ["cmd"] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_http",
      description: "从宿主机访问应用，返回状态与页面片段",
      parameters: { type: "object", properties: { path: { type: "string" }, expect: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_check",
      description: "用无头浏览器打开预览页，返回标题、可见文本、控制台报错并自动截图",
      parameters: { type: "object", properties: {} },
    },
  },
  { type: "function", function: { name: "finish", description: "任务完成", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
];

const SYSTEM_PROMPT = `你是 Atoms Runtime 里的工程 Agent，在隔离 Linux 沙箱中工作，工作目录 /workspace，容器用户 agent。

工具：list_files / write_file / read_file / run / check_http / browser_check / finish。

规则：
1. 先看现状再动手，小步修改。
2. 纯 HTML：写完后 run 后台启动：node /opt/static-server.mjs /workspace 5173 /preview/{taskId}/（background=true，末尾参数必须换成你的任务 ID）。
3. React/Vite：写 package.json、vite.config.js、index.html、src/main.jsx、src/App.jsx；先 run "npm install --no-audit --no-fund"，再后台 run "npx vite --host 0.0.0.0 --port 5173"。
4. 每次改完必须 check_http 验证；check_http 通过后再跑一次 browser_check，确认控制台无报错、页面有可见内容；有报错就继续修。
5. 最多 10 步；通过后调用 finish，说明功能与访问方式。
6. 中文界面，视觉精致；浏览器端不要用 localStorage。
6.1 如果需求必须服务端能力（登录会话、实时通信、文件上传、共享数据、密钥代理、定时任务），做一个真正的服务端应用：
   · Express 方案：npm install express，写 server.js，public/ 放静态资源，start 脚本 "node server.js"，必须监听 process.env.PORT || 3000；
   · Next.js 方案：npm install next react react-dom，使用 app/ 路由，start 脚本 "next start"。
   · 服务端应用同样要保证依赖装好、start 能直接跑起来，然后 check_http 验证。
   · 预览时用 run 后台启动：PORT=5173 <你的启动命令>（例如 PORT=5173 node server.js，或 PORT=5173 npx next dev -p 5173），再 check_http。
7. 沙箱里没有 curl / git / wget，不要用它们；验证一律用 check_http；需要看进程用 run "ps aux | head"。
8. 用 Vite：package.json 必须同时包含 dev 和 build 脚本；启动 dev server 的命令固定为
   npx vite --host 0.0.0.0 --port 5173 --base=/preview/{taskId}/
   （{taskId} 换成用户消息里给你的任务 ID；不带 base 会导致资源 404）。
9. 纯 HTML 应用用相对路径引用资源（./style.css），不要用 /style.css。
10. 文件 path 用相对路径（如 index.html、src/App.jsx），不要写 /workspace/ 前缀。`;

async function callModel(messages) {
  const res = await fetch(`${LLM.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LLM.key}` },
    body: JSON.stringify({
      model: LLM.model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.4,
      ...LLM.extra,
    }),
  });
  if (!res.ok) throw new Error(`模型调用失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function runTool(task, name, args) {
  switch (name) {
    case "list_files":
      return { ok: true, output: listFiles(task).join("\n") || "(空目录)" };
    case "write_file": {
      const rel = writeFile(task, args.path, args.content ?? "");
      return { ok: true, output: `已写入 ${rel}` };
    }
    case "read_file":
      return { ok: true, output: readFile(task, args.path).slice(0, 12000) };
    case "run": {
      const base = ["exec", "-u", "agent", "-w", "/workspace", task.container];
      if (args.background) {
        const res = await docker(["exec", "-d", "-u", "agent", "-w", "/workspace", task.container, "sh", "-lc", args.cmd], { timeout: 20000 });
        return { ok: res.code === 0, output: res.code === 0 ? "已后台启动" : (res.err || res.out || "启动失败") };
      }
      const timeout = Math.min(Math.max(Number(args.timeout) || 60, 5), 180) * 1000;
      const res = await docker([...base, "sh", "-lc", args.cmd], { timeout });
      return { ok: res.code === 0, exit: res.code, output: `${res.out}${res.err ? `\n[stderr]\n${res.err}` : ""}`.slice(-8000) };
    }
    case "browser_check": {
      const url = `http://127.0.0.1:${task.port}/preview/${task.id}/`;
      const shotDir = path.join(taskRoot(task), "shots");
      fs.mkdirSync(shotDir, { recursive: true });
      const shot = path.join(shotDir, `check-${Date.now()}.png`);
      const raw = await new Promise((resolve) => {
        execFile(
          "/data/atoms-demo-v2/tools/node/bin/node",
          ["/data/atoms-demo-v2/tools/pw/browser-check.mjs", url, shot],
          { timeout: 90000, cwd: "/data/atoms-demo-v2/tools/pw", maxBuffer: 2 * 1024 * 1024 },
          (_error, stdout) => resolve(String(stdout || "")),
        );
      });
      try {
        const data = JSON.parse(raw);
        return {
          ok: Boolean(data.ok),
          status: data.status,
          title: data.title,
          buttons: data.buttons,
          errors: data.errors || [],
          screenshot: data.screenshot,
          output: `标题=${data.title || "-"}；可见文本=${String(data.text || "").slice(0, 80)}；控制台错误=${(data.errors || []).length}`,
        };
      } catch {
        return { ok: false, error: "浏览器检查失败", output: raw.slice(0, 300) };
      }
    }
    case "check_http": {
      const target = `http://127.0.0.1:${task.port}${args.path || "/"}`;
      const started = Date.now();
      try {
        const res = await fetch(target, { signal: AbortSignal.timeout(8000) });
        const text = await res.text();
        const expectMatched = args.expect ? text.includes(args.expect) : true;
        return { ok: res.ok && expectMatched, status: res.status, ms: Date.now() - started, expectMatched, snippet: text.slice(0, 600) };
      } catch (error) {
        return { ok: false, error: String(error.message || error) };
      }
    }
    default:
      return { ok: false, error: "未知工具" };
  }
}

async function runAgent(task, prompt, send) {
  const events = [];
  const record = (event) => {
    if (event.type === "step" && event.result) {
      const text =
        event.result.output ||
        event.result.error ||
        event.result.snippet ||
        (event.result.status ? `HTTP ${event.result.status}` : "") ||
        event.args?.summary ||
        (event.tool === "finish" ? "完成" : JSON.stringify(event.result).slice(0, 200));
      events.push({ tool: event.tool, ok: Boolean(event.result.ok), text: String(text).slice(0, 240) });
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

  for (let step = 1; step <= 20; step += 1) {
    const payload = await callModel(messages);
    const message = payload.choices?.[0]?.message ?? {};
    const calls = message.tool_calls ?? [];
    if (message.content) emit({ type: "message", step, text: message.content });
    if (calls.length === 0) {
      emit({ type: "done", step, summary: message.content || "完成" });
      return { summary: message.content || "完成", events };
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
        emit({ type: "step", step, tool: "finish", args, result: { ok: true } });
        emit({ type: "done", step, summary: args.summary || "完成" });
        return { summary: args.summary || "完成", events };
      }
      emit({ type: "step", step, tool: name, args });
      const result = await runTool(task, name, args);
      emit({ type: "step", step, tool: name, args, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ tool: name, ...result }).slice(0, 12000) });
    }
  }
  send({ type: "done", step: 20, summary: "达到最大步数" });
  return { summary: "达到最大步数", events };
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

async function deploy(task, send) {
  const code = taskCode(task);
  const versionsDir = path.join(taskRoot(task), "versions");
  const releasesRoot = path.join(taskRoot(task), "releases");
  fs.mkdirSync(versionsDir, { recursive: true });
  fs.mkdirSync(releasesRoot, { recursive: true });

  const existing = fs.readdirSync(versionsDir).filter((f) => /^v\d+\.tar\.gz$/.test(f));
  const version = existing.length + 1;
  const slug = task.id.slice(0, 8);

  send({ type: "log", text: `快照源码 → versions/v${version}.tar.gz` });
  const tarCode = await new Promise((resolve) => {
    const child = spawn("tar", [
      "-czf",
      path.join(versionsDir, `v${version}.tar.gz`),
      "--exclude=node_modules",
      "--exclude=dist",
      "--exclude=.git",
      "-C",
      code,
      ".",
    ]);
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
  const hasVite = Boolean(deps.vite);
  const hasBuild = Boolean(pkg?.scripts?.build);
  const hasStart = Boolean(pkg?.scripts?.start);
  const serverFrameworks = ["next", "nuxt", "express", "fastify", "koa", "@nestjs/core", "hapi", "@hapi/hapi"];
  const isServer = hasStart || serverFrameworks.some((name) => Boolean(deps[name]));

  const runBuilder = async (command) => {
    send({ type: "log", text: `builder: ${command}` });
    const args = [
      "run",
      "--rm",
      "-v",
      `${code}:/workspace`,
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
    if (hasBuild) {
      const exit = await runBuilder("npm run build");
      if (exit !== 0) {
        send({ type: "error", message: `构建失败（exit ${exit}）` });
        return;
      }
    }

    const port = await allocateDeployPort(published);
    const container = `deploy-${slug}`;
    await docker(["rm", "-f", container], { timeout: 30000 });

    send({ type: "log", text: `启动部署容器 ${container} · 端口 ${port}` });
    const run = await docker([
      "run",
      "-d",
      "--name",
      container,
      "--restart",
      "unless-stopped",
      "-v",
      `${code}:/workspace`,
      "-w",
      "/workspace",
      "-e",
      "PORT=5173",
      "-e",
      "NODE_ENV=production",
      "-p",
      `127.0.0.1:${port}:5173`,
      IMAGE,
      "sh",
      "-lc",
      "npm run start",
    ]);
    if (run.code !== 0) {
      send({ type: "error", message: run.err || "部署容器启动失败" });
      return;
    }

    const healthy = await waitHealthy(port, 60000);
    if (!healthy) {
      const logs = await docker(["logs", "--tail", "30", container], { timeout: 15000 });
      send({ type: "log", text: (logs.out + logs.err).slice(-1500) });
      send({ type: "error", message: "部署容器 60 秒内未通过健康检查（检查 start 脚本是否监听 process.env.PORT）" });
      return;
    }

    const url = appUrl(slug);
    published.apps[slug] = {
      slug,
      taskId: task.id,
      version,
      kind: "server",
      port,
      container,
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
    send({ type: "done", slug, version, url, kind: "server", port });
    return;
  }

  /* ---------- 静态 / SPA ---------- */
  const doBuild = hasBuild || hasVite;
  const releaseDir = path.join(releasesRoot, `v${version}`);
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(releaseDir, { recursive: true });

  if (doBuild) {
    send({ type: "log", text: hasVite ? "检测到 Vite 项目，执行 npx vite build" : "检测到构建脚本，启动 builder 容器" });
    const buildCmd = hasVite ? `npx vite build --base=/apps/${slug}/` : "npm run build";
    const exit = await runBuilder(buildCmd);
    if (exit !== 0) {
      send({ type: "error", message: `构建失败（exit ${exit}）` });
      return;
    }
    const dist = ["dist", "build", "out"].map((d) => path.join(code, d)).find((d) => fs.existsSync(d));
    if (!dist) {
      send({ type: "error", message: "构建完成但没有找到 dist/build/out" });
      return;
    }
    fs.cpSync(dist, releaseDir, { recursive: true });
  } else {
    send({ type: "log", text: "无构建脚本，按静态产物处理" });
    for (const entry of fs.readdirSync(code, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", ".cache"].includes(entry.name)) continue;
      fs.cpSync(path.join(code, entry.name), path.join(releaseDir, entry.name), { recursive: true });
    }
  }

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
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const full = path.join(UI_DIR, rel);
  if (!full.startsWith(UI_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
  res.end(fs.readFileSync(full));
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
    const run = await docker(["run", "-d", "--name", container, "-v", `${dir}:/workspace`, "-p", `127.0.0.1:${port}:${CONTAINER_PORT}`, IMAGE]);
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

      return json(res, 200, { ok: true });
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

      const fresh = loadTasks();
      fresh.tasks[id].messages.push({ role: "user", content: message, at: new Date().toISOString() });
      fresh.tasks[id].lastActiveAt = new Date().toISOString();
      saveTasks(fresh);

      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      try {
        const result = await runAgent(task, message, send);
        const latest = loadTasks();
        latest.tasks[id].messages.push({ role: "assistant", content: result.summary, at: new Date().toISOString() });
        latest.tasks[id].events = [...(latest.tasks[id].events || []), ...result.events].slice(-80);
        saveTasks(latest);
      } catch (error) {
        send({ type: "error", message: String(error.message || error) });
      } finally {
        res.end();
      }
      return;
    }

    if (parts[3] === "deploy" && req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      try {
        await deploy(task, send);
      } catch (error) {
        send({ type: "error", message: String(error.message || error) });
      } finally {
        res.end();
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[atoms-control] :${PORT} root=${ROOT} model=${LLM.model} auth=${Boolean(ADMIN_PASSWORD)}`);
});