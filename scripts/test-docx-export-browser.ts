import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import exportRuntime from '../src/export/runtime';

const repoRoot = path.resolve(import.meta.dir, '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-docx-browser-'));

try {
  const outputDocxPath = path.join(fixtureRoot, 'rich-media.docx');
  const rendered = await exportRuntime.renderExportHtmlDocument({
    readingSnapshot: {
      snapshotId: 'docx-rich-media',
      text: '```mermaid\ngraph LR\n  A --> B\n```\n\n$$x^2 + y^2 = z^2$$',
      appearance: 'light',
      uiLanguage: 'en',
      environment: { previewFontFamily: '', previewSourceColoring: true }
    },
    sourceDocumentPath: path.join(fixtureRoot, 'rich-media.md'),
    outputFilePath: outputDocxPath,
    target: 'docx',
    mermaidRuntimeSrc: pathToFileURL(path.join(repoRoot, 'webview', 'dist', 'mermaid.min.js')).toString(),
    katexStylesHref: pathToFileURL(path.join(repoRoot, 'webview', 'dist', 'katex', 'katex.min.css')).toString(),
    baseHref: pathToFileURL(`${fixtureRoot}${path.sep}`).toString(),
    title: 'Rich media',
    includeTableOfContents: false,
    shikiLanguageAssetsRoot: path.join(repoRoot, 'webview', 'dist')
  });
  assert.equal(rendered.hasMermaid, true);
  assert.equal(rendered.hasMath, true);

  await exportRuntime.writeDocxExport({
    htmlDocument: rendered.htmlDocument,
    outputDocxPath,
    title: 'Rich media',
    uiLanguage: 'en',
    includeTableOfContents: false,
    puppeteerRuntimeModulePath: path.join(repoRoot, 'dist', 'puppeteer-runtime.js'),
    timeoutMs: 60000
  });

  const archive = await JSZip.loadAsync(fs.readFileSync(outputDocxPath));
  const documentXml = await archive.file('word/document.xml')?.async('string');
  assert.match(documentXml ?? '', /<w:drawing>/, 'rendered Mermaid and display math must be embedded as images');
  assert.equal(
    Object.keys(archive.files).filter((name) => name.startsWith('word/media/')).length >= 2,
    true,
    'DOCX must contain materialized Mermaid and display-math image assets'
  );

  console.log('DOCX rich-media browser checks passed.');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
