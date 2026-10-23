import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import exportRuntime from '../src/export/runtime';
import { renderPdfFromHtmlExport } from '../src/export/pdfRenderer';
import { createCustomPreviewPreset } from '../src/foundation/customPreviewPreset';
import { getPreviewPreset } from '../src/foundation/previewPresets';
import { launchTestBrowser } from './browser-test-helpers';

// Inspect Chromium's page drawing streams, not just its DOM or PDF file header.
// The first full-paper rectangle paints margins and unused space on every page.
function readPaperColors(bytes: Buffer, context: string): number[][] {
  const objects = new Map(Array.from(bytes.toString('latin1').matchAll(/(\d+) \d+ obj\b([\s\S]*?)endobj/g),
    match => [Number(match[1]), match[2]!] as const));
  const colors: number[][] = [];
  for (const object of objects.values()) {
    if (!/\/Type\s*\/Page\b/.test(object.slice(0, object.indexOf('stream') < 0 ? undefined : object.indexOf('stream')))) continue;
    const reference = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(object);
    assert.ok(reference, 'Printed page must have a content stream');
    const content = objects.get(Number(reference[1]))!;
    const start = /stream\r?\n/.exec(content)!;
    const length = /\/Length\s+(\d+)/.exec(content)!;
    assert.ok(start && length, 'Chromium content streams have a direct byte length');
    const raw = Buffer.from(content.slice(start.index + start[0].length), 'latin1').subarray(0, Number(length[1]));
    const drawing = (/\/FlateDecode\b/.test(content.slice(0, start.index)) ? inflateSync(raw) : raw).toString('latin1');
    const fill = /([\d.]+) ([\d.]+) ([\d.]+) rg[\s\S]*?\b0 0 ([\d.]+) ([\d.]+) re\s+f\b/.exec(drawing);
    assert.ok(fill, 'Each printed page must paint its paper background');
    assert.ok(Number(fill[4]) > 790 && Number(fill[5]) > 1120, 'Background must cover A4 paper, including page margins');
    colors.push(fill.slice(1, 4).map(Number));
  }
  assert.ok(colors.length >= 2, `${context}: fixture must cover pagination and a partly filled last page`);
  return colors;
}

const custom = createCustomPreviewPreset({ schemaVersion: 1, id: 'pdf-paper', name: 'PDF paper', description: 'Regression fixture',
  base: 'default', themes: { light: { css: 'light.css' }, dark: { css: 'dark.css' } } }, {
  common: ':root { --paper-margin: 12mm; } @media print { @page { margin: 0; margin-left: var(--paper-margin); } }',
  light: ':root { --meo-bg: #fff0d4; }', dark: ':root { --meo-bg: #263238; }'
}, 'fixture');
const presets = [getPreviewPreset('default'), getPreviewPreset('github-readme'), getPreviewPreset('whitey'),
  getPreviewPreset('obsidian-minimal'), getPreviewPreset('newsprint'), custom];
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-pdf-paper-'));
const text = '# PDF paper\n\n' + Array.from({ length: 65 }, (_, index) => `Paragraph ${index + 1}.`).join('\n\n');
const browser = await launchTestBrowser();
let count = 0;
try {
  const page = await browser.newPage();
  await page.emulateMediaType('print');
  for (const preset of presets) for (const appearance of ['dark', 'light'] as const) {
    const outputPdfPath = path.join(temporary, `${count}.pdf`);
    const rendered = await exportRuntime.renderExportHtmlDocument({
      readingSnapshot: { snapshotId: `paper-${count}`, text,
        appearance, uiLanguage: 'en', preset: preset.id, environment: { previewFontFamily: '', previewSourceColoring: false,
          editorBackgroundColor: appearance === 'dark' ? '#22272e' : '#f4f1eb', editorForegroundColor: appearance === 'dark' ? '#d8dee9' : '#24292f' } },
      presetDefinition: preset, sourceDocumentPath: path.join(temporary, 'source.md'), outputFilePath: outputPdfPath,
      target: 'pdf', title: 'PDF paper', mermaidRuntimeSrc: '', baseHref: pathToFileURL(temporary + path.sep).href,
      shikiLanguageAssetsRoot: ''
    });
    await page.setContent(rendered.htmlDocument);
    const expected = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.fillStyle = getComputedStyle(document.querySelector('.meo-export-doc')!).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    });
    await renderPdfFromHtmlExport({ htmlDocument: rendered.htmlDocument, outputPdfPath,
      puppeteerRuntimeModulePath: require.resolve('puppeteer-core') });
    const pages = readPaperColors(fs.readFileSync(outputPdfPath), `${preset.id}/${appearance}`);
    for (const [number, color] of pages.entries()) assert.ok(color.every((channel, index) => Math.abs(channel * 255 - expected[index]!) <= 1),
      `${preset.id}/${appearance}/page ${number + 1}: paper ${color.map(channel => Math.round(channel * 255))} differs from document ${expected}`);
    count++;
  }
  console.log(`PDF paper backgrounds passed: ${count} preset/appearance cases, including custom colors, zero/variable margins and partial last pages.`);
} finally {
  await browser.close();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true, force: true });
}
