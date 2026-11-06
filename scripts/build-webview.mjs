import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundledLanguagesInfo } from 'shiki/langs';
import { sharedShikiWasmPlugin } from './shiki-wasm-plugin.mjs';
import { buildMermaidRuntime } from './build-mermaid-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'webview', 'dist');
const katexDist = path.join(dist, 'katex');

// Bun emits content-hashed chunks but does not remove hashes from earlier builds.
// Always rebuild from an empty directory so stale chunks cannot enter the VSIX.
rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(katexDist, { recursive: true });

const build = await Bun.build({
  entrypoints: [path.join(root, 'webview/src/index.ts')],
  target: 'browser', format: 'esm', splitting: true, minify: true,
  outdir: dist, write: true, metafile: true,
  plugins: [sharedShikiWasmPlugin('browser')]
});
if (!build.success) throw new AggregateError(build.logs, 'Webview build failed');

const statisticsWorkerBuild = spawnSync(process.execPath, [
  'build', 'webview/src/documentStatisticsWorker.ts', '--target=browser', '--format=iife',
  '--minify', '--outfile=webview/dist/document-statistics-worker.js'
], { cwd: root, stdio: 'inherit' });
if (statisticsWorkerBuild.status !== 0) process.exit(statisticsWorkerBuild.status ?? 1);
const workerBuild = spawnSync(process.execPath, [
  'build', 'webview/src/helpers/gitDiffWorker.ts', '--target=browser', '--format=iife',
  '--minify', '--outfile=webview/dist/git-diff-worker.js'
], { cwd: root, stdio: 'inherit' });
if (workerBuild.status !== 0) process.exit(workerBuild.status ?? 1);
const shikiWorkerBuild = await Bun.build({
  entrypoints: [path.join(root, 'webview/src/helpers/shikiHighlightWorker.ts')],
  target: 'browser', format: 'iife', minify: true,
  plugins: [sharedShikiWasmPlugin('worker')]
});
if (!shikiWorkerBuild.success) throw new AggregateError(shikiWorkerBuild.logs, 'Shiki worker build failed');
await Bun.write(path.join(dist, 'shiki-highlight-worker.js'), shikiWorkerBuild.outputs[0]);
cpSync(path.join(root, 'node_modules/shiki/dist/onig.wasm'), path.join(dist, 'onig.wasm'));
const markdownWorkerBuild = spawnSync(process.execPath, [
  'build', 'webview/src/markdownParseWorker.ts', '--target=browser', '--format=iife',
  '--minify', '--outfile=webview/dist/markdown-parse-worker.js'
], { cwd: root, stdio: 'inherit' });
if (markdownWorkerBuild.status !== 0) process.exit(markdownWorkerBuild.status ?? 1);
await buildMermaidRuntime(root, dist);

const buildMetadata = build.metafile;
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
writeFileSync(path.join(dist, 'package.json'), '{"type":"module"}\n');
writeFileSync(
  path.join(dist, 'shiki-language-assets.json'),
  `${JSON.stringify({ version: 1, languages: languageAssets })}\n`
);

cpSync(path.join(root, 'webview', 'src', 'styles.css'), path.join(dist, 'index.css'));
cpSync(path.join(root, 'logo.png'), path.join(dist, 'logo.png'));
const katexSourceDir = path.join(root, 'node_modules', 'katex', 'dist');
const katexCss = readFileSync(path.join(katexSourceDir, 'katex.min.css'), 'utf8');

const woff2OnlyKatexCss = katexCss.replace(
  /,url\((['"]?)fonts\/[^'")]+\.woff\1\) format\("woff"\),url\((['"]?)fonts\/[^'")]+\.ttf\2\) format\("truetype"\)/g,
  ''
);
writeFileSync(path.join(katexDist, 'katex.min.css'), woff2OnlyKatexCss);
cpSync(path.join(katexSourceDir, 'fonts'), path.join(katexDist, 'fonts'), {
  recursive: true,
  filter: source => !path.extname(source) || source.endsWith('.woff2')
});
const embeddedKatexCss = woff2OnlyKatexCss.replace(
  /url\((['"]?)fonts\/([^'")]+\.woff2)\1\)/g,
  (_match, _quote, fontName) => {
    const fontPath = path.join(katexSourceDir, 'fonts', fontName);
    const fontData = readFileSync(fontPath).toString('base64');
    return `url("data:font/woff2;base64,${fontData}")`;
  }
);
writeFileSync(path.join(katexDist, 'katex-embedded.css'), embeddedKatexCss);
