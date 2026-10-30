import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const envFile = path.join(process.cwd(), ".env.local");
const outDir = path.join(process.cwd(), "platform", ".deploy");
fs.mkdirSync(outDir, { recursive: true });

const wanted = ["DASHSCOPE_API_KEY", "LLM_MODEL", "LLM_BASE_URL", "LLM_EXTRA_BODY"];
const values = {};
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (match && wanted.includes(match[1])) values[match[1]] = match[2].trim();
}

values.LLM_MODEL ||= "qwen3.8-max";
values.LLM_BASE_URL ||= "https://dashscope.aliyuncs.com/compatible-mode/v1";
values.LLM_EXTRA_BODY ||= '{"enable_thinking":false}';

const secretFile = path.join(outDir, "auth.secret");
if (!fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, crypto.randomBytes(24).toString("hex"));
}
const authSecret = fs.readFileSync(secretFile, "utf8").trim();

const lines = [
  ...wanted.filter((key) => values[key]).map((key) => `${key}=${values[key]}`),
  "USERS=admin:change-me,alice:change-me",
  `AUTH_SECRET=${authSecret}`,
];

fs.writeFileSync(path.join(outDir, "control.env"), `${lines.join("\n")}\n`, { mode: 0o600 });
console.log("control.env written:", wanted.filter((k) => values[k]).join(", "), "+ ADMIN_PASSWORD + AUTH_SECRET");
console.log("key length:", (values.DASHSCOPE_API_KEY || "").length);