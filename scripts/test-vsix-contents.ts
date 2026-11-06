import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { assertPackageTextIsPublic } from './vsix-privacy';

const repoRoot = resolve(import.meta.dir, '..');
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  main?: string;
  name: string;
  version: string;
  publisher: string;
};
if (process.argv.length > 3) throw new Error('Usage: bun scripts/test-vsix-contents.ts [artifact.vsix]');
const archive = process.argv[2]
  ? await JSZip.loadAsync(readFileSync(resolve(process.argv[2])), { checkCRC32: true })
  : null;
const output = archive ? '' : execFileSync(
  process.execPath,
  ['x', 'vsce', 'ls', '--no-dependencies'],
  { cwd: repoRoot, encoding: 'utf8' }
);
const archiveFiles = archive ? Object.values(archive.files).filter(entry => !entry.dir) : [];
for (const entry of archiveFiles) {
  if (!entry.name.startsWith('extension/') && !['[Content_Types].xml', 'extension.vsixmanifest'].includes(entry.name)) {
    throw new Error(`VSIX contains an unexpected top-level file: ${entry.name}`);
  }
}
const files = archive ? archiveFiles
  .filter(entry => entry.name.startsWith('extension/'))
  .map(entry => entry.name.slice('extension/'.length)) : output
  .split(/\r?\n/)
  .map((entry) => entry.trim().replaceAll('\\', '/').replace(/^\.\//, ''))
  .filter(Boolean);
const included = new Set(files);
async function readIncludedFile(path: string): Promise<Buffer> {
  if (!archive) return readFileSync(resolve(repoRoot, path));
  const entry = archive.file(`extension/${path}`);
  if (!entry) throw new Error(`VSIX is missing ${path}`);
  return entry.async('nodebuffer');
}
const packagedManifest = JSON.parse((await readIncludedFile('package.json')).toString('utf8'));
for (const key of ['name', 'version', 'publisher', 'main'] as const) {
  if (packagedManifest[key] !== packageJson[key]) throw new Error(`VSIX manifest differs from the release candidate: ${key}`);
}

const requiredFiles = [
  'schemas/custom-preview-preset.schema.json',
  'package.json',
  archive ? 'readme.md' : 'README.md',
  'README.zh-CN.md',
  archive ? 'changelog.md' : 'CHANGELOG.md',
  archive ? 'LICENSE.txt' : 'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'media/outline.svg',
  'dist/extension.js',
  'dist/export-runtime.js',
  'dist/preview-render-worker.js',
  'dist/fallback-code-highlighter.js',
  'dist/docx-runtime.js',
  'dist/puppeteer-runtime.js',
  'webview/dist/index.js',
  'webview/dist/editor.js',
  'webview/dist/git-diff-worker.js',
  'webview/dist/shiki-highlight-worker.js',
  'webview/dist/onig.wasm',
  'webview/dist/markdown-parse-worker.js',
  'webview/dist/document-statistics-worker.js',
  'webview/dist/index.css',
  'webview/dist/logo.png',
  'webview/dist/mermaid.min.js',
  'webview/dist/mermaid/mermaidRuntime.js',
  'webview/dist/mermaid/core.js',
  'webview/dist/mermaid/loader.js',
  'webview/dist/mermaid/preload.json',
  'webview/dist/mermaid/elk-worker-source.js',
  'webview/dist/mermaid/elk-LICENSE.md',
  'webview/dist/package.json',
  'webview/dist/shiki-language-assets.json',
  'webview/dist/katex/katex.min.css'
];
for (const path of requiredFiles) {
  if (!included.has(path)) throw new Error(`VSIX listing is missing required file ${path}`);
}
if (included.has('logo.png') || !included.has(packagedManifest.icon)
  || !(await readIncludedFile(packagedManifest.icon)).equals(readFileSync(resolve(repoRoot, 'logo.png')))) {
  throw new Error('The package icon and Webview must share the unchanged logo asset');
}
const mermaidPreloads = JSON.parse((await readIncludedFile('webview/dist/mermaid/preload.json')).toString('utf8'));
if (!Array.isArray(mermaidPreloads) || !mermaidPreloads.includes('core.js') || mermaidPreloads.some(name =>
  typeof name !== 'string' || !/^[a-zA-Z0-9_-]+\.js$/.test(name) || !included.has(`webview/dist/mermaid/${name}`))) {
  throw new Error('Mermaid preloads must reference existing local core modules');
}
if ((await readIncludedFile('webview/dist/mermaid.min.js')).length > 16_384
  || included.has('webview/dist/mermaid/elk-layout-worker.js')) {
  throw new Error('Mermaid must share its module graph and worker instead of shipping duplicate distributions');
}
const elkSource = readFileSync(resolve(repoRoot, 'node_modules/elkjs/lib/elk-worker.min.js'), 'utf8');
if (!(await readIncludedFile('webview/dist/mermaid/elk-worker-source.js')).toString('utf8').includes(JSON.stringify(elkSource))) {
  throw new Error('The shared ELK asset must preserve the official worker source');
}
const wasmPath = 'webview/dist/onig.wasm';
const wasm = await readIncludedFile(wasmPath);
if (!wasm.equals(readFileSync(resolve(repoRoot, 'node_modules/shiki/dist/onig.wasm')))) {
  throw new Error('Packaged syntax engine differs from the installed Shiki binary');
}
const embeddedWasmPrefix = wasm.toString('base64').slice(0, 128);
const fontRoot = 'webview/dist/katex/fonts/';
const fontNames = readdirSync(resolve(repoRoot, 'node_modules/katex/dist/fonts')).filter(name => name.endsWith('.woff2'));
for (const name of fontNames) {
  const packaged = await readIncludedFile(fontRoot + name);
  if (!packaged.equals(readFileSync(resolve(repoRoot, 'node_modules/katex/dist/fonts', name)))) {
    throw new Error(`Packaged formula font differs from upstream: ${name}`);
  }
}
const katexCss = (await readIncludedFile('webview/dist/katex/katex.min.css')).toString('utf8');
const fontReferences = [...katexCss.matchAll(/url\(["']?fonts\/([^"')]+)["']?\)/g)].map(match => match[1]);
if (fontReferences.length !== fontNames.length || fontNames.some(name => !fontReferences.includes(name))) {
  throw new Error('Formula CSS must reference every packaged WOFF2 font');
}
if (files.some(path => path.startsWith(fontRoot) && !path.endsWith('.woff2'))) {
  throw new Error('Formula fonts must use the single supported WOFF2 format');
}
const notices = (await readIncludedFile('THIRD_PARTY_NOTICES.md')).toString('utf8');
for (const [dependency, licensePath] of [['jsonc-parser 3.3.1', 'jsonc-parser/LICENSE.md'], ['PostCSS 8.5.6', 'postcss/LICENSE'], ['SystemJS 6.15.1', 'systemjs/LICENSE']]) {
  if (!notices.includes(`## ${dependency}`)) throw new Error(`Bundled preset dependency is missing its license notice: ${dependency}`);
  const licenseText = readFileSync(resolve(repoRoot, 'node_modules', licensePath), 'utf8').trim().replaceAll('\r\n', '\n');
  if (!notices.replaceAll('\r\n', '\n').includes(licenseText)) throw new Error(`Bundled preset dependency license differs from the upstream notice: ${dependency}`);
}
let scannedTextFiles = 0;
for (const path of files) {
  const contents = await readIncludedFile(path);
  if (path !== wasmPath && contents.equals(wasm)) throw new Error(`Duplicate syntax engine binary: ${path}`);
  // Inspect every UTF-8 text file regardless of suffix, including text with NULs.
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(contents); }
  catch { continue; }
  if (path.endsWith('.js') && text.includes(embeddedWasmPrefix)) {
    throw new Error(`Syntax engine must load the shared binary instead of embedding base64: ${path}`);
  }
  assertPackageTextIsPublic(path, text, repoRoot);
  scannedTextFiles += 1;
}
for (const entry of archiveFiles.filter(entry => !entry.name.startsWith('extension/'))) {
  assertPackageTextIsPublic(entry.name, await entry.async('string'), repoRoot);
  scannedTextFiles += 1;
}

const main = packageJson.main?.replace(/^\.\//, '');
if (!main || !included.has(main)) {
  throw new Error('VSIX listing must contain the package main entry');
}
if (!files.some((path) => path.startsWith('webview/dist/katex/fonts/'))) {
  throw new Error('VSIX listing must contain KaTeX fonts');
}

const forbiddenPrefixes = [
  'artifacts/',
  '.agents/',
  '.claude/',
  '.codex/',
  '.codegraph/',
  '.github/',
  '.local/',
  'node_modules/',
  'releases/',
  'scripts/',
  'src/',
  'tests/',
  'docs/',
  'preview-presets/',
  'webview/src/'
];
const forbiddenFile = /(?:^|\/)(?:\.env(?:\..*)?|AGENTS\.md|CLAUDE\.md|credentials[^/]*\.json|secrets?\.[^/]+|id_(?:rsa|ed25519)[^/]*)$/i;
for (const path of files) {
  if (
    forbiddenPrefixes.some((prefix) => path.startsWith(prefix))
    || forbiddenFile.test(path)
    || /\.(?:map|pem|key|p12|pfx|ts|vsix)$/i.test(path)
  ) {
    throw new Error(`VSIX listing contains forbidden file ${path}`);
  }
}

console.log(`VSIX content contract passed (${files.length} files, ${scannedTextFiles} text files scanned${archive ? ', final archive CRC verified' : ''})`);
