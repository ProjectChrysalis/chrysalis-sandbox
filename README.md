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
bun test
```

Point the engine at a local checkout with `CHRYSALIS_SANDBOX_DIR=/path/to/repo`.

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
