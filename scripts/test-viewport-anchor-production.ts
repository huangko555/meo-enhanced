import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-viewport-anchor-production-'));

const waitForFrames = async (page: Page, count = 2): Promise<void> => {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
};

const fixtureLines = Array.from({ length: 180 }, (_, index) => `semantic line ${index + 1}`);
fixtureLines[19] = '| column A | column B |';
fixtureLines[20] = '| --- | --- |';
for (let line = 21; line <= 35; line += 1) {
  fixtureLines[line] = `| rendered row ${line - 20} | value ${line - 20} |`;
}
fixtureLines[119] = 'semantic anchor selection';
const fixture = fixtureLines.join('\n');
const selectionStart = fixture.indexOf('semantic anchor selection');
const selectionEnd = selectionStart + 'semantic anchor'.length;
const renderedBlockStart = fixture.indexOf('| column A | column B |');

const previewHtml = [
  ...Array.from({ length: 180 }, (_, index) => {
    const line = index + 1;
    if (line === 20) {
      return '<table data-source-line="20" data-source-end-line="36" style="display:block;height:520px;margin:0"><tbody><tr><td>rendered table block</td></tr></tbody></table>';
    }
    if (line > 20 && line <= 36) return '';
    return `<p data-source-line="${line}" style="height:28px;margin:0">semantic line ${line}</p>`;
  }),
  '<div class="meo-export-mermaid" data-source-line="150" data-source-b64="Zmxvd2NoYXJ0IFREO0EtLT5C"></div>'
].join('');

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-viewport-anchor-production-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    page.on('console', (message) => console.log(message.text()));
    page.on('pageerror', (error) => console.error(error));
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><body class="vscode-light"><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar" role="presentation" aria-hidden="true"></div>
      <div class="editor-wrapper meo-preload-editor-shell" role="presentation" aria-hidden="true">
        <div class="editor-host"></div>
      </div>
    </div></body>`);
    await page.addStyleTag({ content: ':root{--vscode-editor-background:#fff;--vscode-editor-foreground:#24292f;--vscode-sideBar-background:#f6f8fa;--vscode-panel-border:#d0d7de;--vscode-toolbar-hoverBackground:#eaeef2} html,body,#app{height:100%;margin:0} #app{display:flex;flex-direction:column}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    const mermaidRuntime = `data:text/javascript;base64,${Buffer.from(`
      window.mermaid = {
        initialize() {},
        async render() {
          window.parent.__viewportAnchorMermaidRenderCount = (window.parent.__viewportAnchorMermaidRenderCount || 0) + 1;
          await new Promise((resolve) => { window.parent.__releaseViewportAnchorMermaid = resolve; });
          return { svg: '<svg width="800" height="1200" viewBox="0 0 800 1200"><rect width="200" height="100"></rect></svg>' };
        }
      };
    `, 'utf8').toString('base64')}`;
    await page.addScriptTag({ content: `
      window.__hostMessages = [];
      document.body.dataset.meoMermaidSrc = ${JSON.stringify(mermaidRuntime)};
      window.mermaid = {
        initialize() {},
        async render() {
          window.__viewportAnchorMermaidRenderCount = (window.__viewportAnchorMermaidRenderCount || 0) + 1;
          await new Promise((resolve) => { window.__releaseViewportAnchorMermaid = resolve; });
          return { svg: '<svg width="800" height="1200" viewBox="0 0 800 1200"><rect width="200" height="100"></rect></svg>' };
        }
      };
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__hostMessages.push(message); },
        getState() { return window.__webviewState; },
        setState(state) { window.__webviewState = state; }
      });
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await page.evaluate((text) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', documentId: 'file:///viewport-anchor.md', text, version: 1,
        savedRevision: { version: 1, text }, diagnostics: [], mode: 'source',
        previewAppearance: 'light', previewSourceColoring: true, editorAppearance: 'light',
        gitChangesGutter: false, gitDiffLineHighlights: false,
        diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false, longCodeBlockFoldingEnabled: true,
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        vscodeTheme: null
      }}));
    }, fixture);
    await page.waitForSelector('.editor-host > .cm-editor');
    await page.evaluate(({ anchor, head }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor, head, focus: true
      }}));
    }, { anchor: selectionStart, head: selectionEnd });
    await waitForFrames(page, 4);

    await page.click('[data-mode="preview"]');
    const requestId = await page.waitForFunction(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string; requestId?: string }> })
        .__hostMessages?.findLast((message) => message.type === 'requestPreviewRender')?.requestId ?? ''
    )).then((handle) => handle.jsonValue() as Promise<string>);
    await page.evaluate(({ id, html }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'previewRenderResult', requestId: id,
        result: { ok: true, value: {
          html,
          hasMermaid: true,
          styles: {
            light: 'html,body{margin:0}.meo-export-doc{padding:0}',
            dark: 'html,body{margin:0}.meo-export-doc{padding:0}'
          }
        } }
      }}));
    }, { id: requestId, html: previewHtml });
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
      return Boolean(frame?.contentDocument?.querySelector('[data-source-line="120"]'));
    });
    await page.waitForFunction(() => typeof (
      window as typeof window & { __releaseViewportAnchorMermaid?: () => void }
    ).__releaseViewportAnchorMermaid === 'function');
    await waitForFrames(page, 2);

    await page.click('.preview-appearance-button[data-appearance="dark"]');
    await page.evaluate(() => (
      window as typeof window & { __releaseViewportAnchorMermaid?: () => void }
    ).__releaseViewportAnchorMermaid?.());
    await page.waitForFunction(() => (
      (window as typeof window & { __viewportAnchorMermaidRenderCount?: number })
        .__viewportAnchorMermaidRenderCount ?? 0
    ) >= 2);

    const frameSelectionPoint = await page.$eval<HTMLIFrameElement, { x: number; y: number }>('.preview-frame', (frame) => {
      const frameRect = frame.getBoundingClientRect();
      const line = Array.from(frame.contentDocument?.querySelectorAll<HTMLElement>('p[data-source-line]') ?? [])
        .find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top >= 40 && rect.bottom <= frameRect.height - 40;
        });
      if (!line) throw new Error('Missing selectable Preview line');
      const lineRect = line.getBoundingClientRect();
      return { x: frameRect.left + 8, y: frameRect.top + lineRect.top + lineRect.height / 2 };
    });
    await page.mouse.move(frameSelectionPoint.x, frameSelectionPoint.y);
    await page.mouse.down();
    await page.mouse.move(frameSelectionPoint.x + 140, frameSelectionPoint.y, { steps: 8 });
    await page.mouse.up();
    await page.mouse.wheel({ deltaY: -900 });
    await waitForFrames(page, 2);

    const traceResult = await page.evaluate(async () => {
      const observation = (window as typeof window & {
        ProductFrameObservation: {
          observeContinuousFrames: Function;
          assertNoDirectionReversal: Function;
        };
        __releaseViewportAnchorMermaid?: () => void;
      }).ProductFrameObservation;
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const sample = () => {
        const frameDocument = frame.contentDocument!;
        const scroller = frameDocument.scrollingElement!;
        const editorContent = document.querySelector<HTMLElement>('.editor-host .cm-content');
        const visible = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]')).find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > 0 && rect.top <= 8;
        }) ?? frameDocument.querySelector<HTMLElement>('[data-source-line]')!;
        const line = Number(visible.dataset.sourceLine ?? 1);
        return {
          anchor: {
            key: `line:${line}`,
            documentPosition: line,
            viewportOffset: visible.getBoundingClientRect().top
          },
          metrics: {
            scrollTop: scroller.scrollTop,
            rendered: frameDocument.querySelector('.meo-export-mermaid svg') ? 1 : 0,
            mode: document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview' ? 1 : 0,
            selectionLength: frameDocument.getSelection()?.toString().length ?? 0,
            focusOwner: document.activeElement === frame
              ? 2
              : editorContent && document.activeElement && editorContent.contains(document.activeElement) ? 1 : 0,
            textPresent: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
              .some((lineElement) => lineElement.textContent === 'semantic anchor selection') ? 1 : 0
          }
        };
      };
      const before = sample();
      const trace = await observation.observeContinuousFrames(sample, {
        trigger: () => window.__releaseViewportAnchorMermaid?.(),
        stableFrameCount: 4,
        maxFrameCount: 60,
        tolerance: 0.5
      });
      observation.assertNoDirectionReversal(trace, (entry: any) => entry.metrics.scrollTop, 0.5);
      return {
        before,
        samples: trace.samples.map((entry: any) => ({
          key: entry.anchor?.key,
          offset: entry.anchor?.viewportOffset,
          scrollTop: entry.metrics.scrollTop,
          rendered: entry.metrics.rendered,
          mode: entry.metrics.mode,
          selectionLength: entry.metrics.selectionLength,
          focusOwner: entry.metrics.focusOwner,
          textPresent: entry.metrics.textPresent
        }))
      };
    });
    const scrollValues = traceResult.samples.map((sample) => sample.scrollTop);
    assert.equal(traceResult.samples.at(-1)?.rendered, 1, 'trace must include the settled Preview Mermaid');
    assert.ok(traceResult.before.metrics.selectionLength > 0, 'trace must include a real Preview selection');
    assert.equal(traceResult.before.metrics.focusOwner, 2, 'trace must include focus inside the Preview iframe');
    assert.ok(
      scrollValues.every((value) => Math.abs(value - traceResult.before.metrics.scrollTop) <= 1),
      `stale Preview restore overrode the wheel interaction: ${JSON.stringify(traceResult)}`
    );
    assert.ok(
      traceResult.samples.every((sample) => (
        sample.mode === traceResult.before.metrics.mode &&
        sample.selectionLength === traceResult.before.metrics.selectionLength &&
        sample.focusOwner === traceResult.before.metrics.focusOwner &&
        sample.textPresent === traceResult.before.metrics.textPresent
      )),
      `Preview settle changed mode/selection/focus/text: ${JSON.stringify(traceResult)}`
    );

    await page.click('[data-mode="live"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live');
    await waitForFrames(page, 4);
    const finalState = await page.evaluate(() => {
      const selection = window.getSelection();
      const editorContent = document.querySelector<HTMLElement>('.editor-host .cm-content');
      const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller');
      const scrollerTop = scroller?.getBoundingClientRect().top ?? 0;
      const topLine = Array.from(document.querySelectorAll<HTMLElement>('.editor-host .cm-line'))
        .find((line) => line.getBoundingClientRect().bottom > scrollerTop);
      const topLineNumber = Number(topLine?.textContent?.match(/semantic line (\d+)/)?.[1] ?? 0);
      return {
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
        selection: selection?.toString() ?? '',
        focusInEditor: Boolean(editorContent && document.activeElement && editorContent.contains(document.activeElement)),
        topLineNumber,
        topLineOffset: topLine ? scrollerTop - topLine.getBoundingClientRect().top : null
      };
    });
    assert.equal(finalState.mode, 'live');
    assert.equal(finalState.selection, 'semantic anchor');
    assert.equal(finalState.focusInEditor, true);
    assert.ok(
      finalState.topLineNumber >= 75 && finalState.topLineNumber <= 77,
      `Preview to different editable mode lost its semantic anchor: ${JSON.stringify(finalState)}`
    );
    assert.ok(Math.abs(finalState.topLineOffset ?? 99) <= 2, JSON.stringify(finalState));

    await page.evaluate((anchor) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor, head: anchor, focus: false
      }}));
    }, renderedBlockStart);
    await waitForFrames(page, 6);
    const liveRenderedAnchor = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
      const block = document.querySelector<HTMLElement>(
        '.editor-host [data-meo-rendered-block-start-line="20"]'
      )!;
      if (!block) throw new Error('Missing production Live rendered block');
      const scrollerTop = scroller.getBoundingClientRect().top;
      scroller.scrollTop += block.getBoundingClientRect().top - scrollerTop + 90;
      return Number(block.dataset.meoRenderedBlockStartLine);
    });
    assert.equal(liveRenderedAnchor, 20);
    await waitForFrames(page, 3);
    const liveOffset = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
      const block = document.querySelector<HTMLElement>(
        '.editor-host [data-meo-rendered-block-start-line="20"]'
      )!;
      return scroller.getBoundingClientRect().top - block.getBoundingClientRect().top;
    });
    assert.ok(Math.abs(liveOffset - 90) <= 2, `Live block offset was ${liveOffset}`);

    await page.click('[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
    await waitForFrames(page, 3);
    const previewRenderedOffset = await page.$eval<HTMLIFrameElement, number>('.preview-frame', (previewFrame) => {
      const block = previewFrame.contentDocument?.querySelector<HTMLElement>('[data-source-line="20"]');
      if (!block) throw new Error('Missing Preview rendered block');
      return -block.getBoundingClientRect().top;
    });
    assert.ok(
      Math.abs(previewRenderedOffset - liveOffset) <= 2,
      `Live to Preview lost rendered-block offset: ${liveOffset} -> ${previewRenderedOffset}`
    );

    await page.click('[data-mode="source"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
    await waitForFrames(page, 3);
    const sourceRenderedOffset = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
      const sourceLine = Array.from(document.querySelectorAll<HTMLElement>('.editor-host .cm-line'))
        .find((line) => line.textContent === '| rendered row 2 | value 2 |');
      if (!sourceLine) throw new Error('Missing Source line for rendered block');
      return scroller.getBoundingClientRect().top - sourceLine.getBoundingClientRect().top;
    });
    assert.ok(
      Math.abs(sourceRenderedOffset) <= 2,
      `Preview to Source lost the worked semantic line 23 / offset 0: ${sourceRenderedOffset}`
    );
    console.log(`Viewport Anchor production Chromium trace passed: ${JSON.stringify(traceResult.samples)}`);
  } finally {
    await browser.close();
  }
}

try {
  await main();
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
