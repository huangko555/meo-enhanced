import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import exportRuntime from '../src/export/runtime';

const root = path.resolve(import.meta.dir, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-reading-surface-'));
const longToken = 'wrappable'.repeat(90);
const codeSource = `/* comment\n${longToken}\ncontinues */\n`;
const mermaidFallbackSource = `invalid ${longToken}\n`;
const wideImage = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="120" viewBox="0 0 1600 120"><rect width="1600" height="120" fill="#999"/></svg>',
  'utf8'
).toString('base64');
const failingMermaidRuntimeSrc = `data:text/javascript;base64,${Buffer.from(`
  window.mermaid = {
    initialize() {},
    async render() { throw new Error('invalid diagram'); }
  };
`, 'utf8').toString('base64')}`;
const markdown = [
  '```javascript',
  '/* comment',
  longToken,
  'continues */',
  '```',
  '',
  '```mermaid',
  `invalid ${longToken}`,
  '```',
  '',
  '| Column |',
  '| --- |',
  `| ${longToken} |`,
  '',
  `<img alt="wide" width="1600" height="120" src="data:image/svg+xml;base64,${wideImage}">`,
  '',
  '$$x^2 + y^2 = z^2$$'
].join('\n');

const initMessage = {
  type: 'init',
  documentId: 'file:///preview-reading-surface.md',
  text: markdown,
  version: 1,
  savedRevision: { version: 1, text: markdown },
  diagnostics: [],
  mode: 'preview',
  previewAppearance: 'light',
  previewSourceColoring: true,
  editorAppearance: 'light',
  gitChangesGutter: false,
  gitDiffLineHighlights: false,
  diffBaselineMode: 'current-edit',
  fixedBaselinePinned: false,
  fixedBaselineActive: false,
  contentMaxWidthEnabled: false,
  findOptions: { wholeWord: false, caseSensitive: false },
  outlinePosition: 'right',
  outlineVisible: false,
  outlineWidth: 260,
  vscodeTheme: null
} as const;

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(root, 'scripts', 'test-preview-reading-surface-production-entry.ts')],
    outdir: temp,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.exposeFunction('__renderPreviewThroughHost', (raw: unknown) => {
      const request = decodeWebviewToHostMessage(raw);
      assert.equal(request?.type, 'requestPreviewRender');
      if (request?.type !== 'requestPreviewRender') throw new Error('Preview request failed Protocol decoding');
      const rendered = exportRuntime.renderPreviewDocument({
        markdownText: request.text,
        sourceDocumentPath: 'C:/preview-reading-surface.md',
        styleEnvironment: request.environment
      });
      const response = decodeHostToWebviewMessage({
        type: 'previewRenderResult',
        requestId: request.requestId,
        result: { ok: true, value: rendered }
      });
      assert.equal(response?.type, 'previewRenderResult');
      return response;
    });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style><div id="app"><div class="mode-toolbar meo-preload-toolbar"></div><div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div></div>');
    await page.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ url: failingMermaidRuntimeSrc });
    await page.addScriptTag({ content: `
      window.acquireVsCodeApi=()=>(
        {
          postMessage(message) {
            if (message.type !== 'requestPreviewRender') return;
            window.__renderPreviewThroughHost(message).then((response) => {
              window.dispatchEvent(new MessageEvent('message', { data: response }));
            });
          },
          getState() { return undefined; },
          setState() {}
        }
      );
    ` });
    await page.addScriptTag({ path: path.join(temp, 'bundle.js') });
    await page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), initMessage);
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
      return frame?.contentDocument?.body.textContent?.includes('continues */') === true;
    });
    const initialRows = await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')
        ?.contentDocument?.querySelectorAll('.meo-export-code-line').length ?? 0
    ));
    assert.equal(initialRows, 3, 'Preview must expose one independent row per fenced source line');
    await page.waitForFunction(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')
        ?.contentDocument?.querySelector('.meo-export-mermaid.is-error code') !== null
    ));

    for (const width of [420, 1200]) {
      await page.setViewport({ width, height: 700, deviceScaleFactor: 1 });
      const result = await page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
        const doc = frame.contentDocument!;
        const code = doc.querySelector<HTMLElement>('pre.meo-export-code-block code')!;
        const pre = code.closest<HTMLElement>('pre')!;
        const pageRoot = doc.querySelector<HTMLElement>('.meo-export-doc')!;
        const rows = Array.from(code.querySelectorAll<HTMLElement>('.meo-export-code-line'));
        const gutters = Array.from(code.querySelectorAll<HTMLElement>('.meo-export-code-line-number'));
        const sources = Array.from(code.querySelectorAll<HTMLElement>('.meo-export-code-line-source'));
        const longRange = doc.createRange();
        longRange.selectNodeContents(sources[1]);
        const selection = doc.defaultView!.getSelection()!;
        const fullRange = doc.createRange();
        fullRange.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(fullRange);
        const selected = selection.toString();
        const copied = doc.execCommand('copy');
        const rootRect = pageRoot.getBoundingClientRect();
        const preRect = pre.getBoundingClientRect();
        const bodyRect = sources[1].getBoundingClientRect();
        const fragments = Array.from(longRange.getClientRects());
        const adjacent = Array.from(doc.querySelectorAll<HTMLElement>('.meo-table-scroll, img, .meo-export-math'));
        const mermaidFallback = doc.querySelector<HTMLElement>('.meo-export-mermaid code')!;
        const mermaidRange = doc.createRange();
        mermaidRange.selectNodeContents(mermaidFallback);
        const mermaidStyle = getComputedStyle(mermaidFallback);
        return {
          rows: rows.length,
          selected,
          copied,
          documentOverflow: doc.documentElement.scrollWidth - doc.documentElement.clientWidth,
          bodyOverflow: doc.body.scrollWidth - doc.body.clientWidth,
          pageOverflow: pageRoot.scrollWidth - pageRoot.clientWidth,
          preOverflow: pre.scrollWidth - pre.clientWidth,
          preOverflowX: getComputedStyle(pre).overflowX,
          rootRect: { left: rootRect.left, right: rootRect.right, width: rootRect.width },
          preRect: { left: preRect.left, right: preRect.right },
          bodyLeft: bodyRect.left,
          fragmentCount: fragments.length,
          continuationLefts: fragments.slice(1).map((rect) => rect.left),
          gutterWidths: gutters.map((gutter) => gutter.getBoundingClientRect().width),
          gutterAlignments: gutters.map((gutter) => getComputedStyle(gutter).textAlign),
          gutterSelections: gutters.map((gutter) => getComputedStyle(gutter).userSelect),
          gutterAria: gutters.map((gutter) => gutter.getAttribute('aria-hidden')),
          gutterNumbers: gutters.map((gutter) => gutter.dataset.lineNumber),
          sourceLefts: sources.map((source) => source.getBoundingClientRect().left),
          adjacentWithinPage: adjacent.every((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1;
          }),
          adjacentKinds: {
            table: Boolean(doc.querySelector('.meo-table-scroll table')),
            media: Boolean(doc.querySelector('img')),
            math: Boolean(doc.querySelector('.meo-export-math'))
          },
          mermaidFallback: {
            source: mermaidFallback.textContent,
            fontSize: Number.parseFloat(mermaidStyle.fontSize),
            lineHeight: Number.parseFloat(mermaidStyle.lineHeight),
            fragments: mermaidRange.getClientRects().length
          }
        };
      });

      assert.equal(result.rows, 3);
      assert.equal(result.selected, codeSource);
      assert.equal(result.copied, true);
      assert.ok(result.documentOverflow <= 1 && result.bodyOverflow <= 1 && result.pageOverflow <= 1 && result.preOverflow <= 1, JSON.stringify(result));
      assert.notEqual(result.preOverflowX, 'auto');
      assert.notEqual(result.preOverflowX, 'scroll');
      assert.ok(result.rootRect.left >= -1 && result.rootRect.right <= width + 1 && result.rootRect.width <= 900 + 1, JSON.stringify(result));
      assert.ok(result.preRect.left >= result.rootRect.left - 1 && result.preRect.right <= result.rootRect.right + 1, JSON.stringify(result));
      assert.ok(result.fragmentCount > 1, JSON.stringify(result));
      assert.ok(result.continuationLefts.every((left) => Math.abs(left - result.bodyLeft) <= 1), JSON.stringify(result));
      assert.ok(result.gutterWidths.every((value) => Math.abs(value - result.gutterWidths[0]) <= 0.01));
      assert.deepEqual(result.gutterAlignments, ['right', 'right', 'right']);
      assert.deepEqual(result.gutterSelections, ['none', 'none', 'none']);
      assert.deepEqual(result.gutterAria, ['true', 'true', 'true']);
      assert.deepEqual(result.gutterNumbers, ['1', '2', '3']);
      assert.ok(result.sourceLefts.every((value) => Math.abs(value - result.sourceLefts[0]) <= 0.01));
      assert.equal(result.adjacentWithinPage, true);
      assert.deepEqual(result.adjacentKinds, { table: true, media: true, math: true });
      assert.equal(result.mermaidFallback.source, mermaidFallbackSource);
      assert.ok(result.mermaidFallback.fontSize > 0 && result.mermaidFallback.lineHeight > 0, JSON.stringify(result));
      assert.ok(result.mermaidFallback.fragments > 1, JSON.stringify(result));
    }

    const exportedFallback = exportRuntime.renderExportHtmlDocument({
      readingSnapshot: {
        snapshotId: 'g2a-mermaid-fallback',
        text: `\`\`\`mermaid\n${mermaidFallbackSource}\`\`\``,
        appearance: 'light',
        environment: {}
      },
      sourceDocumentPath: 'C:/preview-reading-surface.md',
      outputFilePath: 'C:/preview-reading-surface.html',
      target: 'html',
      mermaidRuntimeSrc: failingMermaidRuntimeSrc,
      baseHref: 'file:///C:/',
      title: 'G2a Mermaid fallback'
    });
    const exportPage = await browser.newPage();
    try {
      await exportPage.setViewport({ width: 420, height: 700, deviceScaleFactor: 1 });
      await exportPage.setContent(exportedFallback.htmlDocument, { waitUntil: 'domcontentloaded' });
      await exportPage.waitForFunction(() => (window as typeof window & { __MEO_EXPORT_READY__?: boolean }).__MEO_EXPORT_READY__ === true);
      const exportFallback = await exportPage.evaluate(() => {
        const code = document.querySelector<HTMLElement>('.meo-export-mermaid.is-error code')!;
        const style = getComputedStyle(code);
        const range = document.createRange();
        range.selectNodeContents(code);
        return {
          source: code.textContent,
          fontSize: Number.parseFloat(style.fontSize),
          lineHeight: Number.parseFloat(style.lineHeight),
          fragments: range.getClientRects().length
        };
      });
      assert.equal(exportFallback.source, mermaidFallbackSource);
      assert.ok(exportFallback.fontSize > 0 && exportFallback.lineHeight > 0, JSON.stringify(exportFallback));
      assert.ok(exportFallback.fragments > 1, JSON.stringify(exportFallback));
    } finally {
      await exportPage.close();
    }
  } finally {
    await browser.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('Preview reading surface production checks passed');
}

await main();
