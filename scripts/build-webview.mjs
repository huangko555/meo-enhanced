import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundledLanguagesInfo } from 'shiki/langs';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'webview', 'dist');
const katexDist = path.join(dist, 'katex');
const buildMetadataPath = path.join(dist, '.build-metadata.json');

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
  '--outdir=webview/dist',
  '--metafile=webview/dist/.build-metadata.json'
], {
  cwd: root,
  stdio: 'inherit'
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const buildMetadata = JSON.parse(readFileSync(buildMetadataPath, 'utf8'));
const languageModules = new Map();
for (const [outputPath, output] of Object.entries(buildMetadata.outputs ?? {})) {
  const entryPoint = String(output?.entryPoint ?? '').replaceAll('\\', '/');
  const match = /(?:^|\/)@shikijs\/langs\/dist\/([^/]+)\.mjs$/.exec(entryPoint);
  if (!match) continue;
  languageModules.set(match[1], path.posix.basename(outputPath.replaceAll('\\', '/')));
}

const languageAssets = bundledLanguagesInfo.map((language) => {
  const module = languageModules.get(language.id);
  if (!module || !existsSync(path.join(dist, module))) {
    throw new Error(`Webview build did not emit the Shiki language module for ${language.id}`);
  }
  return {
    id: language.id,
    aliases: [...(language.aliases ?? [])],
    module
  };
});
rmSync(buildMetadataPath);
writeFileSync(path.join(dist, 'package.json'), '{"type":"module"}\n');
writeFileSync(
  path.join(dist, 'shiki-language-assets.json'),
  `${JSON.stringify({ version: 1, languages: languageAssets })}\n`
);

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
