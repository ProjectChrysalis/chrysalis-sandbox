// Runtime assets (wasm modules, the Python standard library) resolved next to
// this file. Everything preloads asynchronously when the session starts; a
// command that needs something before its preload finished fetches it
// synchronously instead (allowed in a worker), so no command waits on a
// guess about what it will run.
const root = new URL("../", import.meta.url);

export const assetUrl = (rel) => new URL(rel, root).href;

const modules = new Map();
const bytes = new Map();
const pending = new Map();

/** Bytes of a URL, synchronously. Workers allow a blocking request. */
export function fetchSync(url, { method = "GET", headers = [], body = null } = {}) {
  const xhr = new XMLHttpRequest();
  xhr.open(method, url, false);
  xhr.responseType = "arraybuffer";
  for (const [name, value] of headers) xhr.setRequestHeader(name, value);
  xhr.send(body);
  return { status: xhr.status, headers: xhr.getAllResponseHeaders(), body: new Uint8Array(xhr.response ?? new ArrayBuffer(0)) };
}

const fetchAssetSync = (rel) => {
  const res = fetchSync(assetUrl(rel));
  if (res.status !== 200) throw new Error(`${rel}: HTTP ${res.status}`);
  return res.body;
};

export function bytesSync(rel) {
  let b = bytes.get(rel);
  if (!b) {
    b = fetchAssetSync(rel);
    bytes.set(rel, b);
  }
  return b;
}

export function wasmSync(rel) {
  let m = modules.get(rel);
  if (!m) {
    m = new WebAssembly.Module(fetchAssetSync(rel));
    modules.set(rel, m);
  }
  return m;
}

const once = (key, start) => {
  if (!pending.has(key)) pending.set(key, start().catch((error) => {
    pending.delete(key);
    throw error;
  }));
  return pending.get(key);
};

export function preloadWasm(rel) {
  if (modules.has(rel)) return Promise.resolve(modules.get(rel));
  return once(`wasm:${rel}`, async () => {
    const res = await fetch(assetUrl(rel));
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    let m;
    try {
      m = await WebAssembly.compileStreaming(res.clone());
    } catch {
      m = await WebAssembly.compile(await res.arrayBuffer());
    }
    modules.set(rel, m);
    return m;
  });
}

export function preloadBytes(rel) {
  if (bytes.has(rel)) return Promise.resolve(bytes.get(rel));
  return once(`bytes:${rel}`, async () => {
    const res = await fetch(assetUrl(rel));
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    const b = new Uint8Array(await res.arrayBuffer());
    bytes.set(rel, b);
    return b;
  });
}
