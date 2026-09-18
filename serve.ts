/** Dev server for the sandbox runtime: plain files, no special headers. */
import fs from "node:fs";
import path from "node:path";

const root = import.meta.dir;
const PORT = Number(process.env.SANDBOX_PORT ?? 5499);

const TEST_SCRIPT = [
  "cat /workspace/hello.txt",
  "echo added >> /workspace/hello.txt",
  "git init",
  "echo hi > a.txt",
  "git add a.txt",
  "git commit -m one",
  "git log --oneline",
  "git status --short",
  "echo more >> a.txt",
  "git diff",
  "python3 -c 'print(2**10)'",
  "echo 'print(40+2)' > t.py",
  "python3 t.py",
  "python3 -c 'open(\"/workspace/py-out.txt\",\"w\").write(\"written by python\")'",
  "cat /workspace/py-out.txt; echo",
  "echo 'open(\"rel.txt\",\"w\").write(\"relative ok\")' > r.py",
  "python3 r.py",
  "cat rel.txt; echo",
  "node -e 'console.log(\"node\", 40+2)'",
  "echo 'var fs = require(\"fs\"); fs.writeFileSync(\"node-out.txt\", \"from node\"); console.log(\"script ok\");' > n.js",
  "node n.js",
  "cat node-out.txt; echo",
  "git clone https://github.com/octocat/Hello-World.git /workspace/hello-repo",
  "ls /workspace/hello-repo; echo",
  "cd /workspace/hello-repo && git log --oneline | head -2 && git remote -v",
  "echo CLONE-OK",
  "echo ALL-OK",
].join("\n");

const page = `<!doctype html><meta charset="utf-8"><title>sandbox runtime</title>
<body style="font:14px monospace;background:#111;color:#ddd">
<pre id="env"></pre><pre id="out">running...</pre>
<script type="module">
  document.getElementById("env").textContent = JSON.stringify({
    secure: isSecureContext, coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer,
  });
  const { exec } = await import("/runtime/sandbox.mjs");
  const enc = new TextEncoder();
  const script = ${JSON.stringify(TEST_SCRIPT)};
  try {
    const result = await exec(script, { files: { "/workspace/hello.txt": enc.encode("seed\\n") }, gitProxy: location.origin + "/cors?url=" });
    const changed = Object.entries(result.files)
      .map(([p, c]) => p + " (" + c.length + ")").slice(0, 12).join("\\n");
    document.getElementById("out").textContent =
      "exit " + result.exitCode + " in " + result.wallMs + "ms\\n" +
      result.stdout + (result.stderr ? "STDERR:\\n" + result.stderr : "") +
      "--- files after run:\\n" + changed;
  } catch (e) {
    document.getElementById("out").textContent = "FAILED: " + (e && e.message ? e.message : e);
  }
</script></body>`;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/cors") {
      const target = url.searchParams.get("url");
      if (!target) return new Response("missing url", { status: 400 });
      const drop = new Set(["host", "connection", "content-length", "accept-encoding", "origin", "referer", "cookie"]);
      const headers = new Headers();
      for (const [name, value] of request.headers) if (!drop.has(name.toLowerCase())) headers.set(name, value);
      if (!headers.has("user-agent")) headers.set("user-agent", "chrysalis-sandbox-dev/0.1");
      const method = request.method.toUpperCase();
      return fetch(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer(),
        redirect: "follow",
      });
    }
    const full = path.resolve(root, url.pathname.replace(/^\/+/, ""));
    if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      return new Response("not found", { status: 404 });
    }
    return new Response(new Uint8Array(fs.readFileSync(full)), {
      headers: { "content-type": MIME[path.extname(full)] ?? "application/octet-stream" },
    });
  },
});
console.log(`sandbox runtime dev server on http://127.0.0.1:${PORT}/ (no COOP/COEP)`);
