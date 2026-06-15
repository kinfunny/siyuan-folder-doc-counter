import { mkdir, cp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const releaseDir = path.join(root, "release", "siyuan-folder-doc-counter");

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });

for (const file of [
  "dist/index.js",
  "plugin.json",
  "README.md",
  "README_zh_CN.md",
  "LICENSE",
  "icon.png",
  "preview.png",
]) {
  const src = path.join(root, file);
  if (existsSync(src)) {
    await cp(src, path.join(releaseDir, path.basename(file)));
  }
}

await cp(path.join(root, "dist", "style.css"), path.join(releaseDir, "index.css"));

await writeFile(
  path.join(releaseDir, "package.json"),
  JSON.stringify({ name: "siyuan-folder-doc-counter", version: "0.1.1" }, null, 2)
);

const zipPath = path.join(root, "release", "package.zip");
await rm(zipPath, { force: true });
const zip = spawnSync("zip", ["-qr", zipPath, "siyuan-folder-doc-counter"], {
  cwd: path.join(root, "release"),
});
if (zip.status !== 0) {
  throw new Error(zip.stderr.toString() || "zip failed");
}

console.log(releaseDir);
console.log(zipPath);
