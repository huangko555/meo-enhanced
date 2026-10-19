import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  'logo.png',
  'dist/extension.js',
  'dist/export-runtime.js',
  'dist/docx-runtime.js',
  'dist/puppeteer-runtime.js',
  'webview/dist/index.js',
  'webview/dist/git-diff-worker.js',
  'webview/dist/index.css',
  'webview/dist/mermaid.min.js',
  'webview/dist/package.json',
  'webview/dist/shiki-language-assets.json',
  'webview/dist/katex/katex.min.css'
];
for (const path of requiredFiles) {
  if (!included.has(path)) throw new Error(`VSIX listing is missing required file ${path}`);
}
const notices = (await readIncludedFile('THIRD_PARTY_NOTICES.md')).toString('utf8');
for (const [dependency, licensePath] of [['jsonc-parser 3.3.1', 'jsonc-parser/LICENSE.md'], ['PostCSS 8.5.6', 'postcss/LICENSE']]) {
  if (!notices.includes(`## ${dependency}`)) throw new Error(`Bundled preset dependency is missing its license notice: ${dependency}`);
  const licenseText = readFileSync(resolve(repoRoot, 'node_modules', licensePath), 'utf8').trim().replaceAll('\r\n', '\n');
  if (!notices.replaceAll('\r\n', '\n').includes(licenseText)) throw new Error(`Bundled preset dependency license differs from the upstream notice: ${dependency}`);
}
let scannedTextFiles = 0;
for (const path of files) {
  const contents = await readIncludedFile(path);
  // Inspect every UTF-8 text file regardless of suffix, including text with NULs.
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(contents); }
  catch { continue; }
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
