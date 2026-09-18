// The engine's page never imports the runtime: it posts commands here and gets
// results back. Keeping the GPL-2.0 runtime behind a worker boundary keeps the
// AGPL engine a separate program instead of a combined work; it is also the
// only entry the engine loads from this package.
import { exec } from "./sandbox.mjs";

// What release this worker loaded: the engine host compares it with the files
// it serves and replaces the worker when they differ, so an open tab picks up
// a new runtime without a page reload.
let runtimeVersion = null;
void fetch("/client/sandbox/k/sources.json", { cache: "no-cache" })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    runtimeVersion = typeof d?.runtime?.version === "string" ? d.runtime.version : null;
  })
  .catch(() => {
    /* the host treats a missing version as unknown, never as stale */
  });

self.onmessage = async (event) => {
  const message = event.data;
  if (!message || message.type !== "exec") return;
  const reply = { type: "result", id: message.id, runtime: runtimeVersion ?? undefined };
  try {
    const out = await exec(message.command, { files: message.files ?? {}, scratch: message.scratch ?? {}, gitProxy: message.gitProxy });
    Object.assign(reply, {
      exitCode: out.exitCode,
      stdout: out.stdout,
      stderr: out.stderr,
      files: out.files,
      scratch: out.scratch,
      wallMs: out.wallMs,
    });
  } catch (error) {
    Object.assign(reply, {
      exitCode: null,
      stdout: "",
      stderr: `sandbox error: ${(error && error.message) || error}`,
      files: {},
      scratch: {},
      wallMs: 0,
    });
  }
  self.postMessage(reply);
};
