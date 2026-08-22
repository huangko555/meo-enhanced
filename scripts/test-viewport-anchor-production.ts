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
fixtureLines[119] = 'semantic anchor selection';
const fixture = fixtureLines.join('\n');
const selectionStart = fixture.indexOf('semantic anchor selection');
const selectionEnd = selectionStart + 'semantic anchor'.length;

const previewHtml = [
  ...Array.from({ length: 180 }, (_, index) => (
    `<p data-source-line="${index + 1}" style="height:28px;margin:0">semantic line ${index + 1}</p>`
  )),
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

    const frameBox = await page.$eval<HTMLIFrameElement, { x: number; y: number }>('.preview-frame', (frame) => {
      const rect = frame.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(frameBox.x, frameBox.y);
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
            selectionLength: window.getSelection()?.toString().length ?? 0,
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

    await page.click('[data-mode="source"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
    const finalState = await page.evaluate(() => {
      const selection = window.getSelection();
      const editorContent = document.querySelector<HTMLElement>('.editor-host .cm-content');
      return {
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
        selection: selection?.toString() ?? '',
        focusInEditor: Boolean(editorContent && document.activeElement && editorContent.contains(document.activeElement)),
        textVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .some((line) => line.textContent === 'semantic anchor selection')
      };
    });
    assert.deepEqual(finalState, {
      mode: 'source',
      selection: 'semantic anchor',
      focusInEditor: true,
      textVisible: true
    });
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
