import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { fitBlockMathForPdf, preparePdfPagination } from '../src/export/pdfRenderer';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import { createCustomPreviewPreset, decodeCustomPreviewPresets, parseCustomPreviewPresetManifest } from '../src/foundation/customPreviewPreset';

const root = path.resolve(import.meta.dir, '..');
const customGithubPreset = createCustomPreviewPreset(parseCustomPreviewPresetManifest({
  schemaVersion: 1, id: 'math-reflow', name: 'Math reflow', description: 'Inherited GitHub formula layout',
  base: 'github-readme', themes: { light: { css: 'light.css' }, dark: { css: 'dark.css' } }
}), { light: '', dark: '', common: '.meo-export-doc { --math-reflow-fixture: 1; }' }, 'a'.repeat(64));
assert.ok(decodeCustomPreviewPresets([customGithubPreset]), 'The custom preset fixture must follow Protocol');
const presetCases = (['github-readme', customGithubPreset.id, 'default'] as const).flatMap(preset => ([
  ['light', 'en'], ['dark', 'en'], ['light', 'zh-CN'], ['dark', 'zh-CN']
] as const).map(([appearance, uiLanguage]) => ({ preset, appearance, uiLanguage })));
const surfaces = process.argv.includes('--preview-only')
  ? ['preview'] as const : ['live', 'preview', 'source', 'html'] as const;
const reportedFormula = String.raw`f_C = \sqrt{A_d^2 - 1} \cdot f_H \approx A_d \cdot f_H\tag{1.2}`;
const formulas = [
  reportedFormula,
  String.raw`x\tag{1.2}`,
  String.raw`x+y\tag*{A}`,
  String.raw`x\tag{\text{Supplementary equation 12.34}}`,
  String.raw`\begin{aligned}a&=b+c\\d&=e+f\end{aligned}\tag{2.1}`,
  String.raw`\begin{align}a&=b\tag{A}\\c&=d\tag{B}\end{align}`,
  String.raw`\begin{gather}a=b\\c=d\end{gather}`,
  `${'x+'.repeat(40)}x\\tag{long}`
];
const wrappedFractions = Array.from({ length: 23 }, (_, index) =>
  `x_{${index + 1}}=${index + 21}+\\frac{${index + 1}}{${index + 2}}`).join('');
const wrappedNestedFractions = Array.from({ length: 23 }, (_, index) =>
  `y_{${index + 1}}+\\frac{${index + 1}}{\\frac{${index + 2}}{${index + 3}}}`).join('+');
const markdown = [
  ...formulas.map(formula => `$$\n${formula}\n$$`),
  String.raw`$$x+y\tag{same-line}$$`,
  '$$\nx^2+y^2=z^2\n$$',
  `$$\n${wrappedFractions}\n$$`,
  `$$\n${wrappedNestedFractions}\n$$`,
  String.raw`$$\begin{pmatrix}\frac{1}{2}&\frac{3}{4}\\\frac{5}{6}&\frac{7}{8}\end{pmatrix}$$`,
  'Inline control $x+1$ and $\\frac{1}{2}$ remain inline.'
].join('\n\n');
const expectedTagCount = formulas.length + 1;
const katexDirectory = path.join(root, 'node_modules/katex/dist');
const katexCss = fs.readFileSync(path.join(katexDirectory, 'katex.min.css'), 'utf8')
  .replace(/url\(([^)]+)\)/g, (_match, fontPath) => `url(data:font/woff2;base64,${fs.readFileSync(path.join(katexDirectory, fontPath)).toString('base64')})`);
const katexHref = `data:text/css;base64,${Buffer.from(katexCss).toString('base64')}`;

async function readTagLayout({ surface, selector = '.katex-html > .tag' }: { surface: string; selector?: string }) {
  const doc = surface === 'source' || surface === 'preview'
    ? document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument! : document;
  await doc.fonts.ready;
  for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  return Array.from(doc.querySelectorAll<HTMLElement>(selector)).map(tag => {
    const html = tag.parentElement!;
    const tagRect = tag.getBoundingClientRect();
    const bases = Array.from(html.querySelectorAll<HTMLElement>(':scope > .base'))
      .map(base => base.getBoundingClientRect());
    const canvas = html.closest<HTMLElement>('.meo-latex-math-canvas, .meo-export-math-canvas') ?? html;
    const canvasRect = canvas.getBoundingClientRect();
    const container = html.closest<HTMLElement>('.meo-md-math-display, .meo-export-math-display') ?? html;
    const containerRect = container.getBoundingClientRect();
    const rect = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    return {
      tag: tag.textContent, box: rect(tagRect),
      formulaLeft: Math.min(...bases.map(r => r.left)), formulaRight: Math.max(...bases.map(r => r.right)),
      overlaps: bases.some(r => r.left < tagRect.right - 0.5 && r.right > tagRect.left + 0.5
        && r.top < tagRect.bottom - 0.5 && r.bottom > tagRect.top + 0.5),
      contained: tagRect.left >= canvasRect.left - 1 && tagRect.right <= canvasRect.right + 1
        && tagRect.top >= canvasRect.top - 1 && tagRect.bottom <= canvasRect.bottom + 1,
      fitsContainer: tagRect.left >= containerRect.left - 1 && tagRect.right <= containerRect.right + 1,
      visible: tagRect.width > 0 && tagRect.height > 0
    };
  });
}

function assertTagLayout(layout: Awaited<ReturnType<typeof readTagLayout>>, count: number, context: string) {
  const detail = JSON.stringify({ context, layout });
  assert.equal(layout.length, count, detail);
  assert.ok(layout.every(item => item.visible && item.contained && !item.overlaps), detail);
}

async function readReflowLayout(surface: string) {
  const doc = surface === 'source' || surface === 'preview'
    ? document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument! : document;
  await doc.fonts.ready;
  for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const formulas = Array.from(doc.querySelectorAll<HTMLElement>('.katex-display > .katex > .katex-html'));
  const wrapped = formulas.filter(html => !html.querySelector(':scope > .tag')
    && html.querySelectorAll(':scope > .base').length > 20).map(html => {
    const rows: { baseline: number; top: number; bottom: number }[] = [];
    const bases = Array.from(html.querySelectorAll<HTMLElement>(':scope > .base'));
    const rects = bases.map(base => {
      // A zero-size inline probe locates the baseline even when adjacent bases
      // contain different-height fractions, indices or ordinary symbols.
      const marker = doc.createElement('span');
      marker.style.cssText = 'display:inline-block;width:0;height:0';
      base.appendChild(marker);
      const baseline = marker.getBoundingClientRect().top;
      marker.remove();
      const rect = base.getBoundingClientRect();
      const row = rows.find(row => Math.abs(row.baseline - baseline) < 1);
      if (row) { row.top = Math.min(row.top, rect.top); row.bottom = Math.max(row.bottom, rect.bottom); }
      else rows.push({ baseline, top: rect.top, bottom: rect.bottom });
      return rect;
    });
    rows.sort((a, b) => a.baseline - b.baseline);
    const gaps = rows.slice(1).map((row, index) => row.top - rows[index]!.bottom);
    const container = html.closest<HTMLElement>('.meo-md-math-display, .meo-export-math-display')!;
    const bounds = container.getBoundingClientRect();
    return {
      rows: rows.length, minGap: Math.min(...gaps),
      fontSize: Number.parseFloat(doc.defaultView!.getComputedStyle(html).fontSize),
      contained: rects.every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
        && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1)
    };
  });
  const preserved = Array.from(doc.querySelectorAll<HTMLElement>(
    '.katex-html > .tag, .meo-math-nowrap .katex-html > .base, .meo-md-math-inline .base, .meo-export-math-inline .base, .katex .mfrac, .katex .mtable'
  )).every(element => {
    const style = doc.defaultView!.getComputedStyle(element);
    return Number.parseFloat(style.marginTop) === 0 && Number.parseFloat(style.marginBottom) === 0;
  });
  return { wrapped, preserved };
}

function assertReflowLayout(layout: Awaited<ReturnType<typeof readReflowLayout>>, context: string) {
  const detail = JSON.stringify({ context, layout });
  assert.equal(layout.wrapped.length, 2, detail);
  assert.ok(layout.wrapped.every(formula => formula.rows > 1 && formula.contained
    && formula.minGap >= formula.fontSize * 0.2), detail);
  assert.ok(layout.preserved, detail);
}

const build = await Bun.build({
  entrypoints: [path.join(root, 'scripts/test-preview-reading-surface-production-entry.ts')],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const browser = await launchTestBrowser();
try {
  for (const { preset, appearance, uiLanguage } of presetCases) {
    for (const width of [420, 1280]) {
      for (const surface of surfaces) {
        // Live has no reading preset; exercise it once alongside Default.
        if (surface === 'live' && preset !== 'default') continue;
        const page = await browser.newPage();
        try {
          const errors: string[] = [];
          page.on('pageerror', error => errors.push(error.message));
          // Open the side pane before narrowing the host: toolbar hit testing
          // has its own coverage, while this test measures the formula layout.
          await page.setViewport({ width: surface === 'source' ? Math.max(width, 800) : width,
            height: 2400, deviceScaleFactor: 1 });
          if (surface === 'html') {
            const rendered = await exportRuntime.renderExportHtmlDocument({
              readingSnapshot: {
                snapshotId: 'tag-layout', text: markdown, appearance, uiLanguage, preset,
                environment: { previewFontFamily: '' }
              },
              sourceDocumentPath: 'C:/tmp/math-tag-layout.md', outputFilePath: 'C:/tmp/math-tag-layout.html',
              target: 'html', katexStylesHref: katexHref, title: 'Equation tag layout',
              presetDefinition: preset === customGithubPreset.id ? customGithubPreset : undefined
            });
            await page.setContent(rendered.htmlDocument);
            await page.waitForFunction(() => (window as any).__MEO_EXPORT_READY__ === true);
          } else {
            await page.exposeFunction('__renderMathTagPreview', (raw: unknown) => {
              const message = decodeWebviewToHostMessage(raw);
              assert.ok(message, 'The Webview message must follow Protocol');
              if (message.type !== 'requestPreviewRender') return null;
              return decodeHostToWebviewMessage({
                type: 'previewRenderResult', requestId: message.requestId,
                result: { ok: true, value: exportRuntime.renderPreviewDocument({
                  markdownText: message.text, sourceDocumentPath: 'C:/tmp/math-tag-layout.md',
                  uiLanguage: message.uiLanguage, styleEnvironment: message.environment, preset: message.preset,
                  presetDefinition: message.preset === customGithubPreset.id ? customGithubPreset : undefined
                }) }
              });
            });
            await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
            await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
            await page.addStyleTag({ url: katexHref });
            await page.evaluate(href => { document.body.dataset.meoKatexSrc = href; }, katexHref);
            await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__renderMathTagPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
            await page.addScriptTag({ content: bundle });
            await page.evaluate(({ text, mode, appearance, uiLanguage, preset, customPreset }) => {
              window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'init', documentId: 'file:///math-tag-layout.md', text, version: 1,
                savedRevision: { version: 1, text }, diagnostics: [], mode, uiLanguage,
                uiLanguagePreference: 'auto', automaticUiLanguage: uiLanguage, sourceLineNumbers: 'on',
                previewAppearance: appearance, previewFontFamily: '', previewSourceColoring: true,
                previewPreset: preset, customPreviewPresets: [customPreset],
                previewPresetPreferences: { [preset]: { appearance, contentWidth: 'responsive' } },
                editorAppearance: appearance, gitChangesGutter: false, gitDiffLineHighlights: false,
                gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false,
                fixedBaselineActive: false, contentMaxWidthEnabled: false,
                findOptions: { wholeWord: false, caseSensitive: false },
                outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
                restoreReadingPositionOnOpen: false, vscodeTheme: null
              } }));
            }, { text: markdown, mode: surface, appearance, uiLanguage, preset, customPreset: customGithubPreset });
            if (surface === 'live') {
              await page.waitForSelector('.meo-md-math-fenced-display .katex-html .tag');
            } else {
              if (surface === 'source') {
                await page.waitForSelector('.source-preview-button', { visible: true });
                await page.click('.source-preview-button');
                await page.setViewport({ width, height: 2400, deviceScaleFactor: 1 });
              }
              await page.waitForFunction(({ count, preset }) => {
                const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
                return doc?.documentElement.dataset.meoPreviewPreset === preset
                  && doc.querySelectorAll('.katex-html > .tag').length === count;
              }, {}, { count: expectedTagCount, preset });
              await page.waitForSelector('.preview-host:not([hidden]):not([inert]) .preview-frame', { visible: true });
              await page.evaluate(async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });
            }
          }
          const context = `${preset}, ${surface}, ${appearance}, ${uiLanguage}, ${width}px`;
          const layout = await page.evaluate(readTagLayout, { surface });
          assertTagLayout(layout, expectedTagCount, context);
          assert.ok(layout.every(item => item.fitsContainer), JSON.stringify({ context, layout }));
          assertReflowLayout(await page.evaluate(readReflowLayout, surface), context);
          if (process.argv.includes('--capture') && width === 420 && (surface === 'live' || surface === 'preview')) {
            const directory = path.join(root, '.local/test-artifacts/math-reflow');
            fs.mkdirSync(directory, { recursive: true });
            await page.screenshot({ path: path.join(directory, `${preset.replace(':', '-')}-${surface}-${appearance}-${uiLanguage}.png`), fullPage: true });
          }
          if (surface === 'html') {
            // PDF and Word's capture preparation refit the same numbered canvases.
            await page.emulateMediaType('print');
            await preparePdfPagination(page);
            await fitBlockMathForPdf(page);
            const printLayout = await page.evaluate(readTagLayout, { surface });
            assertTagLayout(printLayout, expectedTagCount, `${context}, print preparation`);
            assert.ok(printLayout.every(item => item.fitsContainer), JSON.stringify({ context, printLayout }));
            assertReflowLayout(await page.evaluate(readReflowLayout, surface), context + ', print preparation');
          }
          if (surface === 'live') {
            await page.click('.meo-md-math-fenced-display .katex');
            await page.waitForSelector('.meo-math-live-result .katex-html > .tag');
            assertTagLayout(await page.evaluate(readTagLayout, { surface }), expectedTagCount, context + ', source above result');
            assertReflowLayout(await page.evaluate(readReflowLayout, surface), context + ', source above result');
          }
          assert.deepEqual(errors, [], context);
          console.log(`Math tags fit without overlap: ${context} (${expectedTagCount} formulas)`);
        } finally {
          await page.close();
        }
      }
    }
  }
} finally {
  await browser.close();
}
