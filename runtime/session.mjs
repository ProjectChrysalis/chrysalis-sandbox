// The sandbox session: the one module an embedder loads, as a worker. It
// keeps one filesystem for the worker's life (the workspace mounted at
// /workspace, scratch space at /tmp) and runs commands against it.
//
// The embedder never links this code: it posts messages and reads replies,
// which keeps the GPL-2.0 runtime a separate program from whatever drives it.
//
//   -> { type: "exec", id, command, cwd?, sync, config }
//        sync:   { files: [[path, size, mtimeMs]], deletes: [path], reset? }
//                workspace paths, relative; file bytes are fetched lazily
//                from config.fileUrl + encodeURIComponent(path) on first read
//        config: { fileUrl, proxy, env?, hidden? }
//                hidden: patterns (RegExp sources) of workspace paths the
//                engine keeps out of the sandbox; git does not call them deleted
//   <- { type: "result", id, exitCode, stdout, stderr, writes: [[path, bytes]],
//        deletes: [path], wallMs, runtime }
//   <- { type: "ready", runtime } once the shell can run, { type: "fatal", error }
//
// A command that never returns can only be stopped by terminating the worker;
// the embedder does that and starts a fresh one (sync.reset re-mounts).
import { Store } from "./store.mjs";
import { Shell, Capture } from "./shell.mjs";
import { makeNet } from "./net.mjs";
import { fetchSync, preloadWasm } from "./loader.mjs";
import { makeTools, preloadTools } from "./tools.mjs";
import { gitCommands } from "./git.mjs";
import { preloadLg2 } from "./lg2.mjs";
import { nodeCommands, preloadNode } from "./node.mjs";
import { preloadPython, pythonCommands } from "./python.mjs";

const BUSYBOX = "vendor/wasi-sh/dist/busybox.wasm";
const LG2 = "vendor/wasm-git/lg2.wasm";
const WORKSPACE = "/workspace";

let runtimeVersion = null;
let session = null;
/** Workspace paths the engine has: a delete of anything else is a file that
 *  came and went inside one command (a lock file) and is not reported. */
const known = new Set();
let fileUrl = null;
const net = { current: makeNet({}) };
const netProxy = { request: (req) => net.current.request(req) };

async function boot() {
  const version = fetch(new URL("../sources.json", import.meta.url))
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (runtimeVersion = d?.runtime?.version ?? null))
    .catch(() => null);
  const [busybox, lg2] = await Promise.all([preloadWasm(BUSYBOX), preloadWasm(LG2)]);
  await Promise.all([preloadLg2(lg2), preloadNode(), preloadTools(), version]);
  const store = new Store();
  store.fetchContent = (rel) => {
    const res = fetchSync(fileUrl + encodeURIComponent(rel));
    if (res.status !== 200) {
      const error = new Error(`${rel}: could not be read (HTTP ${res.status})`);
      error.code = "EIO";
      throw error;
    }
    return res.body;
  };
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: WORKSPACE, USER: "sandbox", LOGNAME: "sandbox", SHELL: "/bin/sh", TERM: "dumb", LANG: "C.UTF-8", TMPDIR: "/tmp" };
  const shell = new Shell({ store, busybox, env });
  shell.register(makeTools({ store, net: netProxy, shell }));
  shell.register(gitCommands({ store, net: netProxy, shell }));
  shell.register(nodeCommands({ store, net: netProxy, shell }));
  shell.register(pythonCommands({ store, net: netProxy, shell }));
  session = { store, shell, env };
  // Python is the largest part of the runtime and the least often needed:
  // fetch it once the shell is up, so the first python3 rarely waits.
  setTimeout(() => preloadPython().catch(() => {}), 0);
  self.postMessage({ type: "ready", runtime: runtimeVersion });
}

const ready = boot().catch((error) => {
  self.postMessage({ type: "fatal", error: String((error && error.message) || error) });
  throw error;
});

function applySync(store, sync) {
  if (!sync) return;
  store.quietly(() => {
    if (sync.reset) {
      store.remove(WORKSPACE);
      store.mkdirp(WORKSPACE);
      known.clear();
    }
    for (const path of sync.deletes ?? []) {
      store.remove(`${WORKSPACE}/${path}`);
      known.delete(path);
    }
    for (const [path, size, mtimeMs] of sync.files ?? []) {
      store.lazy(`${WORKSPACE}/${path}`, size, mtimeMs, path);
      known.add(path);
      // Only files are synced, and a repository whose refs were all packed
      // has an empty refs/ that git needs to see to call it a repository.
      if (path === ".git/HEAD" || path.endsWith("/.git/HEAD")) {
        const gitDir = `${WORKSPACE}/${path.slice(0, -"HEAD".length)}`;
        for (const dir of ["refs/heads", "refs/tags", "objects/info", "objects/pack"]) store.mkdirp(gitDir + dir);
      }
    }
  });
}

function exec(message) {
  const { store, shell, env } = session;
  const started = performance.now();
  fileUrl = message.config?.fileUrl ?? fileUrl;
  if (Array.isArray(message.config?.hidden)) store.hiddenPaths = message.config.hidden.map((source) => new RegExp(source, "i"));
  net.current = makeNet({ proxy: message.config?.proxy ?? null });
  applySync(store, message.sync);
  store.takeChanges();
  const stdout = new Capture();
  const stderr = new Capture();
  let exitCode;
  try {
    exitCode = shell.run(message.command, {
      cwd: message.cwd ?? WORKSPACE,
      env: { ...env, ...(message.config?.env ?? {}) },
      stdout: (b) => stdout.push(b),
      stderr: (b) => stderr.push(b),
    });
  } catch (error) {
    stderr.push(`sandbox: ${(error && error.stack) || error}\n`);
    exitCode = 125;
  }
  const { writes, deletes } = store.takeChanges();
  const workspaceWrites = [];
  const workspaceDeletes = [];
  const prefix = `${WORKSPACE}/`;
  for (const [path, bytes] of writes) {
    // git's sample hooks stay here: the engine refuses hooks from the sandbox
    if (!path.startsWith(prefix) || /(^|\/)\.git\/hooks\//.test(path)) continue;
    workspaceWrites.push([path.slice(prefix.length), bytes]);
    known.add(path.slice(prefix.length));
  }
  for (const path of deletes) {
    const rel = path.slice(prefix.length);
    if (!path.startsWith(prefix) || !known.has(rel)) continue;
    workspaceDeletes.push(rel);
    known.delete(rel);
  }
  self.postMessage(
    {
      type: "result",
      id: message.id,
      exitCode,
      stdout: stdout.text(),
      stderr: stderr.text(),
      writes: workspaceWrites,
      deletes: workspaceDeletes,
      wallMs: Math.round(performance.now() - started),
      runtime: runtimeVersion,
    },
    workspaceWrites.map(([, bytes]) => bytes.buffer),
  );
}

self.onmessage = async (event) => {
  const message = event.data;
  if (!message || message.type !== "exec") return;
  try {
    await ready;
  } catch (error) {
    self.postMessage({ type: "result", id: message.id, exitCode: null, stdout: "", stderr: `sandbox: the runtime did not start: ${(error && error.message) || error}\n`, writes: [], deletes: [], wallMs: 0, runtime: runtimeVersion });
    return;
  }
  exec(message);
};
