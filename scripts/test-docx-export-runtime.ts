import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { DomUtils, parseDocument } from 'htmlparser2';
import exportRuntime from '../src/export/runtime';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-docx-export-'));
const whitespaceCases = [
  { html: '<div style="white-space:pre-wrap">  First  preserved line\n  Second preserved line</div>',
    marker: 'First preserved line', expected: '  First  preserved line\n  Second preserved line' },
  { html: '<pre>  Preformatted  text\n  Indented  line</pre>',
    marker: 'Preformatted text', expected: '  Preformatted  text\n  Indented  line' },
  { html: '<p style="white-space:break-spaces">  Break  spaces  &#10;    &#10;  Last  line  </p>',
    marker: 'Break spaces', expected: '  Break  spaces  \n    \n  Last  line  ' },
  { html: '<div style="white-space:pre"><p>  Inherited  text <b> bold  text </b>  tail</p></div>',
    marker: 'Inherited text', expected: '  Inherited  text  bold  text   tail' },
  { html: '<p><span style="white-space:pre-wrap">  Inline  text</span></p>',
    marker: 'Inline text', expected: '  Inline  text' },
  { html: '<div style="white-space:pre-wrap"><p style="white-space:inherit">  Explicit  inheritance</p><p style="white-space:unset">  Unset  inheritance</p></div>',
    marker: 'Explicit inheritance', expected: '  Explicit  inheritance' },
  { html: '<p style="white-space:normal;white-space:pre-wrap">  Later  preservation</p>',
    marker: 'Later preservation', expected: '  Later  preservation' },
  { html: '<p style="white-space:pre-wrap">  Escaped  &amp; &lt;text&gt;&nbsp;end</p>',
    marker: 'Escaped', expected: '  Escaped  & <text>\u00a0end' },
  { html: '<p style="white-space:pre-line">  Preline  text\n  Collapsed  spaces</p>',
    marker: 'Preline text', expected: 'Preline text\nCollapsed spaces' },
  { html: '<div style="white-space:pre-wrap"><p style="white-space:normal">  Normal  override</p><p style="white-space:initial">  Initial  override</p></div>',
    marker: 'Normal override', expected: 'Normal override' },
  { html: '<p style="white-space:pre-wrap;white-space:normal">  Later  collapse</p>',
    marker: 'Later collapse', expected: 'Later collapse' },
  { html: '<p style="white-space:nowrap">  Nowrap  text</p>',
    marker: 'Nowrap text', expected: 'Nowrap text' }
];
const markdown = [
  '---',
  'title: MEO Enhanced',
  'tags:',
  '  - VS Code',
  '  - Markdown',
  'document:',
  '  language: zh-CN',
  '  formats: [Markdown, HTML, PDF]',
  '  tableOfContents: true',
  '---',
  '',
  '# Document title',
  '',
  'A paragraph with **bold text**.',
  '<!-- Review comment for DOCX -->',
  '',
  '## Overview',
  '',
  '### Details',
  '',
  '中文正文与 English text.',
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
  '<details open><summary><strong>Visible summary</strong></summary><p>Visible HTML body</p></details>',
  '',
  '<p><kbd>Ctrl</kbd> + <kbd>S</kbd> <small>Small note</small> <q>Quoted text</q> <abbr>HTML abbreviation</abbr> <ruby>Ruby text<rt>Ruby reading</rt></ruby></p>',
  '',
  '<figure><figcaption>Figure caption</figcaption></figure>',
  '',
  ...whitespaceCases.flatMap(({ html }) => [html, '']),
  '',
  '![pixel](pixel.png)'
].join('\n');

const render = async (sourceColoring: boolean, appearance: 'light' | 'dark' = 'light') => exportRuntime.renderExportHtmlDocument({
  readingSnapshot: {
    snapshotId: `docx-${sourceColoring}`,
    text: markdown,
    appearance,
    uiLanguage: 'en',
    environment: { previewFontFamily: '', previewSourceColoring: sourceColoring, previewShowComments: sourceColoring }
  },
  sourceDocumentPath: path.join(fixtureRoot, 'document.md'),
  outputFilePath: path.join(fixtureRoot, 'document.docx'),
  target: 'docx',
  mermaidRuntimeSrc: 'file:///unused-mermaid.js',
  baseHref: 'file:///',
  title: 'Document title',
  includeTableOfContents: true,
  // Unit tests run before the Webview build; package:check covers the built assets.
  shikiLanguageAssetsRoot: ''
});

const readArchiveXml = async (filePath: string, entryPath: string): Promise<string> => {
  const archive = await JSZip.loadAsync(fs.readFileSync(filePath));
  const entry = archive.file(entryPath);
  assert.notEqual(entry, null, `DOCX must contain ${entryPath}`);
  return entry!.async('string');
};

const paragraphContaining = (xml: string, text: string): string => {
  const paragraph = xml.match(/<w:p\b[^>]*>(?:(?!<\/w:p>)[^])*<\/w:p>/g)?.find((value) => (
    value.replace(/<[^>]+>/g, '').replace(/\s+/g, '').includes(text.replace(/\s+/g, ''))
  ));
  assert.notEqual(paragraph, undefined, `DOCX must contain a paragraph with ${text}`);
  return paragraph!;
};

const tableContaining = (xml: string, text: string): string => {
  const table = xml.match(/<w:tbl\b[^>]*>(?:(?!<\/w:tbl>)[^])*<\/w:tbl>/g)?.find((value) => (
    value.replace(/<[^>]+>/g, '').replace(/\s+/g, '').includes(text.replace(/\s+/g, ''))
  ));
  assert.notEqual(table, undefined, `DOCX must contain a table with ${text}`);
  return table!;
};

const paragraphText = (xml: string, text: string): string => DomUtils.findAll(
  (element) => ['w:t', 'w:br', 'w:tab'].includes(element.name),
  parseDocument(paragraphContaining(xml, text), { xmlMode: true }).children
).map((element) => element.name === 'w:br' ? '\n'
  : element.name === 'w:tab' ? '\t' : DomUtils.textContent(element)).join('');

const assertWhitespace = (xml: string): void => {
  for (const { marker, expected } of whitespaceCases) {
    assert.equal(paragraphText(xml, marker), expected, `Word must follow authored whitespace semantics: ${marker}`);
  }
  assert.equal(paragraphText(xml, 'Unset inheritance'), '  Unset  inheritance');
  assert.equal(paragraphText(xml, 'Initial override'), 'Initial override');
  assert.doesNotMatch(xml, /htmlmin:ignore/, 'HTML whitespace protection must not leak into Word text');
};

try {
  fs.writeFileSync(path.join(fixtureRoot, 'document.md'), markdown);
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
  assert.match(coloredXml, /Review comment for DOCX/, 'visible Preview comments must be visible in DOCX');
  assert.match(coloredXml, /<w:instrText[^>]*> TOC \\h \\o "1-6" \\z \\u <\/w:instrText>/);
  assert.match(coloredXml, /<w:hyperlink[^>]*w:anchor="meo_heading_1"[^>]*>[^]*Document title/, 'cached TOC entries must be visible and link to heading bookmarks');
  assert.match(coloredXml, /<w:bookmarkStart[^>]*w:name="meo_heading_1"/, 'TOC headings must expose native Word bookmarks');
  assert.doesNotMatch(coloredXml, /<w:pPr>(?:(?!<\/w:pPr>)[^])*<w:fldChar/, 'TOC field runs must not be nested inside paragraph properties');
  assert.match(await readArchiveXml(coloredPath, 'word/settings.xml'), /<w:updateFields(?:\s+w:val="true")?\/>/);
  const coloredStyles = await readArchiveXml(coloredPath, 'word/styles.xml');
  const documentDefaults = coloredStyles.match(/<w:docDefaults\b[^>]*>[^]*?<\/w:docDefaults>/)?.[0] ?? '';
  assert.match(documentDefaults, /<w:rFonts\b[^>]*w:ascii="DengXian"/);
  assert.match(documentDefaults, /<w:rFonts\b[^>]*w:hAnsi="DengXian"/);
  assert.match(documentDefaults, /<w:rFonts\b[^>]*w:eastAsia="等线"/);
  assert.match(documentDefaults, /<w:rFonts\b[^>]*w:cs="DengXian"/);
  assert.doesNotMatch(documentDefaults, /w:(?:ascii|hAnsi|eastAsia|cs)Theme=/, 'Word body fonts must not fall back to theme fonts');
  for (const level of [1, 2, 3, 4, 5, 6]) {
    const headingStyle = coloredStyles.match(new RegExp(`<w:style\\b[^>]*w:styleId="Heading${level}"[^]*?<\\/w:style>`))?.[0] ?? '';
    assert.doesNotMatch(headingStyle, /<w:(?:keepNext|keepLines)\b/, `Heading ${level} must not show Word paragraph pagination marks`);
    const tocStyle = coloredStyles.match(new RegExp(`<w:style\\b[^>]*w:styleId="TOC${level}"[^]*?<\\/w:style>`))?.[0] ?? '';
    assert.match(tocStyle, new RegExp(`<w:name w:val="toc ${level}"\\s*\\/>`), `TOC ${level} must be defined as a native Word style`);
    assert.match(tocStyle, /<w:tab\b[^>]*w:val="right"[^>]*w:leader="dot"/, `TOC ${level} must use a right-aligned dotted tab stop`);
  }
  assert.match(paragraphContaining(coloredXml, 'Document title'), /<w:pStyle w:val="TOC1"\s*\/>/, 'top-level TOC entries must use TOC 1');
  assert.match(paragraphContaining(coloredXml, 'Overview'), /<w:pStyle w:val="TOC2"\s*\/>/, 'second-level TOC entries must use TOC 2');
  assert.match(paragraphContaining(coloredXml, 'Details'), /<w:pStyle w:val="TOC3"\s*\/>/, 'third-level TOC entries must use TOC 3');
  assert.match(coloredXml, /<w:instrText[^>]*> PAGEREF meo_heading_1 \\h <\/w:instrText>/, 'TOC entries must carry native page references');
  assert.match(coloredXml, /<w:pStyle w:val="Heading1"/);
  assert.equal((coloredXml.match(/<w:pStyle w:val="Heading1"/g) ?? []).length, 1, 'the TOC label must not become a document heading');
  assert.match(coloredXml, /<w:tbl>/, 'Markdown tables must remain editable Word tables');
  assert.match(coloredXml, /<w:tcBorders>/, 'Word table cells must keep visible borders');
  assert.match(coloredXml, /<w:shd[^>]*w:fill="f6f8fa"/, 'Word table headers must keep the light header background');
  assert.match(coloredXml, /<w:drawing>/, 'embedded Markdown images must remain embedded in DOCX');
  assert.match(coloredXml, /<w:b\/>[^]*bold text/, 'Markdown strong text must remain native bold text');
  assert.match(coloredXml, /Visible summary[^]*Visible HTML body/, 'safe HTML content must remain visible in DOCX');
  for (const text of ['Ctrl', 'Small note', 'Quoted text', 'HTML abbreviation', 'Ruby text', 'Ruby reading', 'Figure caption']) {
    assert.ok(coloredXml.includes(text), `HTML text must survive Word conversion: ${text}`);
  }
  assert.match(paragraphContaining(coloredXml, 'First preserved line'), /<w:br\b[^>]*\/>[^]*Second preserved line/,
    'authored pre-wrap must retain explicit line breaks');
  assertWhitespace(coloredXml);
  assert.doesNotMatch(coloredXml, /__MEO_EXPORT_READY__/, 'export runtime scripts must not leak into DOCX text');
  const coloredCodeParagraph = paragraphContaining(coloredXml, 'const answer = 42;');
  assert.match(coloredCodeParagraph, /<w:rFonts\b[^>]*w:ascii="Consolas"[^>]*w:hAnsi="Consolas"/, 'Word code must keep the Consolas override');
  assert.match(coloredCodeParagraph, /<w:color w:val="[0-9A-F]{6}"/, 'enabled code coloring must produce Word run colors');
  assert.match(coloredCodeParagraph, /<w:br(?:\s+w:type="textWrapping")?\/>/, 'multi-line code blocks must preserve line breaks');
  assert.doesNotMatch(coloredCodeParagraph, /<w:jc w:val="(?:both|distribute)"/, 'code blocks must never distribute tokens across the line');
  const codeSizes = [...coloredCodeParagraph.matchAll(/<w:sz w:val="(\d+)"/g)].map((match) => Number(match[1]));
  assert.ok(codeSizes.length > 0 && codeSizes.every((size) => size === 20), 'Word code must render consistently at 10pt');
  const propertiesTable = tableContaining(coloredXml, 'Properties');
  assert.match(propertiesTable, /title[^]*MEO Enhanced[^]*tags[^]*VS Code[^]*document[^]*language[^]*zh-CN/, 'front matter must become a readable two-column Word table');
  const tocFieldEnd = coloredXml.indexOf('<w:fldChar w:fldCharType="end"/>');
  const tocPageBreak = coloredXml.indexOf('<w:br w:type="page"/>', tocFieldEnd);
  const firstHeading = coloredXml.indexOf('w:name="meo_heading_1"', tocPageBreak);
  assert.ok(tocFieldEnd >= 0 && tocPageBreak > tocFieldEnd && firstHeading > tocPageBreak, 'the document body must start on the page after the TOC');

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
  assertWhitespace(plainXml);
  assert.equal(fs.readFileSync(path.join(fixtureRoot, 'document.md'), 'utf8'), markdown,
    'Word export must leave the Markdown source unchanged');
  assert.doesNotMatch(plainXml, /Review comment for DOCX/, 'hidden Preview comments must stay out of DOCX');
  const plainStyles = await readArchiveXml(plainPath, 'word/styles.xml');
  assert.doesNotMatch(plainXml, /<w:instrText[^>]*>TOC/);
  assert.doesNotMatch(plainStyles, /w:styleId="TOC[1-6]"/, 'documents without a TOC must not add unused TOC styles');
  assert.doesNotMatch(plainXml, /MEOHEADINGMARKER/, 'documents without a TOC must not contain internal heading markers');
  assert.doesNotMatch(paragraphContaining(plainXml, 'const answer = 42;'), /<w:color w:val="[0-9A-F]{6}"/, 'disabled code coloring must not add Word run colors');

  console.log('DOCX export runtime checks passed.');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
