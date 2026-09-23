// Preloaded into the session worker under Bun: a synchronous XMLHttpRequest
// for what a browser worker has and Bun does not. file: URLs read from disk
// (runtime assets, workspace files); the fake proxy at http://proxy.test/
// answers with a JSON echo of the request it was asked to make.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

class SyncRequest {
  open(method, url) {
    this.method = method;
    this.url = url;
    this.headers = {};
    this.responseHeaders = "";
  }
  setRequestHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }
  getAllResponseHeaders() {
    return this.responseHeaders;
  }
  send(body) {
    if (this.url.startsWith("file:")) {
      try {
        const u = new URL(this.url);
        const path = decodeURIComponent(fileURLToPath(`file://${u.pathname}`)) + (u.search ? decodeURIComponent(u.search.slice(1)) : "");
        const bytes = fs.readFileSync(path);
        if (process.env.SANDBOX_TRACE_READS) console.error(`read ${path}`);
        this.status = 200;
        this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } catch {
        this.status = 404;
        this.response = new ArrayBuffer(0);
      }
      return;
    }
    const target = decodeURIComponent(new URL(this.url).searchParams.get("url") ?? "");
    if (target.includes("unreachable.test")) {
      this.status = 502;
      this.responseHeaders = "x-chrysalis-proxy: error\r\n";
      this.response = new TextEncoder().encode("sandbox network: could not resolve unreachable.test").buffer;
      return;
    }
    const status = /status=(\d+)/.exec(target)?.[1];
    this.status = status ? Number(status) : 200;
    this.responseHeaders = "content-type: application/json\r\nx-test: yes\r\n";
    const echo = { method: this.method, url: target, headers: this.headers, body: body ? new TextDecoder().decode(body) : null };
    this.response = new TextEncoder().encode(JSON.stringify(echo)).buffer;
  }
}
globalThis.XMLHttpRequest = SyncRequest;
