import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  main?: string;
};
const output = execFileSync(
  process.execPath,
  ['x', 'vsce', 'ls', '--no-dependencies'],
  { cwd: repoRoot, encoding: 'utf8' }
);
const files = output
  .split(/\r?\n/)
  .map((entry) => entry.trim().replaceAll('\\', '/').replace(/^\.\//, ''))
  .filter(Boolean);
const included = new Set(files);

const requiredFiles = [
  'package.json',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'logo.png',
  'dist/extension.js',
  'dist/export-runtime.js',
  'dist/puppeteer-runtime.js',
  'webview/dist/index.js',
  'webview/dist/index.css',
  'webview/dist/mermaid.min.js',
  'webview/dist/katex/katex.min.css'
];
for (const path of requiredFiles) {
  if (!included.has(path)) throw new Error(`VSIX listing is missing required file ${path}`);
}

const main = packageJson.main?.replace(/^\.\//, '');
if (!main || !included.has(main)) {
  throw new Error('VSIX listing must contain the package main entry');
}
if (!files.some((path) => path.startsWith('webview/dist/katex/fonts/'))) {
  throw new Error('VSIX listing must contain KaTeX fonts');
}

const forbiddenPrefixes = [
  '.agents/',
  '.claude/',
  '.codegraph/',
  '.github/',
  '.local/',
  'node_modules/',
  'releases/',
  'scripts/',
  'src/',
  'tests/',
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

console.log(`VSIX content contract passed (${files.length} files)`);
