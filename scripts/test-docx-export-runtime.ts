import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import exportRuntime from '../src/export/runtime';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-docx-export-'));
const markdown = [
  '# Document title',
  '',
  'A paragraph with **bold text**.',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| answer | 42 |',
  '',
  '![pixel](pixel.png)'
].join('\n');

const render = async (sourceColoring: boolean) => exportRuntime.renderExportHtmlDocument({
  readingSnapshot: {
    snapshotId: `docx-${sourceColoring}`,
    text: markdown,
    appearance: 'light',
    uiLanguage: 'en',
    environment: { previewFontFamily: '', previewSourceColoring: sourceColoring }
  },
  sourceDocumentPath: path.join(fixtureRoot, 'document.md'),
  outputFilePath: path.join(fixtureRoot, 'document.docx'),
  target: 'docx',
  mermaidRuntimeSrc: 'file:///unused-mermaid.js',
  baseHref: 'file:///',
  title: 'Document title',
  includeTableOfContents: true,
  shikiLanguageAssetsRoot: path.resolve(import.meta.dir, '..', 'webview', 'dist')
});

const readArchiveXml = async (filePath: string, entryPath: string): Promise<string> => {
  const archive = await JSZip.loadAsync(fs.readFileSync(filePath));
  const entry = archive.file(entryPath);
  assert.notEqual(entry, null, `DOCX must contain ${entryPath}`);
  return entry!.async('string');
};

try {
  fs.writeFileSync(
    path.join(fixtureRoot, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACwB7WQAAAABJRU5ErkJggg==', 'base64')
  );
  const coloredPath = path.join(fixtureRoot, 'colored.docx');
  const colored = await render(true);
  assert.doesNotMatch(colored.htmlDocument, /<nav class="meo-export-toc"/, 'DOCX HTML staging must omit the web-only table of contents');
  await exportRuntime.writeDocxExport({
    htmlDocument: colored.htmlDocument,
    outputDocxPath: coloredPath,
    title: 'Document title',
    uiLanguage: 'en',
    includeTableOfContents: true,
    puppeteerRuntimeModulePath: ''
  });
  assert.deepEqual(fs.readFileSync(coloredPath).subarray(0, 2).toString('ascii'), 'PK');
  const coloredXml = await readArchiveXml(coloredPath, 'word/document.xml');
  assert.match(coloredXml, /<w:instrText[^>]*>TOC[^<]*\\h[^<]*\\o &quot;1-6&quot;/);
  assert.match(await readArchiveXml(coloredPath, 'word/settings.xml'), /<w:updateFields(?:\s+w:val="true")?\/>/);
  assert.match(coloredXml, /<w:pStyle w:val="Heading1"/);
  assert.match(coloredXml, /<w:tbl>/, 'Markdown tables must remain editable Word tables');
  assert.match(coloredXml, /<w:drawing>/, 'embedded Markdown images must remain embedded in DOCX');
  assert.match(coloredXml, /<w:b\/>[^]*bold text/, 'Markdown strong text must remain native bold text');
  assert.match(coloredXml, /<w:color w:val="[0-9A-F]{6}"/, 'enabled code coloring must produce Word run colors');

  const plainPath = path.join(fixtureRoot, 'plain.docx');
  const plain = await render(false);
  await exportRuntime.writeDocxExport({
    htmlDocument: plain.htmlDocument,
    outputDocxPath: plainPath,
    title: 'Document title',
    uiLanguage: 'en',
    includeTableOfContents: false,
    puppeteerRuntimeModulePath: ''
  });
  const plainXml = await readArchiveXml(plainPath, 'word/document.xml');
  assert.doesNotMatch(plainXml, /<w:instrText[^>]*>TOC/);
  assert.doesNotMatch(plainXml, /<w:color w:val="[0-9A-F]{6}"/, 'disabled code coloring must not add Word run colors');

  console.log('DOCX export runtime checks passed.');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
