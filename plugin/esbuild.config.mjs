import esbuild from "esbuild";
import process from "node:process";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2022",
  platform: "browser",
  sourcemap: prod ? false : "inline",
  logLevel: "info",
  treeShaking: true,
  minify: prod,
  loader: { ".worker.mjs": "text" },
  outfile: "main.js"
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
