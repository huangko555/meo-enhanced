import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import darkPlus from '@shikijs/themes/dark-plus';
import { bundledLanguagesInfo } from 'shiki/langs';
import type { CodeThemeDto } from '../src/protocol/hostConfigurationEvents';

type LanguageAssetManifest = Readonly<{
  version: 1;
  languages: readonly Readonly<{
    id: string;
    aliases: readonly string[];
    module: string;
  }>[];
}>;

type ExportRuntime = Readonly<{
  renderExportHtmlDocument(options: Record<string, unknown>): Promise<{ htmlDocument: string }>;
}>;

const repoRoot = path.resolve(import.meta.dir, '..');
const webviewDist = path.join(repoRoot, 'webview', 'dist');
const manifestPath = path.join(webviewDist, 'shiki-language-assets.json');
const moduleScopePath = path.join(webviewDist, 'package.json');
const exportRuntimePath = path.join(repoRoot, 'dist', 'export-runtime.js');

assert.equal(existsSync(manifestPath), true, 'Webview build must emit the Shiki language asset manifest');
assert.deepEqual(
  JSON.parse(readFileSync(moduleScopePath, 'utf8')),
  { type: 'module' },
  'Webview language chunks must have an explicit ESM scope for the Node export runtime'
);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as LanguageAssetManifest;
assert.equal(manifest.version, 1);
assert.equal(manifest.languages.length, bundledLanguagesInfo.length);
const manifestById = new Map(manifest.languages.map((language) => [language.id, language]));
for (const expected of bundledLanguagesInfo) {
  const actual = manifestById.get(expected.id);
  assert.ok(actual, `missing Shiki language asset ${expected.id}`);
  assert.deepEqual([...(actual.aliases ?? [])].sort(), [...(expected.aliases ?? [])].sort());
  assert.equal(path.basename(actual.module), actual.module, `language asset must be a local filename: ${actual.module}`);
  assert.equal(existsSync(path.join(webviewDist, actual.module)), true, `missing language module ${actual.module}`);
}

for (const id of ['typescript', 'html', 'vue', 'wasm', 'zig', 'mdx']) {
  const asset = manifestById.get(id);
  assert.ok(asset, `missing sampled language ${id}`);
  const loaded = await import(pathToFileURL(path.join(webviewDist, asset.module)).href);
  assert.ok(
    Array.isArray(loaded.default) && loaded.default.some((grammar: { name?: string }) => grammar.name === id),
    `sampled language module ${asset.module} did not expose ${id}`
  );
}

const runtimeBytes = statSync(exportRuntimePath).size;
assert.ok(
  runtimeBytes < 4_000_000,
  `export runtime must not embed the complete Shiki language catalog (${runtimeBytes} bytes)`
);

const importedRuntime = await import(pathToFileURL(exportRuntimePath).href);
let current: unknown = importedRuntime;
let runtime: ExportRuntime | null = null;
for (let depth = 0; depth < 5; depth += 1) {
  const candidate = current as Partial<ExportRuntime> | undefined;
  if (candidate && typeof candidate.renderExportHtmlDocument === 'function') {
    runtime = candidate as ExportRuntime;
    break;
  }
  if (!current || typeof current !== 'object' || !('default' in current)) break;
  current = (current as { default?: unknown }).default;
}
assert.ok(runtime, 'built export runtime did not expose renderExportHtmlDocument');

const codeTheme = darkPlus as CodeThemeDto;
const rendered = await runtime.renderExportHtmlDocument({
  readingSnapshot: {
    snapshotId: 'export-shiki-language-assets',
    text: [
      '```ts',
      'const answer: number = 42;',
      '```',
      '',
      '```zig',
      'const answer: u8 = 42;',
      '```',
      '',
      '```wolfram',
      'Plot[x^2, {x, 0, 1}]',
      '```'
    ].join('\n'),
    appearance: 'dark',
    uiLanguage: 'en',
    codeTheme,
    environment: {
      previewFontFamily: '',
      editorBackgroundColor: '#1e1e1e',
      editorForegroundColor: '#d4d4d4',
      codeBlockBackgroundColor: '#1e1e1e',
      sideBarBackgroundColor: '#252526',
      panelBorderColor: '#454545',
      previewSourceColoring: true
    }
  },
  sourceDocumentPath: 'C:/tmp/source.md',
  outputFilePath: 'C:/tmp/export.html',
  target: 'html',
  mermaidRuntimeSrc: '',
  baseHref: 'file:///C:/tmp/',
  title: 'Export Shiki language assets'
});
assert.equal((rendered.htmlDocument.match(/<div class="meo-export-code-block-wrap/g) ?? []).length, 3);
assert.ok(
  (rendered.htmlDocument.match(/<span style="color:/g) ?? []).length >= 3,
  'built export runtime must highlight common and uncommon languages through shared assets'
);

console.log(`Export Shiki language assets passed (${manifest.languages.length} languages, ${runtimeBytes} bytes)`);
