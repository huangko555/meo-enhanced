import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'webview', 'dist');
const katexDist = path.join(dist, 'katex');

// Bun emits content-hashed chunks but does not remove hashes from earlier builds.
// Always rebuild from an empty directory so stale chunks cannot enter the VSIX.
rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(katexDist, { recursive: true });

const build = spawnSync(process.execPath, [
  'build',
  'webview/src/index.ts',
  '--target=browser',
  '--format=esm',
  '--splitting',
  '--minify',
  '--outdir=webview/dist'
], {
  cwd: root,
  stdio: 'inherit'
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

cpSync(path.join(root, 'webview', 'src', 'styles.css'), path.join(dist, 'index.css'));
cpSync(path.join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'), path.join(dist, 'mermaid.min.js'));
const katexSourceDir = path.join(root, 'node_modules', 'katex', 'dist');
const katexCss = readFileSync(path.join(katexSourceDir, 'katex.min.css'), 'utf8');
cpSync(path.join(katexSourceDir, 'katex.min.css'), path.join(katexDist, 'katex.min.css'));
cpSync(path.join(katexSourceDir, 'fonts'), path.join(katexDist, 'fonts'), { recursive: true });

const woff2OnlyKatexCss = katexCss.replace(
  /,url\((['"]?)fonts\/[^'")]+\.woff\1\) format\("woff"\),url\((['"]?)fonts\/[^'")]+\.ttf\2\) format\("truetype"\)/g,
  ''
);
const embeddedKatexCss = woff2OnlyKatexCss.replace(
  /url\((['"]?)fonts\/([^'")]+\.woff2)\1\)/g,
  (_match, _quote, fontName) => {
    const fontPath = path.join(katexSourceDir, 'fonts', fontName);
    const fontData = readFileSync(fontPath).toString('base64');
    return `url("data:font/woff2;base64,${fontData}")`;
  }
);
writeFileSync(path.join(katexDist, 'katex-embedded.css'), embeddedKatexCss);
