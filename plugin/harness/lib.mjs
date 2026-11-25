import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const require = createRequire(import.meta.url);
const here = path.dirname(url.fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const repoDir = path.resolve(pluginDir, "..");
const outRoot = path.join(here, "out");

const puppeteer = require("/Users/liufenghua/Documents/Codex/2026-11-25/z-g/build/node_modules/puppeteer");

export async function build() {
  await esbuild.build({
    entryPoints: [path.join(pluginDir, "src/dev/harness.ts")],
    bundle: true,
    format: "iife",
    target: "es2022",
    outfile: path.join(here, "harness.js"),
    logLevel: "error",
  });
  await esbuild.build({
    entryPoints: [path.join(pluginDir, "src/dev/node-core.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "es2022",
    outfile: path.join(here, "node-core.cjs"),
    logLevel: "error",
  });
}

export function readMd(p) {
  return fs.readFileSync(p, "utf8");
}

export function makePage(browser) {
  return browser.newPage();
}

export async function preparePage(page, payload) {
  await page.setViewport({ width: 1400, height: 1800, deviceScaleFactor: 1 });
  const fileUrl = url.pathToFileURL(path.join(here, "index.html")).href;
  await page.goto(fileUrl, { waitUntil: "load" });
  await page.evaluate((base) => {
    const b = document.createElement("base");
    b.href = base;
    document.head.prepend(b);
  }, url.pathToFileURL(path.join(repoDir, "samples") + "/").href);
  const info = await page.evaluate((p) => window.NTB.prepare(p), payload);
  return info;
}

export async function shootPages(page, dir, limit = 99, tag = "page") {
  fs.mkdirSync(dir, { recursive: true });
  const handles = await page.$$("#preview .ntb-page");
  const files = [];
  for (let i = 0; i < Math.min(handles.length, limit); i++) {
    const f = path.join(dir, `${tag}-${String(i + 1).padStart(2, "0")}.png`);
    await handles[i].screenshot({ path: f });
    files.push(f);
  }
  return files;
}

export async function printPdf(page, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.evaluate(() => window.NTB.preparePrint());
  await page.emulateMediaType("print");
  await page.pdf({
    path: file,
    preferCSSPageSize: true,
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  await page.emulateMediaType("screen");
  return file;
}

export { path, fs, url, pluginDir, repoDir, outRoot, here };
