// Keep Shiki's engine initialization in its existing callers, while packaging
// the binary once instead of embedding base64 in every independent bundle.
export function sharedShikiWasmPlugin(target) {
  const sources = {
    browser: 'new URL("./onig.wasm", import.meta.url)'
  };
  const contents = target === 'node'
    ? `import { readFile } from 'node:fs/promises';
       import { join } from 'node:path';
       export default async imports => WebAssembly.instantiate(
         await readFile(join(__meoExportRuntimeDir, '../webview/dist/onig.wasm')), imports);`
    : target === 'worker'
    ? `export default async function instantiateWasm(imports) {
         // VS Code's resource proxy cannot serve fetches from a Blob worker.
         // The worker entry exposes its first message's transferred bytes only
         // while this engine initializes; compilation stays off the UI thread.
         if (!globalThis.__meoShikiWasmBytes) throw new Error('Missing syntax highlighting WASM');
         return WebAssembly.instantiate(globalThis.__meoShikiWasmBytes, imports);
       }`
    : `export default async function instantiateWasm(imports) {
         const response = await fetch(${sources[target]});
         if (!response.ok) throw new Error('Could not load syntax highlighting WASM');
         return WebAssembly.instantiate(await response.arrayBuffer(), imports);
       }`;
  return {
    name: 'shared-shiki-wasm',
    setup(build) {
      build.onResolve({ filter: /^shiki\/wasm$/ }, () => ({ path: 'wasm', namespace: 'shared-shiki' }));
      build.onLoad({ filter: /.*/, namespace: 'shared-shiki' }, () => ({ contents, loader: 'js' }));
    }
  };
}
