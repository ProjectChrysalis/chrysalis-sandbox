/** Bundles QuickJS for the node builtin and copies its wasm beside the bundle. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const root = path.resolve(import.meta.dir, "..");
const require = createRequire(import.meta.url);
const variantDir = path.dirname(require.resolve("@jitl/quickjs-ng-wasmfile-release-sync/package.json"));
const outdir = path.join(root, "vendor", "quickjs");
fs.mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [path.join(root, "runtime", "quickjs-entry.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  outfile: path.join(outdir, "quickjs.mjs"),
  nodePaths: [path.join(root, "node_modules")],
  logLevel: "silent",
});

fs.copyFileSync(path.join(variantDir, "dist", "emscripten-module.wasm"), path.join(outdir, "emscripten-module.wasm"));
const fflateDir = path.join(root, "vendor", "fflate");
fs.mkdirSync(fflateDir, { recursive: true });
fs.copyFileSync(require.resolve("fflate/esm/browser.js"), path.join(fflateDir, "fflate.mjs"));
console.log(
  `vendored quickjs.mjs + emscripten-module.wasm (${(fs.statSync(path.join(outdir, "quickjs.mjs")).size / 1024).toFixed(0)}KB + ${(fs.statSync(path.join(outdir, "emscripten-module.wasm")).size / 1024).toFixed(0)}KB) and fflate.mjs (${(fs.statSync(path.join(fflateDir, "fflate.mjs")).size / 1024).toFixed(0)}KB)`,
);
