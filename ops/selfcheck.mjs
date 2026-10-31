/**
 * 交付自检：不需要模型，跑一遍鉴权、隔离、发布、回滚、清理。
 * 用法：node ops/selfcheck.mjs [http://127.0.0.1:13579] [用户名] [密码]
 */
const BASE = (process.argv[2] || "http://127.0.0.1:13579").replace(/\/+$/, "");
const USER = process.argv[3] || process.env.ADMIN_USER || "admin";
const PASS = process.argv[4] || process.env.ADMIN_PASSWORD || "";

let cookie = "";
const results = [];
const taskIds = [];
let taskId = "";

function ok(name, detail = "") {
  results.push({ name, pass: true, detail });
  console.log(`PASS  ${name}${detail ? ` · ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.push({ name, pass: false, detail });
  console.log(`FAIL  ${name}${detail ? ` · ${detail}` : ""}`);
}

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

async function deploy() {
  const res = await fetch(`${BASE}/api/tasks/${taskId}/deploy`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`部署请求 ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = null;
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
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "done") done = event;
    }
  }
  if (!done) throw new Error("部署没有返回结果");
  return done;
}

async function main() {
  console.log(`selfcheck -> ${BASE}`);

  const health = await call("/api/health");
  health.status === 200 && health.data?.ok ? ok("健康检查", health.data.model) : fail("健康检查", `HTTP ${health.status}`);

  const anonymous = await call("/api/tasks");
  anonymous.status === 401 ? ok("未登录拦截") : fail("未登录拦截", `HTTP ${anonymous.status}`);

  if (!PASS) {
    console.log("跳过登录与后续用例：没有提供密码");
    return;
  }

  const badLogin = await call("/api/login", { method: "POST", body: JSON.stringify({ username: USER, password: `${PASS}-wrong` }) });
  badLogin.status === 401 ? ok("错误口令被拒") : fail("错误口令被拒", `HTTP ${badLogin.status}`);

  const login = await call("/api/login", { method: "POST", body: JSON.stringify({ username: USER, password: PASS }) });
  if (login.status !== 200) {
    fail("登录", `HTTP ${login.status}`);
    return;
  }
  const setCookie = login.headers.get("set-cookie") || "";
  cookie = setCookie.split(";")[0];
  ok("登录", USER);

  const created = await call("/api/tasks", { method: "POST", body: JSON.stringify({ name: "交付自检", prompt: "selfcheck" }) });
  if (created.status !== 201) {
    fail("创建任务", `HTTP ${created.status}`);
    return;
  }
  taskId = created.data.id;
  taskIds.push(taskId);
  ok("创建任务", taskId);

  const traversal = await call(`/api/tasks/${taskId}/files?path=${encodeURIComponent("../../../../etc/passwd")}`);
  traversal.status >= 400 ? ok("路径越界被拒", `HTTP ${traversal.status}`) : fail("路径越界被拒", `HTTP ${traversal.status}`);

  const pageV1 = `<!doctype html><html><head><meta charset="utf-8"><title>自检 V1</title><style>body{font-family:sans-serif}</style></head><body><button id="btn">V1</button><p id="out">0</p><script>let n=0;btn.onclick=()=>{out.textContent=++n}</script></body></html>`;
  const writeV1 = await call(`/api/tasks/${taskId}/files`, { method: "POST", body: JSON.stringify({ path: "index.html", content: pageV1 }) });
  writeV1.status === 200 ? ok("写入文件") : fail("写入文件", `HTTP ${writeV1.status}`);

  const first = await deploy();
  ok("首次发布", `${first.kind} v${first.version} ${first.url}`);
  const proxyBase = process.env.PROXY_BASE || health.data.proxyBase || "";
  const firstUrl = String(first.url).startsWith("http") ? first.url : `${proxyBase || BASE}${first.url}`;
  const page1 = await fetch(firstUrl);
  const html1 = await page1.text();
  page1.ok && html1.includes("自检 V1") ? ok("发布地址可访问") : fail("发布地址可访问", `HTTP ${page1.status}`);

  const pageV2 = pageV1.replace(/V1/g, "V2");
  await call(`/api/tasks/${taskId}/files`, { method: "POST", body: JSON.stringify({ path: "index.html", content: pageV2 }) });
  const second = await deploy();
  ok("二次发布", `${second.kind} v${second.version}`);
  const html2 = await (await fetch(firstUrl)).text();
  html2.includes("自检 V2") ? ok("新版本生效") : fail("新版本生效");

  const rollback = await call(`/api/tasks/${taskId}/rollback`, { method: "POST", body: JSON.stringify({ version: first.version }) });
  rollback.status === 200 ? ok("回滚接口", `v${rollback.data.version}`) : fail("回滚接口", rollback.data?.error || `HTTP ${rollback.status}`);
  const htmlBack = await (await fetch(firstUrl)).text();
  htmlBack.includes("自检 V1") ? ok("回滚后内容正确") : fail("回滚后内容正确");

  const versions = await call(`/api/tasks/${taskId}/versions`);
  (versions.data?.versions?.length >= 2) ? ok("版本列表", `${versions.data.versions.length} 个`) : fail("版本列表");

  await serverCase(health.data);
}

async function serverCase(health) {
  const created = await call("/api/tasks", { method: "POST", body: JSON.stringify({ name: "交付自检-服务端", prompt: "selfcheck server" }) });
  if (created.status !== 201) {
    fail("服务端用例：创建任务", `HTTP ${created.status}`);
    return;
  }
  const id = created.data.id;
  taskIds.push(id);
  const previousTask = taskId;
  taskId = id;

  const pkg = JSON.stringify({ name: "selfcheck-server", private: true, version: "1.0.0", scripts: { start: "node server.js" } }, null, 2);
  const makeServer = (mark) => `const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url.startsWith('/api/hello')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, mark: '${mark}' }));
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>自检服务 ${mark}</title></head><body><h1>${mark}</h1></body></html>');
}).listen(port);
`;
  await call(`/api/tasks/${id}/files`, { method: "POST", body: JSON.stringify({ path: "package.json", content: pkg }) });
  await call(`/api/tasks/${id}/files`, { method: "POST", body: JSON.stringify({ path: "server.js", content: makeServer("V1") }) });

  try {
    const first = await deploy();
    let detail = await call(`/api/tasks/${id}`);
    const port = detail.data?.published?.port;
    if (!port) {
      fail("服务端用例：拿到部署端口");
      return;
    }
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const api = await (await fetch(`http://127.0.0.1:${port}/api/hello`)).json();
    page.includes("V1") && api.mark === "V1" ? ok("服务端发布 v1") : fail("服务端发布 v1");

    await call(`/api/tasks/${id}/files`, { method: "POST", body: JSON.stringify({ path: "server.js", content: makeServer("V2") }) });
    const second = await deploy();
    const detail2 = await call(`/api/tasks/${id}`);
    const port2 = detail2.data?.published?.port || port;
    const page2 = await (await fetch(`http://127.0.0.1:${port2}/`)).text();
    page2.includes("V2") ? ok("服务端发布 v2", `v${second.version}`) : fail("服务端发布 v2");

    const back = await call(`/api/tasks/${id}/rollback`, { method: "POST", body: JSON.stringify({ version: first.version }) });
    const page3 = await (await fetch(`http://127.0.0.1:${port2}/`)).text();
    back.status === 200 && page3.includes("V1") ? ok("服务端回滚", `v${back.data.version}`) : fail("服务端回滚", back.data?.error || `HTTP ${back.status}`);
  } catch (error) {
    fail("服务端用例", String(error.message || error));
  } finally {
    taskId = previousTask;
  }
}

main()
  .catch((error) => fail("执行中断", String(error.message || error)))
  .finally(async () => {
    for (const id of taskIds) {
      const removed = await call(`/api/tasks/${id}`, { method: "DELETE" }).catch(() => ({ status: 0 }));
      if (removed.status === 200) ok("清理自检任务", id);
      else fail("清理自检任务", `${id} HTTP ${removed.status}`);
      const after = await call(`/api/tasks/${id}`).catch(() => ({ status: 0 }));
      after.status === 404 ? ok("任务已删除", id) : fail("任务已删除", `${id} HTTP ${after.status}`);
    }
    const failed = results.filter((item) => !item.pass);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    process.exit(failed.length ? 1 : 0);
  });