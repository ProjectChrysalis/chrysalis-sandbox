// The shell: busybox ash instances over the session store, plus the host
// commands (git, python3, node, rg, jq, curl, ...) they can call. There is no
// fork, so a child command (a pipeline stage is not one; `bash x.sh`,
// `xargs cmd`, `find -exec`, awk's system() are) runs as a fresh instance on
// the same store and the same fds, and its status comes back synchronously.
import { WasiShim, WasiExit } from "../vendor/wasi-sh/src/shim.mjs";
import { completeImports } from "./wasi-extra.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

export const bytesOf = (b) => (typeof b === "string" ? encoder.encode(b) : b instanceof Uint8Array ? b : new Uint8Array(b));
export const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const envObject = (list) => {
  const out = {};
  for (const item of list) {
    const at = item.indexOf("=");
    if (at > 0) out[item.slice(0, at)] = item.slice(at + 1);
  }
  return out;
};
const joinPath = (cwd, p) => {
  const s = String(p);
  const raw = s.startsWith("/") ? s : `${String(cwd || "/").replace(/\/$/, "")}/${s}`;
  const out = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
};
export const resolvePath = joinPath;

/** An input over a reader that says EOF by returning nothing. */
const streamInput = (read) => {
  let eof = false;
  return {
    pollReadable: () => !eof,
    read(max) {
      if (eof) return EMPTY;
      const data = read(max);
      if (!data.length) eof = true;
      return data;
    },
    readBlocking(max) {
      return this.read(max);
    },
    wait() {},
    closed: () => eof,
  };
};
export const fixedInput = (bytes) => {
  let off = 0;
  return streamInput((max) => {
    const take = bytes.subarray(off, Math.min(bytes.length, off + max));
    off += take.length;
    return take;
  });
};

/** Bounded capture: the first and last `half` bytes of a stream, with the
 *  count of what fell out between them. */
export class Capture {
  constructor(half = 512 * 1024) {
    this.half = half;
    this.head = [];
    this.headBytes = 0;
    this.tail = [];
    this.tailBytes = 0;
    this.dropped = 0;
  }
  push(b) {
    const bytes = bytesOf(b);
    if (this.headBytes < this.half) {
      const take = bytes.subarray(0, this.half - this.headBytes);
      this.head.push(take.slice());
      this.headBytes += take.length;
      if (take.length === bytes.length) return;
      this.pushTail(bytes.subarray(take.length));
      return;
    }
    this.pushTail(bytes);
  }
  pushTail(bytes) {
    this.tail.push(bytes.slice());
    this.tailBytes += bytes.length;
    while (this.tailBytes - this.tail[0].length >= this.half) {
      this.dropped += this.tail[0].length;
      this.tailBytes -= this.tail.shift().length;
    }
  }
  text() {
    const join = (chunks) => decoder.decode(concat(chunks));
    if (!this.dropped) return join([...this.head, ...this.tail]);
    return `${join(this.head)}\n[... ${this.dropped} bytes of output dropped ...]\n${join(this.tail)}`;
  }
}

export function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Everything left on a builtin's stdin. */
export function readAll(ctx) {
  const chunks = [];
  for (;;) {
    const chunk = ctx.stdin(1 << 20);
    if (!chunk.length) break;
    chunks.push(chunk);
  }
  return concat(chunks);
}

// bash options a script sets on its interpreter line or command line, as the
// `set` commands ash understands.
const SET_FLAGS = new Set(["e", "u", "x", "v", "f", "n", "C", "a"]);
const CAPTURE_LIMIT = 64 * 1024 * 1024;

export class Shell {
  constructor({ store, busybox, env }) {
    this.store = store;
    this.busybox = busybox;
    this.env = env;
    this.commands = new Map();
    this.depth = 0;
    const self = this;
    this.provider = {
      lookup: (name) => self.commands.has(name) || name.includes("/"),
      run: (ctx) => self.dispatch(self.wrap(ctx)),
    };
    this.register({ bash: (ctx) => this.bash(ctx), sh: (ctx) => this.bash(ctx), dash: (ctx) => this.bash(ctx) });
  }

  register(handlers) {
    for (const [name, fn] of Object.entries(handlers)) this.commands.set(name, fn);
  }

  /** ctx as the shim builds it, plus what every command here needs. */
  wrap(ctx) {
    ctx.shell = this;
    ctx.store = this.store;
    ctx.args = ctx.argv.slice(1);
    ctx.resolve = (p) => joinPath(ctx.cwd, p);
    ctx.readAll = () => readAll(ctx);
    ctx.print = (text) => ctx.stdout(bytesOf(text));
    ctx.fail = (text, code = 1) => {
      ctx.stderr(bytesOf(`${text}\n`));
      return code;
    };
    return ctx;
  }

  dispatch(ctx) {
    const name = ctx.argv[0] ?? "";
    try {
      if (name.includes("/")) return this.script(ctx);
      const fn = this.commands.get(name);
      if (!fn) return ctx.fail(`${name}: not found`, 127);
      const code = fn(ctx);
      return typeof code === "number" ? code & 0xff : 0;
    } catch (error) {
      if (error instanceof WasiExit) return error.code;
      return ctx.fail(`${name}: ${(error && error.message) || error}`);
    }
  }

  /** One busybox instance, run to completion. */
  instance(args, { env, input, stdout, stderr }) {
    const shim = new WasiShim({ args, env, files: {}, fs: this.store, stdout, stderr, input, builtins: this.provider });
    const imports = completeImports(shim, shim.imports());
    imports.env.__host_spawn = (cwdPtr, argc, argvPtr, envpPtr) => {
      try {
        const argv = shim.cstrv(argvPtr, argc);
        return this.spawn(argv, {
          cwd: shim.cstr(cwdPtr) || "/",
          env: envObject(shim.cstrv(envpPtr)),
          stdin: (max) => shim.readFd(0, max, false).data.slice(),
          stdout: (b) => shim.writeFd(1, bytesOf(b)),
          stderr: (b) => shim.writeFd(2, bytesOf(b)),
        });
      } catch (error) {
        shim.writeFd(2, bytesOf(`${(error && error.message) || error}\n`));
        return 127;
      }
    };
    if (this.depth > 64) {
      stderr(bytesOf("sh: too many nested shells\n"));
      return 126;
    }
    this.depth++;
    try {
      const instance = new WebAssembly.Instance(this.busybox, imports);
      shim.bindMemory(instance.exports.memory);
      instance.exports._start();
      return 0;
    } catch (error) {
      if (error instanceof WasiExit) return error.code;
      if (error instanceof RangeError || /call stack|memory/i.test(String(error && error.message))) {
        stderr(bytesOf(`sh: ${error.message}\n`));
        return 2;
      }
      throw error;
    } finally {
      this.depth--;
    }
  }

  /** A script at the top level: the session's command line. */
  run(command, { cwd = "/workspace", env = this.env, stdin = EMPTY, stdout, stderr }) {
    // Same line as the command, so `line N` in an error is the command's own.
    const script = `cd -- ${quote(cwd)} || exit 1; ${command}`;
    return this.instance(["busybox", "ash", "-c", script], { env: { ...env, PWD: cwd }, input: fixedInput(stdin), stdout, stderr });
  }

  /** A child command from inside a running shell or builtin. */
  spawn(argv, { cwd, env, stdin, stdout, stderr }) {
    const ctx = this.wrap({ argv, cwd, env, stdin: stdin ?? (() => EMPTY), stdout, stderr, fs: null, interrupted: () => false });
    if (this.commands.has(argv[0]) || argv[0]?.includes("/")) return this.dispatch(ctx);
    // An applet or a shell builtin: a fresh instance runs exactly this argv.
    const script = `cd -- ${quote(cwd)} || exit 1; ${argv.map(quote).join(" ")}`;
    return this.instance(["busybox", "ash", "-c", script], {
      env: { ...env, PWD: cwd },
      input: streamInput(stdin ?? (() => EMPTY)),
      stdout,
      stderr,
    });
  }

  /** A child whose output comes back as bytes instead of reaching a stream:
   *  subprocess, child_process and os.popen. `command` goes through sh -c,
   *  `argv` runs as given; an unknown program is an error, not a status. */
  capture({ argv, command, args = [], cwd, env, stdin = EMPTY }) {
    const list = command !== undefined ? ["sh", "-c", command, ...args] : argv;
    if (!Array.isArray(list) || !list.length || !list[0]) return { error: "no command given" };
    const out = [];
    const err = [];
    let size = 0;
    const collect = (into) => (b) => {
      const bytes = bytesOf(b);
      size += bytes.length;
      if (size <= CAPTURE_LIMIT) into.push(bytes.slice());
    };
    let off = 0;
    const code = this.spawn(list, {
      cwd: cwd || "/workspace",
      env: env || this.env,
      stdin: (max) => {
        const take = stdin.subarray(off, Math.min(stdin.length, off + max));
        off += take.length;
        return take;
      },
      stdout: collect(out),
      stderr: collect(err),
    });
    const stderr = concat(err);
    if (command === undefined && code === 127 && decoder.decode(stderr).includes(`${list[0]}: not found`)) {
      return { error: `${list[0]}: command not found` };
    }
    return { code, stdout: concat(out), stderr };
  }

  /** bash/sh/dash: a nested ash in the caller's directory. bash-only syntax
   *  that ash lacks (arrays, `[[ =~ ]]`) is out of reach either way. */
  bash(ctx) {
    const args = ctx.args.slice();
    const sets = [];
    let command = null;
    let readStdin = false;
    while (args.length && args[0].startsWith("-") && args[0] !== "-" && args[0] !== "--") {
      const flag = args.shift();
      if (flag === "-c") {
        command = args.shift() ?? "";
        break;
      }
      if (flag === "-s") {
        readStdin = true;
        continue;
      }
      if (flag === "-o" || flag === "+o") {
        const option = args.shift();
        if (option) sets.push(`set ${flag} ${option}`);
        continue;
      }
      if (flag.startsWith("--")) continue; // --norc, --login, --posix
      for (const letter of flag.slice(1)) {
        if (letter === "c") {
          command = args.shift() ?? "";
        } else if (letter === "s") readStdin = true;
        else if (letter === "o") {
          const option = args.shift();
          if (option) sets.push(`set -o ${option}`);
        } else if (SET_FLAGS.has(letter)) sets.push(`set -${letter}`);
      }
      if (command !== null) break;
    }
    if (args[0] === "--") args.shift();
    const prefix = [`cd -- ${quote(ctx.cwd)} || exit 1`, ...sets].join("; ");
    let argv;
    if (command !== null) {
      argv = ["busybox", "ash", "-c", `${prefix}; ${command}`, ...args];
    } else if (args.length && !readStdin) {
      const script = ctx.resolve(args[0]);
      if (!this.store.isFile(script)) return ctx.fail(`${ctx.argv[0]}: ${args[0]}: No such file or directory`, 127);
      argv = ["busybox", "ash", "-c", `${prefix}; . ${quote(script)}`, ...args];
    } else {
      const text = decoder.decode(ctx.readAll());
      argv = ["busybox", "ash", "-c", `${prefix}; ${text}`, "bash", ...args];
    }
    return this.instance(argv, {
      env: { ...ctx.env, PWD: ctx.cwd },
      input: streamInput((max) => ctx.stdin(max)),
      stdout: (b) => ctx.stdout(b),
      stderr: (b) => ctx.stderr(b),
    });
  }

  /** ./script and /path/script: run by the interpreter its #! line names. */
  script(ctx) {
    const name = ctx.argv[0];
    const path = ctx.resolve(name);
    if (this.store.isDir(path)) return ctx.fail(`sh: ${name}: Is a directory`, 126);
    const bytes = this.store.readFile(path);
    if (!bytes) {
      // /usr/bin/python3, /bin/sh: the program itself, wherever it was looked for
      const base = name.split("/").pop();
      if (!/^\/(usr\/)?(local\/)?s?bin\/[^/]+$/.test(name) || !base) return ctx.fail(`sh: ${name}: not found`, 127);
      if (this.commands.has(base)) return this.dispatch(this.wrap({ ...ctx, argv: [base, ...ctx.args] }));
      return this.spawn([base, ...ctx.args], { cwd: ctx.cwd, env: ctx.env, stdin: ctx.stdin, stdout: ctx.stdout, stderr: ctx.stderr });
    }
    let interpreter = ["bash"];
    if (bytes[0] === 0x23 && bytes[1] === 0x21) {
      const end = bytes.indexOf(0x0a);
      const line = decoder.decode(bytes.subarray(2, end < 0 ? Math.min(bytes.length, 256) : end)).trim();
      const words = line.split(/\s+/).filter(Boolean);
      let program = (words.shift() ?? "").split("/").pop();
      if (program === "env") {
        while (words[0]?.startsWith("-")) words.shift();
        program = words.shift() ?? "";
      }
      if (/^python(\d(\.\d+)?)?$/.test(program)) program = "python3";
      if (program === "nodejs") program = "node";
      if (!this.commands.has(program)) return ctx.fail(`sh: ${name}: ${program || "interpreter"}: not found`, 127);
      interpreter = [program, ...words];
    }
    const argv = [...interpreter, path, ...ctx.args];
    return this.dispatch(this.wrap({ ...ctx, argv }));
  }
}
