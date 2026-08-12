import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const failures = [];

for (const browser of ["firefox", "chromium"]) {
  const directory = new URL(`dist/${browser}/`, root);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
  } catch (error) {
    failures.push(`${browser}: invalid or missing manifest (${error.message})`);
    continue;
  }

  const required = [
    "pages/popup/index.html",
    "pages/options/index.html",
    "pages/blocked/index.html",
    "background/index.js",
    "assets/icons/icon-32.png",
  ];
  for (const path of required) {
    try {
      await access(new URL(path, directory));
    } catch {
      failures.push(`${browser}: missing ${path}`);
    }
  }

  if (browser === "firefox" && manifest.manifest_version !== 2) {
    failures.push("firefox: expected Manifest V2");
  }
  if (browser === "chromium" && manifest.manifest_version !== 3) {
    failures.push("chromium: expected Manifest V3");
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Build validation passed");
}

