// Fails if server-only RDP/AWS material reaches anything the browser downloads: client assets (.next/static) and
// prerendered HTML/RSC payloads (.next/server/app). Run after `next build`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const next = fileURLToPath(new URL("../.next", import.meta.url));
const forbidden = [
  "execute-api",
  "AssumeRoleWithWebIdentity",
  "SignatureV4",
  "amazonaws.com",
  "arn:aws:",
  "x-amz-security-token",
  "RDP_ROLE_ARN",
  "RDP_READ_API_URL",
  "RDP_DATA_MODE",
  "VERCEL_OIDC_TOKEN",
  "@aws-sdk",
  "@smithy/signature-v4",
];

function* files(directory, keep = () => true) {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* files(path, keep);
    else if (keep(path)) yield path;
  }
}

const targets = [
  ...files(join(next, "static")),
  ...files(join(next, "server", "app"), (path) => /\.(html|rsc|body)$/.test(path)),
];
const leaks = [];
for (const file of targets) {
  const text = readFileSync(file, "utf8");
  for (const term of forbidden) if (text.includes(term)) leaks.push(`${file}: ${term}`);
}
if (targets.length === 0) {
  console.error("No client assets found; run `next build` first.");
  process.exit(1);
}
if (leaks.length > 0) {
  console.error(`Server-only material found in browser-delivered output:\n${leaks.join("\n")}`);
  process.exit(1);
}
console.log(`Checked ${targets.length} browser-delivered files: no server-only RDP/AWS material.`);
