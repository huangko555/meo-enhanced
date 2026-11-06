// Keep Shiki's engine initialization in its existing callers, while packaging
// the binary once instead of embedding base64 in every independent bundle.
export function sharedShikiWasmPlugin(target) {
  const sources = {
    browser: 'new URL("./onig.wasm", import.meta.url)',
    // The classic worker runs from a Blob. Its owner supplies the original
    // resource URL before evaluating the bundle.
    worker: '__meoShikiWasmUri'
  };
  const contents = target === 'node'
    ? `import { readFile } from 'node:fs/promises';
       import { join } from 'node:path';
       export default async imports => WebAssembly.instantiate(
         await readFile(join(__meoExportRuntimeDir, '../webview/dist/onig.wasm')), imports);`
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
