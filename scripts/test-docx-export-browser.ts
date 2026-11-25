import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import sharp from 'sharp';
import exportRuntime from '../src/export/runtime';
import { renderPdfFromHtmlExport } from '../src/export/pdfRenderer';
import { complexMermaidSamples } from './fixtures/mermaid-community-samples';
import { mermaidLabelSamples } from './fixtures/mermaid-labels';

const repoRoot = path.resolve(import.meta.dir, '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-docx-browser-'));

async function assertInlineContentAndChapterAnchors(): Promise<void> {
  await sharp({ create: { width: 37, height: 24, channels: 3, background: '#00ff00' } }).png().toFile(path.join(fixtureRoot, 'fallback.png'));
  await sharp({ create: { width: 73, height: 34, channels: 3, background: '#ff0000' } }).png().toFile(path.join(fixtureRoot, 'selected.png'));
  const text = [
    'Before math $\\frac{x}{y}$ after math.',
    '[Chapter jump](#章节) and [external](https://example.invalid/).',
    '## 章节',
    '<picture><source srcset="selected.png" media="(min-width: 1px)"><img src="fallback.png" alt="Responsive fixture"></picture>',
    '<svg width="59" height="31" xmlns="http://www.w3.org/2000/svg" aria-label="SVG fixture"><rect width="59" height="31" fill="#8739ef" /></svg>'
  ].join('\n\n');
  const outputDocxPath = path.join(fixtureRoot, 'inline-content.docx');
  const { htmlDocument } = await exportRuntime.renderExportHtmlDocument({
    readingSnapshot: { snapshotId: 'inline-content', text, appearance: 'light', uiLanguage: 'en', environment: { previewFontFamily: '' } },
    sourceDocumentPath: path.join(fixtureRoot, 'source.md'), outputFilePath: outputDocxPath,
    target: 'docx', title: 'Inline content', baseHref: pathToFileURL(fixtureRoot + path.sep).href, mermaidRuntimeSrc: '',
    katexStylesHref: pathToFileURL(path.join(repoRoot, 'webview/dist/katex/katex.min.css')).href, shikiLanguageAssetsRoot: ''
  });
  await exportRuntime.writeDocxExport({ htmlDocument, outputDocxPath, title: 'Inline content', uiLanguage: 'en', includeTableOfContents: false,
    docxRuntimeModulePath: path.join(repoRoot, 'dist/docx-runtime.js'), puppeteerRuntimeModulePath: path.join(repoRoot, 'dist/puppeteer-runtime.js') });
  const archive = await JSZip.loadAsync(fs.readFileSync(outputDocxPath));
  const xml = await archive.file('word/document.xml')!.async('string');
  const relationships = await archive.file('word/_rels/document.xml.rels')!.async('string');
  const paragraph = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].find(match => match[0].includes('Before math'))?.[0];
  assert.match(paragraph ?? '', /Before math[\s\S]*<w:drawing>[\s\S]*after math/, 'The original paragraph contains a true inline formula drawing');
  assert.equal((xml.match(/<w:drawing>/g) ?? []).length, 3, 'Formula, responsive image and inline SVG survive conversion');
  const dimensions = await Promise.all(Object.keys(archive.files).filter(name => /^word\/media\/.+\.png$/.test(name))
    .map(async name => sharp(await archive.file(name)!.async('nodebuffer')).metadata()));
  assert.ok(dimensions.some(image => image.width === 73 && image.height === 34), 'Word captures the selected picture, not its fallback');
  assert.ok(dimensions.some(image => image.width === 59 && image.height === 31), 'Word captures the SVG at its authored size');
  const anchor = /<w:hyperlink\b[^>]*w:anchor="([^"]+)"[^>]*>[\s\S]*?Chapter jump/.exec(xml)?.[1];
  assert.ok(anchor && xml.includes(`w:name="${anchor}"`), 'The Unicode chapter link targets an actual bookmark without a TOC');
  assert.match(relationships, /https:\/\/example\.invalid\//);
  assert.doesNotMatch(relationships, /Target="#/);
}

async function assertLongMermaidLabelMaterializesWithoutCropping(): Promise<void> {
  const outputDocxPath = path.join(fixtureRoot, 'long-mermaid-label.docx');
  const text = '```mermaid\nflowchart LR\n  OfflineStart[OFFLINE_MERMAID_START]\n```\n';
  const rendered = await exportRuntime.renderExportHtmlDocument({
    readingSnapshot: { snapshotId: 'docx-long-mermaid-label', text, appearance: 'dark', uiLanguage: 'en',
      environment: { previewFontFamily: '', previewSourceColoring: true } },
    sourceDocumentPath: path.join(fixtureRoot, 'long-mermaid-label.md'), outputFilePath: outputDocxPath,
    target: 'docx', title: 'Long Mermaid label', includeTableOfContents: false,
    baseHref: pathToFileURL(`${fixtureRoot}${path.sep}`).href,
    mermaidRuntimeSrc: pathToFileURL(path.join(repoRoot, 'webview/dist/mermaid.min.js')).href,
    shikiLanguageAssetsRoot: path.join(repoRoot, 'webview/dist')
  });
  await exportRuntime.writeDocxExport({ htmlDocument: rendered.htmlDocument, outputDocxPath,
    title: 'Long Mermaid label', uiLanguage: 'en', includeTableOfContents: false,
    docxRuntimeModulePath: path.join(repoRoot, 'dist/docx-runtime.js'),
    puppeteerRuntimeModulePath: path.join(repoRoot, 'dist/puppeteer-runtime.js') });

  const archive = await JSZip.loadAsync(fs.readFileSync(outputDocxPath));
  const images = Object.keys(archive.files).filter(name => name.startsWith('word/media/') && name.endsWith('.png'));
  assert.ok(images.length >= 1, 'The standalone Mermaid fixture must produce DOCX PNG media');
  const inkSpans = await Promise.all(images.map(async name => {
    const png = await archive.file(name)!.async('nodebuffer');
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const lines: number[] = [];
    let firstInk = info.width, lastInk = -1;
    for (let y = 0; y < info.height; y++) {
      let rowHasInk = false;
      for (let x = 0; x < info.width; x++) {
        const offset = (y * info.width + x) * info.channels;
        // Label ink is darker than the node border and diagram background.
        if (data[offset]! >= 90 || data[offset + 1]! >= 100 || data[offset + 2]! >= 110) continue;
        firstInk = Math.min(firstInk, x);
        lastInk = Math.max(lastInk, x);
        rowHasInk = true;
      }
      if ((!rowHasInk || y === info.height - 1) && lastInk >= firstInk) {
        lines.push(lastInk - firstInk + 1);
        firstInk = info.width;
        lastInk = -1;
      }
    }
    return { name, width: info.width, height: info.height, lines, totalSpan: lines.reduce((sum, span) => sum + span, 0) };
  }));
  assert.ok(inkSpans.some(image => image.lines.length > 1 && image.totalSpan >= 170),
    `DOCX Mermaid PNG must rasterize the full wrapped identifier: ${JSON.stringify(inkSpans)}`);
  console.log('DOCX long Mermaid label materialization passed.');
}

async function checkHtmlVisibility(): Promise<void> {
  const outputDocxPath = path.join(fixtureRoot, 'html-visibility.docx');
  const text = [
    '# HTML visibility', '', '<div hidden>hidden-attribute</div>', '',
    '<p style="display:none">hidden-display</p>', '',
    '<img hidden alt="hidden-media" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACwB7WQAAAABJRU5ErkJggg==">', '',
    '<div style="opacity:0">hidden-opacity<span style="opacity:1">hidden-opacity-child</span></div>', '',
    '<p style="visibility:hidden">hidden-visibility<span style="visibility:visible">visible-override</span></p>', '',
    '<div style="color:transparent">hidden-transparent<span>hidden-inherited</span><b style="color:red">visible-colored</b></div>', '',
    '<p style="color:#1230">hidden-short-alpha</p>', '', '<p style="color:rgba(0,0,0,0)">hidden-rgba</p>', '',
    '<p style="font-size:0">hidden-zero<span style="font-size:16px">visible-sized</span></p>', '',
    '<details><summary>closed-summary</summary><p>hidden-closed</p></details>', '',
    '<p>Visible black text, <span style="color:red">visible-red</span> and <span style="color:green">visible-green</span>.</p>', '',
    '<div style="white-space:pre-wrap">  Materialized  spaces\n  Next  line <b> bold  text </b></div>'
  ].join('\n');
  const rendered = await exportRuntime.renderExportHtmlDocument({
    readingSnapshot: { snapshotId: 'docx-html-visibility', text, appearance: 'light', uiLanguage: 'en',
      environment: { previewFontFamily: '', previewSourceColoring: true } },
    sourceDocumentPath: path.join(fixtureRoot, 'visibility.md'), outputFilePath: outputDocxPath,
    target: 'docx', title: 'HTML visibility', includeTableOfContents: false,
    baseHref: pathToFileURL(`${fixtureRoot}${path.sep}`).href,
    mermaidRuntimeSrc: pathToFileURL(path.join(repoRoot, 'webview/dist/mermaid.min.js')).href,
    shikiLanguageAssetsRoot: path.join(repoRoot, 'webview/dist')
  });
  await exportRuntime.writeDocxExport({ htmlDocument: rendered.htmlDocument, outputDocxPath,
    title: 'HTML visibility', uiLanguage: 'en', includeTableOfContents: false,
    docxRuntimeModulePath: path.join(repoRoot, 'dist/docx-runtime.js'),
    puppeteerRuntimeModulePath: path.join(repoRoot, 'dist/puppeteer-runtime.js') });
  const archive = await JSZip.loadAsync(fs.readFileSync(outputDocxPath));
  const xml = await archive.file('word/document.xml')!.async('string');
  assert.doesNotMatch(xml, /hidden-(?:attribute|display|opacity|visibility|transparent|inherited|short-alpha|rgba|zero|closed)/,
    'Word conversion must omit text hidden by the browser');
  for (const visible of ['visible-override', 'visible-colored', 'visible-sized', 'closed-summary', 'Visible black text', 'visible-red', 'visible-green']) {
    assert.ok(xml.includes(visible), `Visible HTML text must remain: ${visible}`);
  }
  assert.match(xml, /<w:t\b[^>]*>  Materialized  spaces<\/w:t>/,
    'browser materialization must retain consecutive and leading spaces for Word');
  assert.match(xml, /<w:t\b[^>]*>  Next  line <\/w:t>[^]*<w:t\b[^>]*> bold  text <\/w:t>/,
    'materialized Word text must retain indentation and spaces across styled runs');
  assert.equal(Object.keys(archive.files).filter(name => name.startsWith('word/media/')).length, 0,
    'hidden HTML images must not be embedded in Word');
  console.log('DOCX HTML visibility and visible-child overrides passed.');
}

try {
  await assertLongMermaidLabelMaterializesWithoutCropping();
  await checkHtmlVisibility();
  await assertInlineContentAndChapterAnchors();
  const outputDocxPath = path.join(fixtureRoot, 'rich-media.docx');
  const rendered = await exportRuntime.renderExportHtmlDocument({
    readingSnapshot: {
      snapshotId: 'docx-rich-media',
      text: `\`\`\`mermaid\n${complexMermaidSamples.find(sample => sample.id === 'flow')!.source}\n\`\`\`\n\n$$x^2 + y^2 = z^2$$`,
      appearance: 'dark',
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
    docxRuntimeModulePath: path.join(repoRoot, 'dist', 'docx-runtime.js'),
    puppeteerRuntimeModulePath: path.join(repoRoot, 'dist', 'puppeteer-runtime.js'),
    timeoutMs: 60000
  });

  const archive = await JSZip.loadAsync(fs.readFileSync(outputDocxPath));
  const documentXml = await archive.file('word/document.xml')?.async('string');
  assert.match(documentXml ?? '', /<w:drawing>/, 'rendered Mermaid and display math must be embedded as images');
  const pageHeight = Number(/<w:pgSz[^>]*w:h="(\d+)"/.exec(documentXml!)?.[1]);
  const topMargin = Number(/<w:pgMar[^>]*w:top="(\d+)"/.exec(documentXml!)?.[1]);
  const bottomMargin = Number(/<w:pgMar[^>]*w:bottom="(\d+)"/.exec(documentXml!)?.[1]);
  const usableHeightEmu = (pageHeight - topMargin - bottomMargin) * 635;
  const pageWidth = Number(/<w:pgSz[^>]*w:w="(\d+)"/.exec(documentXml!)?.[1]);
  const leftMargin = Number(/<w:pgMar[^>]*w:left="(\d+)"/.exec(documentXml!)?.[1]);
  const rightMargin = Number(/<w:pgMar[^>]*w:right="(\d+)"/.exec(documentXml!)?.[1]);
  const usableWidthEmu = (pageWidth - leftMargin - rightMargin) * 635;
  const drawingHeights = Array.from(documentXml!.matchAll(/<wp:extent[^>]*cy="(\d+)"/g), match => Number(match[1]));
  const drawingWidths = Array.from(documentXml!.matchAll(/<wp:extent[^>]*cx="(\d+)"/g), match => Number(match[1]));
  assert.ok(drawingHeights.length >= 2 && drawingHeights.every(height => height < usableHeightEmu), 'A tall diagram must fit Word page height without clipping');
  assert.ok(drawingWidths.every(width => width <= usableWidthEmu), 'Diagram sizing must also respect Word page width');
  assert.equal(
    Object.keys(archive.files).filter((name) => name.startsWith('word/media/')).length >= 2,
    true,
    'DOCX must contain materialized Mermaid and display-math image assets'
  );

  console.log('DOCX rich-media browser checks passed.');

  const outputPdfPath = path.join(fixtureRoot, 'rich-media.pdf');
  const pdf = await exportRuntime.renderExportHtmlDocument({
    readingSnapshot: {
      snapshotId: 'pdf-rich-media',
      text: ['# PDF fixture', `\`\`\`mermaid\n${mermaidLabelSamples[0].source}\n\`\`\``, '$$x^2 + y^2 = z^2$$',
        '![Missing shown image](absent.png)', '<img hidden src="hidden-absent.png" alt="Hidden image">'].join('\n\n'),
      appearance: 'dark', uiLanguage: 'en',
      environment: { previewFontFamily: '', previewSourceColoring: true }
    },
    sourceDocumentPath: path.join(fixtureRoot, 'rich-media.md'),
    outputFilePath: outputPdfPath, target: 'pdf',
    mermaidRuntimeSrc: pathToFileURL(path.join(repoRoot, 'webview/dist/mermaid.min.js')).toString(),
    katexStylesHref: pathToFileURL(path.join(repoRoot, 'webview/dist/katex/katex.min.css')).toString(),
    baseHref: pathToFileURL(`${fixtureRoot}${path.sep}`).toString(),
    title: 'Rich media PDF', includeTableOfContents: true,
    shikiLanguageAssetsRoot: path.join(repoRoot, 'webview/dist')
  });
  const { missingImages } = await renderPdfFromHtmlExport({
    htmlDocument: pdf.htmlDocument, outputPdfPath,
    puppeteerRuntimeModulePath: path.join(repoRoot, 'dist/puppeteer-runtime.js'),
    timeoutMs: 60000
  });
  assert.equal(missingImages, 1, 'Missing visible images are reported, hidden resource failures do not count');
  const pdfBytes = fs.readFileSync(outputPdfPath);
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdfBytes.toString('latin1'), /\/Type\s*\/Page\b/);
  assert.match(pdfBytes.subarray(-32).toString(), /%%EOF/);
  assert.ok(pdfBytes.length > 1000, 'Rich-media PDF must contain a complete document');
  console.log('PDF rich-media file generation passed.');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
