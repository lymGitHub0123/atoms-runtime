const state = {
  tasks: [],
  current: null,
  tab: "preview",
  files: [],
  activeFile: null,
  busy: false,
  steps: [],
  proxyBase: "",
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    $("login").hidden = false;
    throw new Error("unauthorized");
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error((data && data.error) || `请求失败 ${res.status}`);
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------- tasks ---------- */

async function loadTasks() {
  state.tasks = await api("/api/tasks");
  $("task-count").textContent = String(state.tasks.length);
  const list = $("task-list");
  list.innerHTML = "";
  for (const task of state.tasks) {
    const item = el("div", "task-item" + (state.current?.id === task.id ? " active" : ""));
    const main = el("div", "task-main");
    main.appendChild(el("b", null, task.name));
    main.appendChild(el("span", null, new Date(task.createdAt).toLocaleString("zh-CN")));
    item.appendChild(main);

    const del = el("button", "task-del", "×");
    del.title = "删除任务";
    del.onclick = async (event) => {
      event.stopPropagation();
      if (!window.confirm(`删除「${task.name}」？容器会被销毁，工作区保留。`)) return;
      const wasCurrent = state.current?.id === task.id;
      try {
        await api(`/api/tasks/${task.id}`, { method: "DELETE" });
      } catch (error) {
        window.alert(error.message);
        return;
      }
      await loadTasks();
      if (!wasCurrent) return;

      const next = state.tasks[0];
      if (next) {
        await selectTask(next.id);
        return;
      }

      state.current = null;
      $("steps").innerHTML = "";
      $("chat").innerHTML = "";
      $("task-info").innerHTML = "";
      $("publish-bar").hidden = true;
      $("deploy-btn").disabled = true;
      $("empty").classList.remove("hidden");
    };
    item.appendChild(del);
    item.onclick = () => selectTask(task.id);
    list.appendChild(item);
  }
}

async function selectTask(id) {
  state.current = await api(`/api/tasks/${id}`);
  state.steps = [];
  state.files = [];
  state.activeFile = null;
  $("empty").classList.add("hidden");
  $("steps").innerHTML = "";
  $("deploy-btn").disabled = false;
  $("deploy-log").hidden = true;
  $("deploy-log-body").textContent = "";

  renderTaskInfo();
  renderMessages();
  renderEvents();
  renderPreview();
  renderPublish();
  showTab("preview");
  await loadFiles();
  await loadTasks();
}

function renderTaskInfo() {
  const task = state.current;
  if (!task) return;
  $("task-info").innerHTML = "";
  const rows = [
    ["任务", task.name],
    ["ID", task.id],
    ["容器", task.container],
    ["端口", `127.0.0.1:${task.port}`],
    ["状态", task.status],
    ["技术", task.stack || "-"],
  ];
  for (const [key, value] of rows) {
    const row = el("div");
    row.textContent = `${key}：${value}`;
    $("task-info").appendChild(row);
  }
}

function renderMessages() {
  const chat = $("chat");
  chat.innerHTML = "";
  for (const message of state.current?.messages || []) {
    const bubble = el("div", `msg ${message.role}`, message.content);
    chat.appendChild(bubble);
  }
  chat.scrollTop = chat.scrollHeight;
  $("chat-hint").textContent = state.current ? `${(state.current.messages || []).length} 条` : "描述你要的应用";
}

function renderPreview() {
  const frame = $("frame");
  if (!state.current) {
    frame.removeAttribute("src");
    $("preview-url").textContent = "";
    return;
  }
  const base = state.proxyBase || "";
  frame.src = `${base}${state.current.preview}?t=${Date.now()}`;
  const url = `${base}${state.current.preview}`;
  $("preview-url").textContent = state.current.preview;
  $("open").href = url;
}

function renderEvents() {
  const steps = $("steps");
  steps.innerHTML = "";
  const events = state.current?.events || [];
  if (events.length === 0) return;
  for (const event of events) {
    const card = el("div", "step");
    const top = el("div", "step-top");
    const dot = el("span", "dot " + (event.ok ? "ok" : "fail"));
    top.appendChild(dot);
    top.appendChild(el("span", "step-tool", event.tool));
    card.appendChild(top);
    const detail = el("div", "step-result");
    detail.textContent = String(event.text || "").slice(0, 600);
    card.appendChild(detail);
    steps.appendChild(card);
  }
  steps.scrollTop = steps.scrollHeight;
}

function renderPublish() {
  const published = state.current?.published;
  $("publish-bar").hidden = !published;
  if (!published) { $("publish-link").textContent = ""; $("publish-link").removeAttribute("href"); }
  if (published) {
    const link = $("publish-link");
    const href = String(published.url || "").startsWith("http") ? published.url : `${state.proxyBase}${published.url}`;
    link.href = href;
    link.textContent = `${href} · v${published.version}${published.port ? ` · 容器 :${published.port}` : ""}`;
  }
}

/* ---------- steps ---------- */

function pushStep(event) {
  const steps = $("steps");
  if (!event.result) {
    const card = el("div", "step");
    card.dataset.key = `${event.step}-${event.tool}`;
    const top = el("div", "step-top");
    top.appendChild(el("span", "dot"));
    top.appendChild(el("span", "step-tool", event.tool));
    top.appendChild(el("span", "muted small", `step ${event.step}`));
    card.appendChild(top);
    const detail = el("div", "step-result");
    detail.textContent = JSON.stringify(event.args || {}).slice(0, 300);
    card.appendChild(detail);
    steps.appendChild(card);
    steps.scrollTop = steps.scrollHeight;
    $("step-state").textContent = `运行中 · ${event.tool}`;
    return;
  }

  const cards = steps.querySelectorAll(`[data-key="${event.step}-${event.tool}"]`);
  const card = cards[cards.length - 1];
  if (!card) return;
  const dot = card.querySelector(".dot");
  dot.classList.add(event.result.ok ? "ok" : "fail");
  const detail = card.querySelector(".step-result");
  const output = event.result.output || event.result.error || event.result.snippet || `HTTP ${event.result.status ?? "-"}`;
  detail.textContent = String(output).slice(0, 1200);
}

/* ---------- chat ---------- */

async function send(message) {
  if (!state.current || state.busy || !message.trim()) return;
  state.busy = true;
  $("send").disabled = true;
  $("step-state").textContent = "运行中";

  const chat = $("chat");
  chat.appendChild(el("div", "msg user", message));
  chat.scrollTop = chat.scrollHeight;

  try {
    const res = await fetch(`/api/tasks/${state.current.id}/chat`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok || !res.body) throw new Error((await res.text()).slice(0, 200));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const packet = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\n\n");
        for (const line of packet.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const event = JSON.parse(line.slice(5).trim());
          if (event.type === "step") pushStep(event);
          else if (event.type === "message") {
            chat.appendChild(el("div", "msg assistant", event.text));
            chat.scrollTop = chat.scrollHeight;
          } else if (event.type === "done") {
            $("step-state").textContent = "完成";
            if (event.summary) chat.appendChild(el("div", "msg assistant", event.summary));
          } else if (event.type === "error") {
            chat.appendChild(el("div", "msg assistant", `错误：${event.message}`));
          }
        }
      }
    }
  } catch (error) {
    chat.appendChild(el("div", "msg assistant", `请求失败：${error.message}`));
  } finally {
    state.busy = false;
    $("send").disabled = false;
    state.current = await api(`/api/tasks/${state.current.id}`);
    renderMessages();
    renderPublish();
    $("frame").src = `${state.proxyBase}${state.current.preview}?t=${Date.now()}`;
    await loadFiles();
  }
}

/* ---------- files ---------- */

async function loadFiles() {
  if (!state.current) return;
  const data = await api(`/api/tasks/${state.current.id}/files`);
  state.files = Array.isArray(data.files) ? data.files : [];
  const list = $("file-list");
  list.innerHTML = "";
  for (const file of state.files) {
    const item = el("div", "file-item" + (state.activeFile === file ? " active" : ""), file);
    item.onclick = () => openFile(file);
    list.appendChild(item);
  }
}

async function openFile(path) {
  state.activeFile = path;
  const data = await api(`/api/tasks/${state.current.id}/files?path=${encodeURIComponent(path)}`);
  $("file-body").textContent = data.content;
  await loadFiles();
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function toast(message, url) {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const box = el("div", "toast");
  box.appendChild(el("span", null, message));
  if (url) {
    const link = el("a", null, url);
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    box.appendChild(link);
    const copy = el("button", null, "复制");
    copy.onclick = async () => {
      const ok = await copyText(url);
      copy.textContent = ok ? "已复制" : "请手动复制";
    };
    box.appendChild(copy);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 12000);
}

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((node) => node.classList.toggle("active", node.dataset.tab === tab));
  $("frame").style.display = tab === "preview" ? "block" : "none";
  $("files-view").hidden = tab !== "files";
}

/* ---------- deploy ---------- */

async function deploy() {
  if (!state.current) return;
  $("deploy-btn").disabled = true;
  $("deploy-log").hidden = false;
  $("deploy-log-body").textContent = "";
  $("publish-bar").hidden = false;
  $("publish-link").textContent = "部署中…";
  $("publish-link").removeAttribute("href");

  try {
    const res = await fetch(`/api/tasks/${state.current.id}/deploy`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const packet = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\n\n");
        for (const line of packet.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const event = JSON.parse(line.slice(5).trim());
          if (event.type === "log") {
            $("deploy-log-body").textContent += `${event.text}\n`;
            $("deploy-log-body").scrollTop = $("deploy-log-body").scrollHeight;
          } else if (event.type === "error") {
            $("deploy-log-body").textContent += `\n❌ ${event.message}\n`;
          } else if (event.type === "done") {
            const full = String(event.url || "").startsWith("http") ? event.url : `${state.proxyBase}${event.url}`;
            $("deploy-log-body").textContent += `\n✅ 已发布 ${full}\n`;
            state.current = await api(`/api/tasks/${state.current.id}`);
            renderPublish();
            toast("部署完成", full);
          }
        }
      }
    }
  } catch (error) {
    $("deploy-log-body").textContent += `\n请求失败：${error.message}\n`;
    toast(`部署失败：${error.message}`);
  } finally {
    $("deploy-btn").disabled = false;
  }
}

/* ---------- events ---------- */

$("new-task").onclick = () => {
  $("empty").classList.remove("hidden");
  $("new-prompt").focus();
};

$("new-task-inline").onclick = () => {
  $("empty").classList.remove("hidden");
  $("new-prompt").focus();
};

$("new-form").onsubmit = async (event) => {
  event.preventDefault();
  const prompt = $("new-prompt").value.trim();
  if (!prompt) return;
  const name = $("new-name").value.trim() || prompt.slice(0, 16);
  $("new-form").querySelector("button").disabled = true;
  try {
    const task = await api("/api/tasks", { method: "POST", body: JSON.stringify({ name, prompt }) });
    $("new-name").value = "";
    $("new-prompt").value = "";
    $("empty").classList.add("hidden");
    await loadTasks();
    await selectTask(task.id);
    await send(prompt);
  } catch (error) {
    alert(error.message);
  } finally {
    $("new-form").querySelector("button").disabled = false;
  }
};

$("logout").onclick = async () => {
  await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  location.reload();
};

$("composer").onsubmit = (event) => {
  event.preventDefault();
  const value = $("message").value.trim();
  if (!value) return;
  $("message").value = "";
  send(value);
};

$("message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

$("deploy-btn").onclick = deploy;
$("publish-copy").onclick = async () => {
  const published = state.current?.published;
  if (!published) return;
  const ok = await copyText(`${state.proxyBase}${published.url}`);
  $("publish-copy").textContent = ok ? "已复制" : "请手动复制";
  setTimeout(() => {
    $("publish-copy").textContent = "复制";
  }, 1600);
};
$("refresh").onclick = () => {
  if (state.current) $("frame").src = `${state.proxyBase}${state.current.preview}?t=${Date.now()}`;
};
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => showTab(tab.dataset.tab);
});

$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ username: $("username").value.trim(), password: $("password").value }) });
    $("login").hidden = true;
    await boot();
  } catch {
    $("login-error").textContent = "口令不正确";
  }
};

/* ---------- boot ---------- */

async function boot() {
  const health = await api("/api/health");
  state.proxyBase = health.proxyBase || "";
  $("docker-chip").textContent = `DOCKER · ${health.tasks} 个容器`;
  $("user-chip").textContent = health.user ? `账号 · ${health.user}` : "未登录";
  $("model-chip").textContent = health.model;
  await loadTasks();
  if (state.tasks.length > 0) {
    await selectTask(state.tasks[0].id);
  } else {
    $("empty").classList.remove("hidden");
  }
}

boot().catch((error) => {
  if (error.message !== "unauthorized") {
    console.error(error);
    $("empty").classList.remove("hidden");
  }
});