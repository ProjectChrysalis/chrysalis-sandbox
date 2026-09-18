// Bundle entry: QuickJS (ng, sync wasm file variant) for the sandbox's node
// builtin. scripts/build-quickjs.ts bundles this and copies the wasm beside it.
import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

export { newQuickJSWASMModuleFromVariant, variant };
