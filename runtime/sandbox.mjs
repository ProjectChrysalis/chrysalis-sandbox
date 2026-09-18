// Page-side sandbox helper: one worker per command, mounts files in, returns
// output plus the resulting file tree. No SharedArrayBuffer, no headers.
const DEFAULT_WASM = new URL("../vendor/wasi-sh/dist/busybox.wasm", import.meta.url).href;
const DEFAULT_WORKER = new URL("./worker.mjs", import.meta.url).href;

function workerChannel(worker) {
  const queue = [];
  const waiters = new Set();
  const notify = () => {
    for (const check of [...waiters]) check();
  };
  worker.onmessage = (event) => {
    queue.push(event.data);
    notify();
  };
  worker.onerror = (event) => {
    queue.push({ type: "error", msg: event.message || "worker error" });
    notify();
  };
  const take = (predicate) => {
    const index = queue.findIndex(predicate);
    return index >= 0 ? queue.splice(index, 1)[0] : null;
  };
  return {
    take,
    wait(predicate, timeoutMs = 120_000) {
      const existing = take(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`sandbox timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const check = () => {
          const item = take(predicate);
          if (!item) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(item);
        };
        waiters.add(check);
        check();
      });
    },
  };
}

const DEFAULT_ENV = { PATH: "/", HOME: "/workspace", TERM: "dumb", LANG: "C.UTF-8" };
const DEFAULT_MOUNT = "/workspace";

export async function exec(command, options = {}) {
  const mount = options.mount ?? DEFAULT_MOUNT;
  const workerUrl = new URL(options.workerUrl ?? DEFAULT_WORKER, location.href);
  if (options.gitProxy) workerUrl.searchParams.set("gitProxy", options.gitProxy);
  const worker = new Worker(workerUrl.href, { type: "module" });
  const channel = workerChannel(worker);
  const stdout = [];
  const stderr = [];
  const started = performance.now();

  const wasmBytes = await fetch(options.wasmUrl ?? DEFAULT_WASM).then((response) => {
    if (!response.ok) throw new Error(`sandbox wasm: HTTP ${response.status}`);
    return response.arrayBuffer();
  });

  const files = {};
  for (const [path, content] of Object.entries(options.files ?? {})) {
    const clean = path.replace(/\/+/g, "/");
    const guest = clean === mount || clean.startsWith(`${mount}/`) ? clean : `${mount}/${clean.replace(/^\/+/, "")}`;
    files[guest] = content instanceof Uint8Array ? content : new TextEncoder().encode(String(content));
  }

  // The busybox build has no fancy echo: `echo -n` would print a literal -n,
  // which breaks scripts. Define a POSIX-ish echo up front so every command
  // in this session sees the expected behavior.
  const ECHO_SHIM = [
    "echo() {",
    "  nl=1; esc=0",
    "  while [ $# -gt 0 ]; do",
    "    case $1 in",
    "      -n) nl=0 ;;",
    "      -e) esc=1 ;;",
    "      -en|-ne) nl=0; esc=1 ;;",
    "      *) break ;;",
    "    esac",
    "    shift",
    "  done",
    "  if [ $esc = 1 ]; then printf '%b' \"$*\"; else printf '%s' \"$*\"; fi",
    "  [ $nl = 1 ] && printf '\\n'",
    "  return 0",
    "}",
  ].join("\n");
  const script = options.args ? null : `cd ${mount}\n${ECHO_SHIM}\n${command ?? ""}`;
  worker.postMessage(
    {
      wasmBytes,
      files,
      args: options.args ?? ["busybox", "sh", "-c", script],
      env: { ...DEFAULT_ENV, PWD: mount, ...(options.env ?? {}) },
      requests: [],
    },
    [wasmBytes],
  );

  let exitCode = 0;
  for (;;) {
    const item = await channel.wait((data) => data && (data.type === "out" || data.type === "exit" || data.type === "error"));
    if (item.type === "out") {
      (item.channel === "stderr" ? stderr : stdout).push(new Uint8Array(item.bytes));
    } else if (item.type === "error") {
      worker.terminate();
      throw new Error(item.msg);
    } else {
      exitCode = item.code;
      break;
    }
  }

  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sandbox snapshot timed out")), 30_000);
    worker.addEventListener("message", (event) => {
      if (event.data?.type !== "snapshot") return;
      clearTimeout(timer);
      resolve(event.data.files);
    });
    worker.postMessage({ type: "snapshot" });
  }).finally(() => worker.terminate());

  const decode = (chunks) => new TextDecoder().decode(concat(chunks));
  const out = {};
  for (const file of snapshot) {
    if (!file.path.startsWith(`${mount}/`)) continue;
    out[file.path.slice(mount.length + 1)] = file.content;
  }
  return {
    exitCode,
    stdout: decode(stdout),
    stderr: decode(stderr),
    files: out,
    wallMs: Math.round(performance.now() - started),
  };
}

function concat(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}
