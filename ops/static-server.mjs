import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "/workspace");
const port = Number(process.argv[3] || 5173);
const base = (process.argv[4] || "").replace(/\/+$/, "");

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url || "/", "http://x").pathname);

    if (base && !urlPath.startsWith(`${base}/`) && urlPath !== base) {
      res.writeHead(302, { location: `${base}/` });
      res.end();
      return;
    }

    const rel = base ? urlPath.slice(base.length) : urlPath;
    let file = path.join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    } catch {
      /* fall through */
    }
    if (!fs.existsSync(file)) file = path.join(root, "index.html");
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        "content-type": types[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    }
  })
  .listen(port, "0.0.0.0", () => console.log(`[static] ${root} -> :${port} base=${base || "/"}`));