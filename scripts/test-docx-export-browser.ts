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

const repoRoot = path.resolve(import.meta.dir, '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-docx-browser-'));

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
    let firstInk = info.width;
    let lastInk = -1;
    for (let pixel = 0; pixel < data.length; pixel += info.channels) {
      const [red, green, blue] = [data[pixel]!, data[pixel + 1]!, data[pixel + 2]!];
      // Mermaid label text is dark; node borders are neutral gray and arrows are blue.
      if (red < 90 && green < 100 && blue < 110) {
        const x = (pixel / info.channels) % info.width;
        firstInk = Math.min(firstInk, x);
        lastInk = Math.max(lastInk, x);
      }
    }
    return { name, width: info.width, height: info.height, firstInk, lastInk, span: lastInk - firstInk + 1 };
  }));
  assert.ok(inkSpans.some(image => image.lastInk >= image.firstInk && image.span >= 170),
    `DOCX Mermaid PNG must rasterize the full long identifier, not its 120px prefix: ${JSON.stringify(inkSpans)}`);
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
    '<p>Visible black text, <span style="color:red">visible-red</span> and <span style="color:green">visible-green</span>.</p>'
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
  assert.equal(Object.keys(archive.files).filter(name => name.startsWith('word/media/')).length, 0,
    'hidden HTML images must not be embedded in Word');
  console.log('DOCX HTML visibility and visible-child overrides passed.');
}

try {
  await assertLongMermaidLabelMaterializesWithoutCropping();
  await checkHtmlVisibility();
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
      text: '# PDF fixture\n\n```mermaid\ngraph LR\n  A --> B\n```\n\n$$x^2 + y^2 = z^2$$',
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
  await renderPdfFromHtmlExport({
    htmlDocument: pdf.htmlDocument, outputPdfPath,
    puppeteerRuntimeModulePath: path.join(repoRoot, 'dist/puppeteer-runtime.js'),
    timeoutMs: 60000
  });
  const pdfBytes = fs.readFileSync(outputPdfPath);
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdfBytes.toString('latin1'), /\/Type\s*\/Page\b/);
  assert.match(pdfBytes.subarray(-32).toString(), /%%EOF/);
  assert.ok(pdfBytes.length > 1000, 'Rich-media PDF must contain a complete document');
  console.log('PDF rich-media file generation passed.');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
