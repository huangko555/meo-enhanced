import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const lucidePackage = createRequire(import.meta.url).resolve('lucide/package.json');
const lucideEntry = resolve(dirname(lucidePackage), JSON.parse(readFileSync(lucidePackage, 'utf8')).module);

// Node's default main-field order selects Lucide's CommonJS icon catalogue.
// Use its published ESM entry so the five named icons can be tree-shaken,
// while retaining self-contained CommonJS output for the installed extension.
const lucidePlugin = { name: 'export-lucide-esm', setup(build) {
  build.onResolve({ filter: /^lucide$/ }, () => ({ path: lucideEntry }));
} };

// Keep the complete fallback grammar catalogue out of text-only Preview startup.
// The synchronous require runs only when a requested block needs that renderer.
const fallbackPlugin = { name: 'export-fallback-boundary', setup(build) {
  build.onResolve({ filter: /^\.\/fallbackCodeHighlighter$/ }, () => ({
    path: './fallback-code-highlighter.js', external: true
  }));
} };

for (const [entry, output] of [
  ['runtime.ts', 'export-runtime.js'],
  ['previewRenderWorker.ts', 'preview-render-worker.js'],
  ['fallbackCodeHighlighter.ts', 'fallback-code-highlighter.js']
]) {
  const result = await Bun.build({
    entrypoints: [resolve(root, 'src/export', entry)],
    target: 'node', format: 'cjs', minify: true, plugins: [lucidePlugin, fallbackPlugin]
  });
  if (!result.success) throw new AggregateError(result.logs, `${output} build failed`);
  if (result.outputs.length !== 1) throw new Error(`${output} must be emitted as one bundle`);
  await Bun.write(resolve(root, 'dist', output), result.outputs[0]);
  console.log(`Built ${output} (${result.outputs[0].size} bytes)`);
}
