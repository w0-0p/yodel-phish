import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectRoot } from "./model-files.mjs";

const listed = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: projectRoot, encoding: "buffer" }
);
if (listed.error) throw listed.error;
if (listed.status !== 0) throw new Error("git ls-files failed");

const files = listed.stdout.toString("utf8").split("\0").filter(Boolean);
const forbiddenPaths = [
  /(?:^|\/)node_modules(?:\/|$)/,
  /(?:^|\/)\.claude(?:\/|$)/,
  /(?:^|\/)\.codex(?:\/|$)/,
  /(?:^|\/)\.venv(?:\/|$)/,
  /(?:^|\/)build(?:\/|$)/,
  /(?:^|\/)dist(?:\/|$)/,
  /(?:^|\/)downloads(?:\/|$)/
];
const forbiddenText = [
  { label: "private workstation path", pattern: /\/home\/w00p(?:\/|\b)/i },
  { label: "private project path", pattern: /Documents\/Dev\/Project/i },
  { label: "development repository reference", pattern: /yodel-phish-(?:dev|beta)/i },
  { label: "placeholder repository URL", pattern: /github\.com\/example\/yodel-phish/i },
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "GitHub token", pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ }
];

const findings = [];
for (const relative of files) {
  if (forbiddenPaths.some((pattern) => pattern.test(relative))) {
    findings.push(`${relative}: forbidden generated/private path`);
    continue;
  }
  const absolute = path.join(projectRoot, relative);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) {
    findings.push(`${relative}: symlink is not allowed`);
    continue;
  }
  if (!info.isFile()) continue;
  const buffer = await readFile(absolute);
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  for (const rule of forbiddenText) {
    if (rule.pattern.test(text)) findings.push(`${relative}: ${rule.label}`);
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Scanned ${files.length} public-tree files; no forbidden paths or secret patterns found`);
}
