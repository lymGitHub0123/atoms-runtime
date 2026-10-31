/**
 * 模型回归评测：固定需求逐条生成，记录是否通过验收、耗时、检查项数量。
 * 用法：node ops/regress.mjs http://127.0.0.1:13579 admin <password> [--limit 3] [--only 2048,todo] [--deploy] [--keep]
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const BASE = (args[0] || "http://127.0.0.1:13579").replace(/\/+$/, "");
const USER = args[1] || "admin";
const PASS = args[2] || process.env.ADMIN_PASSWORD || "";
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : "";
};
const limit = Number(value("limit") || 0);
const only = value("only").split(",").filter(Boolean);
const doDeploy = flag("deploy");
const keep = flag("keep");

const CASES = [
  {
    id: "2048",
    name: "2048",
    prompt: "用 React 做一个 2048：4x4 棋盘，方向键/WASD 移动，相同数字合并并加分，每次有效移动生成新方块，新游戏清零，达成 2048 有提示。",
  },
  {
    id: "snake",
    name: "贪吃蛇",
    prompt: "用 React 做一个贪吃蛇：方向键控制，吃食物变长加分，撞墙或撞自己结束，可以重新开始。",
  },
  {
    id: "calc",
    name: "计算器",
    prompt: "做一个计算器：支持加减乘除、小数点、清除、退格，键盘也能输入，除零要提示。",
  },
  {
    id: "timer",
    name: "番茄钟",
    prompt: "做一个番茄钟：默认 25 分钟，可以开始/暂停/重置，结束时提示，界面精致。",
  },
  {
    id: "todo",
    name: "待办（服务端持久化）",
    prompt: "做一个待办应用：Express + 服务端 JSON 落盘，支持新增、完成、删除，刷新和重启服务后数据还在；start 脚本为 node server.js。",
    deploy: true,
  },
  {
    id: "board",
    name: "留言板（Express）",
    prompt: "用 Express 做一个留言板：GET/POST /api/messages，数据存 data.json，页面能展示并提交，start 脚本为 node server.js。",
    deploy: true,
  },
  {
    id: "form",
    name: "注册表单校验",
    prompt: "做一个注册表单：邮箱格式、密码强度、两次密码一致，错误提示要具体，提交成功显示结果。",
  },
  {
    id: "dashboard",
    name: "数据仪表盘",
    prompt: "做一个数据仪表盘：用本地假数据画 3 个图（折线、柱状、环形），不要引第三方图表库，数字要有动画。",
  },
  {
    id: "markdown",
    name: "Markdown 预览",
    prompt: "做一个 Markdown 编辑器：左右分栏，左边输入右边实时渲染，支持标题、列表、代码块、表格。",
  },
  {
    id: "landing",
    name: "响应式落地页",
    prompt: "做一个产品落地页：首屏、三个特性、价格、页脚；400px 宽也不能横向溢出，按钮能点击并滚动到对应区域。",
  },
];

let cookie = "";

async function call(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

async function sse(path, body, timeoutMs) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = null;
  let steps = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const line = block.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === "step" && event.result) steps += 1;
      if (event.type === "done") done = event;
      if (event.type === "error") throw new Error(event.message);
    }
  }
  if (!done) throw new Error("没有返回结果");
  return { done, steps };
}

async function runCase(item) {
  const started = Date.now();
  const created = await call("/api/tasks", { method: "POST", body: JSON.stringify({ name: `回归-${item.name}`, prompt: item.prompt }) });
  if (created.status !== 201) throw new Error(`创建任务失败 ${created.status}`);
  const id = created.data.id;
  const result = { id: item.id, name: item.name, taskId: id, ok: false, seconds: 0, steps: 0, checks: 0, deploy: null, error: "" };
  try {
    const chat = await sse(`/api/tasks/${id}/chat`, { message: item.prompt }, 720000);
    result.steps = chat.steps;
    const detail = await call(`/api/tasks/${id}`);
    result.ok = Boolean(detail.data?.verify?.ok);
    result.checks = detail.data?.checks?.plan?.length || 0;
    result.error = result.ok ? "" : String(detail.data?.verify?.reason || "").slice(0, 160);

    if (doDeploy && item.deploy) {
      try {
        const dep = await sse(`/api/tasks/${id}/deploy`, {}, 300000);
        const after = await call(`/api/tasks/${id}`);
        result.deploy = { ok: Boolean(after.data?.deploy?.ok), version: dep.done.version, message: after.data?.deploy?.message || "" };
      } catch (error) {
        result.deploy = { ok: false, message: String(error.message || error).slice(0, 160) };
      }
    }
  } catch (error) {
    result.error = String(error.message || error).slice(0, 160);
  } finally {
    result.seconds = Math.round((Date.now() - started) / 1000);
    const full = await call(`/api/tasks/${id}`).catch(() => null);
    if (full?.data) {
      const dump = {
        id: item.id,
        name: item.name,
        taskId: id,
        verify: full.data.verify || null,
        checks: full.data.checks || null,
        messages: (full.data.messages || []).slice(-6),
        events: (full.data.events || []).slice(-40),
      };
      fs.writeFileSync(`regress-${item.id}-${id}.json`, JSON.stringify(dump, null, 2));
    }
    if (!keep) await call(`/api/tasks/${id}`, { method: "DELETE" }).catch(() => {});
  }
  return result;
}

async function main() {
  if (!PASS) throw new Error("需要密码：node ops/regress.mjs <base> <user> <password>");
  const login = await call("/api/login", { method: "POST", body: JSON.stringify({ username: USER, password: PASS }) });
  if (login.status !== 200) throw new Error(`登录失败 ${login.status}`);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error("登录没有拿到 Cookie");

  let cases = CASES;
  if (only.length) cases = cases.filter((item) => only.includes(item.id));
  if (limit > 0) cases = cases.slice(0, limit);

  const results = [];
  for (const item of cases) {
    process.stdout.write(`\n▶ ${item.name} ... `);
    const result = await runCase(item);
    results.push(result);
    const deployText = result.deploy ? (result.deploy.ok ? " 部署通过" : ` 部署失败(${result.deploy.message})`) : "";
    console.log(`${result.ok ? "通过" : "未通过"}${deployText} · ${result.seconds}s · 检查 ${result.checks} 项${result.error ? ` · ${result.error}` : ""}`);
  }

  const passed = results.filter((item) => item.ok && (!item.deploy || item.deploy.ok)).length;
  console.log(`\n${passed}/${results.length} 通过`);
  const out = { at: new Date().toISOString(), base: BASE, passed, total: results.length, results };
  const file = `regress-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`结果写入 ${file}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(String(error.message || error));
  process.exit(1);
});