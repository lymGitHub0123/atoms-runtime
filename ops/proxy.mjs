import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PROXY_PORT || 24680);
const MAP_FILE = process.env.PREVIEW_MAP || "/data/atoms-demo-v2/runtime/preview.json";
const PUBLISH_FILE = process.env.PUBLISH_FILE || "/data/atoms-demo-v2/runtime/published.json";
const APP_HOST_SUFFIX = (process.env.PUBLIC_APP_HOST_SUFFIX || "").toLowerCase().replace(/^\.+/, "");
const PUBLIC_APP_PORT = process.env.PUBLIC_APP_PORT || "24680";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const publishedApp = (slug) => readJson(PUBLISH_FILE, { apps: {} }).apps?.[slug] || null;
const previewPort = (taskId) => readJson(MAP_FILE, {})[taskId] || null;

const CONTROL = new URL(process.env.CONTROL_URL || "http://127.0.0.1:13579");

function ensurePreview(taskId) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: CONTROL.hostname,
        port: CONTROL.port || 80,
        path: `/api/internal/preview/${taskId}`,
        method: "POST",
        timeout: 30000,
      },
      (upstream) => {
        let body = "";
        upstream.on("data", (chunk) => (body += chunk));
        upstream.on("end", () => {
          try {
            resolve(JSON.parse(body).port || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function proxyToPort(req, res, port, onError) {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", async () => {
    if (onError && (await onError())) return;
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("bad gateway");
  });
  req.pipe(upstream);
}

function serveStatic(req, res, app, pathname) {
  if (!app.dir) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("app not found");
    return;
  }
  const root = path.resolve(app.dir);
  let rel = decodeURIComponent(pathname || "/").replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  let full = path.resolve(root, rel);

  if (!full.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    full = path.join(root, "index.html");
    if (!fs.existsSync(full)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
  }

  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  res.end(fs.readFileSync(full));
}

function slugFromHost(host) {
  const name = (host || "").split(":")[0].toLowerCase();
  if (!APP_HOST_SUFFIX || !name.endsWith(`.${APP_HOST_SUFFIX}`)) return null;
  return name.slice(0, -(APP_HOST_SUFFIX.length + 1)) || null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");

  // 1) 子域名路由：{slug}.<suffix> → 容器应用（根路径）
  const hostSlug = slugFromHost(req.headers.host);
  if (hostSlug) {
    const app = publishedApp(hostSlug);
    if (!app) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("app not found");
      return;
    }
    if (app.kind === "server") return proxyToPort(req, res, app.port);
    return serveStatic(req, res, app, url.pathname);
  }

  // 2) 预览：/preview/{taskId}/ → 沙箱 dev server（保留完整路径，Vite base 依赖它）
  const preview = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
  if (preview) {
    let port = previewPort(preview[1]);
    if (!port) port = await ensurePreview(preview[1]);
    if (!port) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`preview unavailable for ${preview[1]}（容器启动失败，请打开任务查看原因）`);
      return;
    }
    return proxyToPort(req, res, port, async () => {
      if (req.method !== "GET") return false;
      const retryPort = await ensurePreview(preview[1]);
      if (!retryPort) return false;
      proxyToPort(req, res, retryPort);
      return true;
    });
  }

  // 3) 路径访问：/apps/{slug}/{path}
  const appMatch = url.pathname.match(/^\/apps\/([^/]+)(\/.*)?$/);
  if (appMatch) {
    const slug = appMatch[1];
    const app = publishedApp(slug);
    if (!app) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("app not found");
      return;
    }
    if (app.kind === "server") {
      const target = APP_HOST_SUFFIX ? `http://${slug}.${APP_HOST_SUFFIX}:${PUBLIC_APP_PORT}/` : "";
      if (target) {
        res.writeHead(302, { location: target });
        res.end();
      } else {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("server app: 请通过子域名访问");
      }
      return;
    }
    return serveStatic(req, res, app, appMatch[2] || "/");
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("atoms proxy: /preview/{taskId}/ · /apps/{slug}/ · {slug}." + (APP_HOST_SUFFIX || "host"));
});

// WebSocket 透传（Vite HMR / 实时应用）
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://x");
  let target = null;

  const hostSlug = slugFromHost(req.headers.host);
  if (hostSlug) {
    const app = publishedApp(hostSlug);
    if (app && app.kind === "server") target = app.port;
  }

  if (!target) {
    const preview = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
    if (preview) target = previewPort(preview[1]);
  }

  if (!target) {
    socket.destroy();
    return;
  }

  const upstream = net.connect(target, "127.0.0.1", () => {
    const headers = Object.entries(req.headers)
      .filter(([key]) => key.toLowerCase() !== "host")
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n");
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\nhost: 127.0.0.1:${target}\r\n${headers}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[proxy] :${PORT} suffix=${APP_HOST_SUFFIX || "-"} preview=${MAP_FILE} apps=${PUBLISH_FILE}`);
});