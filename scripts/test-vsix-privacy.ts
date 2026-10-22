import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPackageTextIsPublic } from './vsix-privacy';

const root = resolve(import.meta.dir, '..');
for (const file of ['dist/puppeteer-runtime.js', 'dist/docx-runtime.js', 'dist/preview-render-worker.js', 'dist/fallback-code-highlighter.js', 'README.md', 'package.json', 'extension.vsixmanifest']) {
  for (const contents of [root, root.replaceAll('\\', '/'), JSON.stringify(root), pathToFileURL(root).href,
    'C:\\Users\\example\\build\\entry.js', String.raw`C:\\Users\\example\\build\\entry.js`,
    'file:///C:/Users/example/build/entry.js', 'file:///C%3A%2FUsers%2Fexample%2Fbuild%2Fentry.js',
    '/home/example/build/entry.js', '/Users/example/build/entry.js']) {
    assert.throws(() => assertPackageTextIsPublic(file, contents, root), /private build or home path/);
  }
}
for (const contents of [['-----BEGIN', 'PRIVATE KEY-----'].join(' '), `ghp_${'a'.repeat(36)}`, `github_pat_${'a'.repeat(50)}`, `AKIA${'A'.repeat(16)}`]) {
  assert.throws(() => assertPackageTextIsPublic('package.json', contents, root), /contains a credential/);
}
for (const contents of ['var directory = __dirname;', 'https://github.com/huangko555/meo-enhanced',
  'file:///C:/example/document.md', '/usr/share/fonts/example.woff2', 'Use process.env.GITHUB_TOKEN.']) {
  assert.doesNotThrow(() => assertPackageTextIsPublic('README.md', contents, root));
}
console.log('VSIX privacy contracts passed (all text surfaces, escaped paths and credential redaction).');
