/**
 * 全新环境自检：只用仓库里的文件起一套控制面 + 反代，再跑 ops/selfcheck.mjs。
 * 不读线上目录、不用模型；结束后清理临时目录和自检任务。
 * 用法：node ops/cleanroom.mjs [仓库根目录]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repo = path.resolve(process.argv[2] || process.cwd());
const root = fs.mkdtempSync(path.join(os.tmpdir(), "atoms-cleanroom-"));
const port = Number(process.env.CLEANROOM_PORT || 13679);
const proxyPort = Number(process.env.CLEANROOM_PROXY_PORT || 24681);
const user = "cleanroom";
const pass = "cleanroom-pass";

const children = [];
function start(name, script, env) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => process.env.VERBOSE && process.stdout.write(`[${name}] ${data}`));
  child.stderr.on("data", (data) => process.stdout.write(`[${name}] ${data}`));
  children.push(child);
  return child;
}

function stop() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

async function waitFor(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  console.log(`cleanroom repo=${repo}`);
  console.log(`cleanroom root=${root}`);

  const uiSrc = path.join(repo, "platform/ui");
  const uiDst = path.join(root, "apps/control/ui");
  if (!fs.existsSync(uiSrc)) throw new Error("仓库里找不到 platform/ui");
  fs.mkdirSync(uiDst, { recursive: true });
  fs.cpSync(uiSrc, uiDst, { recursive: true });

  start("control", path.join(repo, "platform/server.mjs"), {
    PORT: String(port),
    ATOMS_ROOT: root,
    USERS: `${user}:${pass}`,
    AUTH_SECRET: "cleanroom-secret",
    PUBLIC_PROXY_BASE: `http://127.0.0.1:${proxyPort}`,
    PUBLIC_APP_HOST_SUFFIX: "",
    PUBLIC_APP_PORT: String(proxyPort),
  });
  start("proxy", path.join(repo, "ops/proxy.mjs"), {
    PROXY_PORT: String(proxyPort),
    PREVIEW_MAP: path.join(root, "runtime/preview.json"),
    PUBLISH_FILE: path.join(root, "runtime/published.json"),
    PUBLIC_APP_HOST_SUFFIX: "",
    PUBLIC_APP_PORT: String(proxyPort),
  });

  const ready = await waitFor(`http://127.0.0.1:${port}/api/health`);
  if (!ready) throw new Error("控制面没有起来");

  const code = await run(process.execPath, [path.join(repo, "ops/selfcheck.mjs"), `http://127.0.0.1:${port}`, user, pass], {
    PROXY_BASE: `http://127.0.0.1:${proxyPort}`,
  });
  return code;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error("cleanroom failed:", String(error.message || error));
} finally {
  stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`cleanroom done, exit=${exitCode}`);
  process.exit(exitCode);
}