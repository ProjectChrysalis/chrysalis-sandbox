// Drives the real session worker the way the engine's host does: a mounted
// workspace (a temp folder, read lazily), one command per exec, and the
// changes the worker reports applied back to that folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNTIME = new URL("../runtime/session.mjs", import.meta.url);
const PRELOAD = new URL("./worker-env.mjs", import.meta.url).pathname;

export class Sandbox {
  constructor(files = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-test-"));
    for (const [rel, content] of Object.entries(files)) this.put(rel, content);
    this.worker = new Worker(RUNTIME, { type: "module", preload: [PRELOAD] });
    this.waiting = new Map();
    this.seq = 0;
    this.known = new Map();
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "result") this.waiting.get(m.id)?.(m);
    };
  }
  put(rel, content) {
    const full = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  read(rel) {
    const full = path.join(this.dir, rel);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  }
  list() {
    const out = [];
    const walk = (d, r) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = r ? `${r}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), rel);
        else out.push(rel);
      }
    };
    walk(this.dir, "");
    return out.sort();
  }
  sync() {
    const now = new Map();
    for (const rel of this.list()) {
      const st = fs.statSync(path.join(this.dir, rel));
      now.set(rel, [st.size, st.mtimeMs]);
    }
    const files = [];
    for (const [rel, meta] of now) {
      const old = this.known.get(rel);
      if (!old || old[0] !== meta[0] || old[1] !== meta[1]) files.push([rel, meta[0], meta[1]]);
    }
    const deletes = [...this.known.keys()].filter((rel) => !now.has(rel));
    this.known = now;
    return { files, deletes };
  }
  run(command, { timeout = 60_000 } = {}) {
    const id = ++this.seq;
    const message = { type: "exec", id, command, sync: this.sync(), config: { fileUrl: `file://${this.dir}/?`, proxy: "http://proxy.test/?url=" } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out: ${command}`)), timeout);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        for (const [rel, bytes] of m.writes) {
          this.put(rel, Buffer.from(bytes));
          const st = fs.statSync(path.join(this.dir, rel));
          this.known.set(rel, [st.size, st.mtimeMs]);
        }
        for (const rel of m.deletes) {
          fs.rmSync(path.join(this.dir, rel), { force: true });
          this.known.delete(rel);
        }
        resolve({ code: m.exitCode, out: m.stdout, err: m.stderr, writes: m.writes.map(([p]) => p), deletes: m.deletes, ms: m.wallMs });
      });
      this.worker.postMessage(message);
    });
  }
  close() {
    this.worker.terminate();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
