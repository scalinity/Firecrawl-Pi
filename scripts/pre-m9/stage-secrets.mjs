// Owner-local .env -> the existing Pi secret mechanism. Values travel only over SSH stdin.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
if (git("ls-files", "--", ".env") || git("log", "--all", "--format=%H", "--", ".env")) throw new Error("STOP: .env is tracked or in history");
git("check-ignore", "--", ".env");
const env = parseEnv(readFileSync(root + ".env", "utf8"));
const required = ["OPENAI_API_KEY", "LLAMA_CLOUD_API_KEY", "DECODO_PROXY_HOST", "DECODO_PROXY_PORT", "DECODO_PROXY_USERNAME", "DECODO_PROXY_PASSWORD", "ZYTE_API_KEY"];
for (const name of required) if (!env[name] || /[\r\n]/.test(env[name])) throw new Error(`${name}: absent or malformed`);
if (env.DECODO_PROXY_HOST !== "gate.decodo.com" || env.DECODO_PROXY_PORT !== "7000") throw new Error("Decodo gateway differs from the approved contract");
const target = Object.fromEntries(readFileSync(root + "scripts/m1/pi-target.conf", "utf8").split("\n").filter(l => /^PI_\w+=/.test(l)).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
for (const [name, value] of Object.entries({ openai_api_key: env.OPENAI_API_KEY, llamaparse_api_key: env.LLAMA_CLOUD_API_KEY,
  decodo_proxy: `${env.DECODO_PROXY_USERNAME}:${env.DECODO_PROXY_PASSWORD}`, zyte_api_key: env.ZYTE_API_KEY })) {
  try {
    execFileSync("ssh", ["-i", target.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", target.PI_SSH_TARGET,
      `bash /opt/firecrawl-pi/scripts/m5/pi-provider-key.sh ${name} --replace`], { input: value, stdio: ["pipe", "ignore", "ignore"] });
  } catch { throw new Error(`${name}: secret transfer failed (diagnostics suppressed)`); }
  console.log(`${name}=installed via existing restricted secret mechanism`);
}
