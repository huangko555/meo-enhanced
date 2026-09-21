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
  'const doubled = answer * 2;',
  '```',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| answer | 42 |',
  '',
  '![pixel](pixel.png)'
].join('\n');

const render = async (sourceColoring: boolean, appearance: 'light' | 'dark' = 'light') => exportRuntime.renderExportHtmlDocument({
  readingSnapshot: {
    snapshotId: `docx-${sourceColoring}`,
    text: markdown,
    appearance,
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

const paragraphContaining = (xml: string, text: string): string => {
  const paragraph = xml.match(/<w:p\b[^>]*>(?:(?!<\/w:p>)[^])*<\/w:p>/g)?.find((value) => (
    value.replace(/<[^>]+>/g, '').includes(text)
  ));
  assert.notEqual(paragraph, undefined, `DOCX must contain a paragraph with ${text}`);
  return paragraph!;
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
    docxRuntimeModulePath: path.join(import.meta.dir, '..', 'src', 'export', 'docxRuntime.mts'),
    puppeteerRuntimeModulePath: ''
  });
  assert.deepEqual(fs.readFileSync(coloredPath).subarray(0, 2).toString('ascii'), 'PK');
  const coloredXml = await readArchiveXml(coloredPath, 'word/document.xml');
  assert.match(coloredXml, /<w:instrText[^>]*> TOC \\h \\o "1-6" \\z \\u <\/w:instrText>/);
  assert.match(coloredXml, /<w:hyperlink[^>]*w:anchor="document-title"[^>]*>[^]*Document title/, 'cached TOC entries must be visible and link to heading bookmarks');
  assert.doesNotMatch(coloredXml, /<w:pPr>(?:(?!<\/w:pPr>)[^])*<w:fldChar/, 'TOC field runs must not be nested inside paragraph properties');
  assert.match(await readArchiveXml(coloredPath, 'word/settings.xml'), /<w:updateFields(?:\s+w:val="true")?\/>/);
  assert.match(coloredXml, /<w:pStyle w:val="Heading1"/);
  assert.equal((coloredXml.match(/<w:pStyle w:val="Heading1"/g) ?? []).length, 1, 'the TOC label must not become a document heading');
  assert.match(coloredXml, /<w:tbl>/, 'Markdown tables must remain editable Word tables');
  assert.match(coloredXml, /<w:drawing>/, 'embedded Markdown images must remain embedded in DOCX');
  assert.match(coloredXml, /<w:b\/>[^]*bold text/, 'Markdown strong text must remain native bold text');
  assert.match(paragraphContaining(coloredXml, 'const answer = 42;'), /<w:color w:val="[0-9A-F]{6}"/, 'enabled code coloring must produce Word run colors');
  assert.match(paragraphContaining(coloredXml, 'const answer = 42;'), /<w:br\/>/, 'multi-line code blocks must preserve line breaks');

  const darkPreviewDocx = await render(true, 'dark');
  assert.match(darkPreviewDocx.htmlDocument, /--meo-bg:\s*#ffffff/, 'DOCX staging must always use the light document background');
  assert.match(darkPreviewDocx.htmlDocument, /style="color:#0000FF"/, 'DOCX staging must use a light syntax theme even when Preview is dark');

  const plainPath = path.join(fixtureRoot, 'plain.docx');
  const plain = await render(false);
  await exportRuntime.writeDocxExport({
    htmlDocument: plain.htmlDocument,
    outputDocxPath: plainPath,
    title: 'Document title',
    uiLanguage: 'en',
    includeTableOfContents: false,
    docxRuntimeModulePath: path.join(import.meta.dir, '..', 'src', 'export', 'docxRuntime.mts'),
    puppeteerRuntimeModulePath: ''
  });
  const plainXml = await readArchiveXml(plainPath, 'word/document.xml');
  assert.doesNotMatch(plainXml, /<w:instrText[^>]*>TOC/);
  assert.doesNotMatch(paragraphContaining(plainXml, 'const answer = 42;'), /<w:color w:val="[0-9A-F]{6}"/, 'disabled code coloring must not add Word run colors');

  console.log('DOCX export runtime checks passed.');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
