# Sandbox

**The agent's shell for [Chrysalis](https://github.com/ProjectChrysalis/Chrysalis-Engine).**

## Build

```
bun install
bun run release     # builds vendor/python, tests, writes sandbox-<version>.zip + SHA256SUMS
```

The other wasm binaries are checked in. `build:busybox` and `build:jq`
rebuild them (zig and the wasi-sdk sysroot); `build:quickjs` re-vendors the
QuickJS bundle and fflate from `node_modules`. The engine fetches the pinned release with
`bun run sandbox:fetch`; packaged installs ship it in
`resources/prebuilt/sandbox-k`.

## Develop

```
bun run build:python   # once, before tests
bun run test
```

Point the engine at a local checkout with `CHRYSALIS_SANDBOX_DIR=/path/to/repo`.

Heredocs and here strings use buffered pipes at every size. Scripts larger
than 4 KiB can run directly or be saved in `/tmp` for later commands.
`git diff` accepts file paths with or without `--`, including staged diffs,
patches, file lists and statistics from the workspace or a subdirectory.

Git includes two-commit `merge-base` (`--all` and `--is-ancestor`) and
`check-ignore` (`-v`, `-q`, `--stdin`, `-z`, `-n`, `--no-index`). Ignore
checks use the repository's index, `.gitignore` files, `.git/info/exclude`
and its configured `core.excludesFile`, all inside the virtual filesystem.
Other merge-base modes are refused explicitly. `reflog`, `symbolic-ref` and
`count-objects` read the repository directly. `rg` searches piped or
redirected input, or explicit `-`, without scanning the workspace.

The development shell supports process substitution (`<(...)`, `>(...)`),
indexed and associative arrays, brace expansion, `[[ ]]`, arithmetic commands
and loops, regex captures, case conversion, `mapfile`, `read -a`, `printf -v`
and `%q`. `PIPESTATUS` and `set -o pipefail` report pipeline results.
`shopt` implements `nullglob`, `dotglob` and `failglob`; unavailable options
such as `globstar` and `extglob` fail explicitly when enabled. Name references
(`declare -n`) are unavailable. `column` formats tables and lists; `less` and
`more` emit their input without waiting for terminal interaction. Interactive
editors and process-table commands report their limits explicitly. GNU-only command options are not universal
(use `ls -l --full-time` for full timestamps).

Fractional `sleep` durations work. `date -d` and `touch -d` accept relative
dates such as `yesterday` and `2 days ago`. `/dev/zero`, `/dev/random` and
`/dev/urandom` read as expected. `touch`, `mktemp` and `nproc` run through the
host command bridge, including from `xargs` and `find -exec`. Temporary files
use mode 0600 and directories 0700. `nproc` reports the one worker executing
commands, independently of the computer's core count.

There is no fork or concurrent process scheduler. Background jobs finish
before the next command runs; `$!` and `wait` refer to those completed jobs.
`nohup` runs its command in the current session. Pipeline stages and process
substitutions use buffered pipes, limited to 64 MiB or one million writes.
Exceeding a pipe limit stops its writer with status 141 and a diagnostic.
Brace expansions over 100,000 words fail rather than returning a partial list.

`timeout` enforces cooperative deadlines for shell loops and applets,
including nested shells. It cannot forcibly interrupt arbitrary Python or
JavaScript computation. The embedder's per-command timeout remains the hard
limit: it stops the worker and starts a fresh one for the next command,
discarding unsaved changes and scratch files.

These shell additions require sandbox 0.4.4. Engines fetch their pinned
sandbox version; use `CHRYSALIS_SANDBOX_DIR` to try a local checkout.

## Built with

| Project | What it does here | License |
| --- | --- | --- |
| [wasi-sh](https://github.com/alganet/wasi-sh) | Fork-free WASI runtime: wasm instantiation, in-memory FS, host builtins | ISC |
| [busybox](https://busybox.net) | The shell and coreutils applets, compiled to wasm32-wasi | GPL-2.0-only |
| [wasm-git](https://github.com/petersalomonsen/wasm-git) | Real git in the browser (libgit2's CLI, sync build) | GPL-2.0-only |
| [libgit2](https://libgit2.org) | The git implementation behind wasm-git | GPL-2.0-only with linking exception |
| [CPython](https://www.python.org) | `python3` (official WASI build, stdlib as bytecode) | PSF-2.0 |
| [jq](https://jqlang.org) | `jq`, compiled to wasm32-wasi with oniguruma | MIT, BSD-2-Clause |
| [QuickJS-ng](https://github.com/quickjs-ng/quickjs) | `node`: JS engine plus a small Node surface | MIT |
| [fflate](https://github.com/101arrowz/fflate) | tar/gzip/zip builtins | MIT |

Versions, origins and license files: `sources.json`.

## License

GPL-2.0-only. The runtime links busybox and wasm-git, both GPL-2.0-only, so
that is the license the combined work carries. Chrysalis Engine stays a
separate program under its own license and drives this runtime through a
worker boundary (`runtime/session.mjs`).

The release also provides [source and build materials](https://github.com/ProjectChrysalis/chrysalis-sandbox/releases/download/v0.4.4/sandbox-0.4.4-sources.zip): the release source tree, pinned upstream sources, configurations, patches and build scripts. The source archive has a separate `SOURCE_SHA256SUMS`.
