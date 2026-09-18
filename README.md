# Sandbox

**The agent's shell for [Chrysalis](https://github.com/ProjectChrysalis/Chrysalis-Engine).**

## Build

```
bun install
bun run pack        # writes sandbox-<version>.zip + SHA256SUMS
```

`scripts/build-quickjs.ts` re-vendors the QuickJS bundle and fflate from
`node_modules`. The engine fetches the pinned release with
`bun run sandbox:fetch`; packaged installs ship it in
`resources/prebuilt/sandbox-k`.

## Develop

```
bun run dev         # http://127.0.0.1:5499, plain files, no COOP/COEP
```

Point the engine at a local checkout with `CHRYSALIS_SANDBOX_DIR=/path/to/repo`.

## Built with

| Project | What it does here | License |
| --- | --- | --- |
| [wasi-sh](https://github.com/alganet/wasi-sh) | Fork-free WASI runtime: wasm instantiation, in-memory FS, host builtins | ISC |
| [busybox](https://busybox.net) | The shell and coreutils applets, compiled to wasm32-wasi | GPL-2.0-only |
| [wasm-git](https://github.com/petersalomonsen/wasm-git) | Real git in the browser (libgit2's CLI, sync build) | GPL-2.0-only |
| [libgit2](https://libgit2.org) | The git implementation behind wasm-git | GPL-2.0-only with linking exception |
| [MicroPython](https://micropython.org) | `python3` (WASI build) | MIT |
| [QuickJS-ng](https://github.com/quickjs-ng/quickjs) | `node`: JS engine plus a small Node surface | MIT |
| [fflate](https://github.com/101arrowz/fflate) | tar/gzip/zip builtins | MIT |

Versions, origins and license files: `sources.json`.

## License

GPL-2.0-only. The runtime links busybox and wasm-git, both GPL-2.0-only, so
that is the license the combined work carries. Chrysalis Engine stays a
separate program under its own license and drives this runtime through a
worker boundary (`runtime/exec-worker.mjs`).
