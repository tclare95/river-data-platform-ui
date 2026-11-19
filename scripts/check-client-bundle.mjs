// Fails if server-only RDP/AWS material reaches anything the browser downloads (.next/static).
// Run after `next build`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../.next/static", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const forbidden = [
  "execute-api",
  "AssumeRoleWithWebIdentity",
  "sts.eu-west-1",
  "arn:aws:",
  "x-amz-security-token",
  "RDP_ROLE_ARN",
  "RDP_READ_API_URL",
  "RDP_DATA_MODE",
  "VERCEL_OIDC_TOKEN",
  "@aws-sdk",
  "@smithy/signature-v4",
];

function* files(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

let checked = 0;
const leaks = [];
for (const file of files(root)) {
  const text = readFileSync(file, "utf8");
  checked++;
  for (const term of forbidden) if (text.includes(term)) leaks.push(`${file}: ${term}`);
}
if (checked === 0) {
  console.error("No client assets found; run `next build` first.");
  process.exit(1);
}
if (leaks.length > 0) {
  console.error(`Server-only material found in client assets:\n${leaks.join("\n")}`);
  process.exit(1);
}
console.log(`Checked ${checked} client assets: no server-only RDP/AWS material.`);
