import puppeteer from "puppeteer-core";

const url = process.argv[2];
const screenshot = process.argv[3] || "";
const waitMs = Number(process.argv[4] || 2500);

if (!url) {
  console.log(JSON.stringify({ ok: false, error: "缺少 url" }));
  process.exit(0);
}

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: "/data/atoms-demo-v2/tools/chrome/chrome-headless-shell",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });

  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text().slice(0, 200));
  });
  page.on("pageerror", (err) => errors.push(String(err.message).slice(0, 200)));
  page.on("requestfailed", (req) => errors.push(`请求失败 ${req.url().slice(0, 120)}`));

  const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  const data = await page.evaluate(() => ({
    title: document.title,
    text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
    buttons: document.querySelectorAll("button").length,
    nodes: document.body ? document.body.querySelectorAll("*").length : 0,
  }));

  if (screenshot) {
    await page.screenshot({ path: screenshot });
  }

  const ok = Boolean(response && response.ok()) && data.text.length > 0 && errors.length === 0;
  console.log(
    JSON.stringify({
      ok,
      status: response ? response.status() : 0,
      title: data.title,
      text: data.text,
      buttons: data.buttons,
      nodes: data.nodes,
      errors: errors.slice(0, 6),
      screenshot: screenshot || undefined,
    }),
  );
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 300) }));
} finally {
  if (browser) await browser.close().catch(() => {});
}