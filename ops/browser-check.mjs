import fs from "node:fs";
import puppeteer from "puppeteer-core";

const url = process.argv[2];
const screenshot = process.argv[3] || "";
const waitMs = Number(process.argv[4] || 2500);
const specPath = process.argv[5] || "";

if (!url) {
  console.log(JSON.stringify({ ok: false, error: "缺少 url" }));
  process.exit(0);
}

let spec = {};
if (specPath) {
  try {
    spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: `检查配置解析失败：${error.message}` }));
    process.exit(0);
  }
}
const actions = Array.isArray(spec.actions) ? spec.actions.slice(0, 12) : [];
const expects = Array.isArray(spec.expect) ? spec.expect.slice(0, 20) : [];
const viewport = {
  width: Math.min(Math.max(Number(spec.viewport?.width) || 1280, 320), 2560),
  height: Math.min(Math.max(Number(spec.viewport?.height) || 860, 320), 1600),
};

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: "/data/atoms-demo-v2/tools/chrome/chrome-headless-shell",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: viewport.width, height: viewport.height });

  const errors = [];
  const requestFailures = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text().slice(0, 200));
  });
  page.on("pageerror", (err) => errors.push(String(err.message).slice(0, 200)));
  page.on("requestfailed", (req) => requestFailures.push(`${req.url().slice(0, 120)} ${req.failure()?.errorText || ""}`.trim()));

  const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  const actionLog = [];
  for (const action of actions) {
    const type = String(action.type || action.action || "").toLowerCase();
    const before = await page.evaluate(() => ({
      text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 2000),
      nodes: document.body ? document.body.querySelectorAll("*").length : 0,
      url: location.href,
    }));
    try {
      if (type === "press") {
        await page.keyboard.press(String(action.key || ""));
      } else if (type === "click") {
        await page.click(String(action.selector || ""), { timeout: 5000 });
      } else if (type === "fill" || type === "type") {
        const selector = String(action.selector || "");
        const value = String(action.value ?? "");
        await page.click(selector, { timeout: 5000 });
        await page.$eval(selector, (el) => {
          const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value")?.set;
          if (setter) setter.call(el, "");
          else el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        if (value) await page.type(selector, value, { delay: 15 });
      } else if (type === "wait") {
        await new Promise((resolve) => setTimeout(resolve, Math.min(Number(action.ms) || 400, 5000)));
      } else if (type === "reload") {
        await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
      } else {
        actionLog.push({ type, ok: false, error: "不认识的动作" });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(Number(action.settleMs) || 350, 3000)));
      const after = await page.evaluate(() => ({
        text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 2000),
        nodes: document.body ? document.body.querySelectorAll("*").length : 0,
        url: location.href,
      }));
      actionLog.push({ type, ok: true, changed: before.text !== after.text || before.nodes !== after.nodes || before.url !== after.url });
    } catch (error) {
      actionLog.push({ type, ok: false, error: String(error.message || error).slice(0, 200) });
    }
  }

  const snapshot = await page.evaluate(() => ({
    title: document.title,
    text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 20000),
    buttons: document.querySelectorAll("button").length,
    inputs: document.querySelectorAll("input,textarea,select").length,
    nodes: document.body ? document.body.querySelectorAll("*").length : 0,
    url: location.href,
  }));

  const failures = [];
  for (const action of actionLog) {
    if (!action.ok) failures.push(`动作失败（${action.type}）：${action.error || "未知错误"}`);
  }

  const queryCount = async (selector) =>
    page.evaluate((sel) => document.querySelectorAll(sel).length, selector).catch(() => -1);
  const queryValue = async (selector) =>
    page.evaluate((sel) => document.querySelector(sel)?.value ?? null, selector).catch(() => null);

  for (const expect of expects) {
    const type = String(expect.type || "").toLowerCase();
    const value = expect.value ?? "";
    if (type === "textcontains") {
      const scope = expect.selector
        ? await page.evaluate((sel) => document.querySelector(sel)?.innerText || "", String(expect.selector))
        : snapshot.text;
      const hit = String(scope).replace(/\s+/g, " ").trim().includes(String(value));
      if (!hit) failures.push(`${expect.selector || "页面"} 的文本里没有「${value}」`);
    } else if (type === "textnotcontains") {
      const scope = expect.selector
        ? await page.evaluate((sel) => document.querySelector(sel)?.innerText || "", String(expect.selector))
        : snapshot.text;
      if (String(scope).replace(/\s+/g, " ").trim().includes(String(value))) failures.push(`${expect.selector || "页面"} 不应出现「${value}」`);
    } else if (type === "selectorexists" || type === "selectorcount") {
      const count = await queryCount(String(expect.selector || ""));
      if (type === "selectorexists") {
        if (count < 1) failures.push(`找不到元素 ${expect.selector}`);
      } else {
        const min = expect.min == null ? 1 : Number(expect.min);
        const max = expect.max == null ? Number.MAX_SAFE_INTEGER : Number(expect.max);
        const equals = expect.equals == null ? null : Number(expect.equals);
        if (equals != null && count !== equals) failures.push(`${expect.selector} 数量应为 ${equals}，实际 ${count}`);
        else if (count < min || count > max) failures.push(`${expect.selector} 数量应在 ${min}–${max}，实际 ${count}`);
      }
    } else if (type === "inputvalue") {
      const actual = await queryValue(String(expect.selector || ""));
      if (String(actual ?? "") !== String(value)) failures.push(`${expect.selector} 的值应为「${value}」，实际「${actual ?? ""}」`);
    } else if (type === "urlcontains") {
      if (!snapshot.url.includes(String(value))) failures.push(`当前地址不含「${value}」`);
    } else if (type === "nopageoverflow") {
      const metrics = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      if (metrics.scroll > metrics.inner + 1) failures.push(`页面横向溢出：内容宽 ${metrics.scroll}px，视口 ${metrics.inner}px`);
    } else if (type === "consoleerrors") {
      const max = expect.max == null ? 0 : Number(expect.max);
      if (errors.length > max) failures.push(`控制台错误 ${errors.length} 条，上限 ${max}`);
    } else if (type === "requestfailures") {
      const max = expect.max == null ? 0 : Number(expect.max);
      if (requestFailures.length > max) failures.push(`请求失败 ${requestFailures.length} 个，上限 ${max}`);
    } else {
      failures.push(`不认识的断言类型「${type}」`);
    }
  }

  if (screenshot) {
    await page.screenshot({ path: screenshot });
  }

  const hasErrorExpect = expects.some((item) => String(item.type || "").toLowerCase() === "consoleerrors");
  const baseOk = Boolean(response && response.ok()) && snapshot.text.length > 0 && (hasErrorExpect || errors.length === 0);
  const ok = baseOk && failures.length === 0;

  console.log(
    JSON.stringify({
      ok,
      status: response ? response.status() : 0,
      title: snapshot.title,
      text: snapshot.text.slice(0, 300),
      buttons: snapshot.buttons,
      inputs: snapshot.inputs,
      nodes: snapshot.nodes,
      errors: errors.slice(0, 6),
      requestFailures: requestFailures.slice(0, 6),
      actions: actionLog,
      failures: failures.slice(0, 8),
      screenshot: screenshot || undefined,
    }),
  );
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 300), failures: [String(error.message || error).slice(0, 300)] }));
} finally {
  if (browser) await browser.close().catch(() => {});
}