/** Packs the runtime plus its vendored shell into the release zip. */
import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";

const root = path.resolve(import.meta.dir, "..");
const version = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;

const files: Record<string, Uint8Array> = {};
const walk = (dir: string, rel: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(full, name);
    else files[name] = new Uint8Array(fs.readFileSync(full));
  }
};
walk(path.join(root, "runtime"), "runtime");
walk(path.join(root, "vendor"), "vendor");
for (const name of ["LICENSE", "sources.json"]) {
  files[name] = new Uint8Array(fs.readFileSync(path.join(root, name)));
}

const zip = zipSync(files, { level: 6 });
const out = path.join(root, `sandbox-${version}.zip`);
fs.writeFileSync(out, zip);
const hash = new Bun.CryptoHasher("sha256").update(zip).digest("hex");
fs.writeFileSync(path.join(root, "SHA256SUMS"), `${hash}  sandbox-${version}.zip\n`);
console.log(`packed sandbox-${version}.zip (${(zip.byteLength / 1e6).toFixed(2)}MB) sha256 ${hash}`);
