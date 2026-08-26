import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-viewport-anchor-production-'));
const editorModulePath = path.join(repoRoot, 'webview', 'src', 'editor.ts').replaceAll('\\', '/');

const waitForFrames = async (page: Page, count = 2): Promise<void> => {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
};

const scrollLiveRenderedBlockToOffset = async (
  page: Page,
  startLine: number,
  offset: number
): Promise<number> => {
  const scroll = await page.evaluate(({ line, targetOffset }) => {
    const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
    const block = document.querySelector<HTMLElement>(
      `.editor-host [data-meo-rendered-block-start-line="${line}"]`
    );
    if (!block) throw new Error(`Missing production Live rendered block at line ${line}`);
    const scrollerRect = scroller.getBoundingClientRect();
    return {
      deltaY: block.getBoundingClientRect().top - scrollerRect.top + targetOffset,
      x: scrollerRect.left + scrollerRect.width / 2,
      y: scrollerRect.top + scrollerRect.height / 2
    };
  }, { line: startLine, targetOffset: offset });
  await page.mouse.move(scroll.x, scroll.y);
  await page.mouse.wheel({ deltaY: scroll.deltaY });
  await waitForFrames(page, 3);
  return page.evaluate((line) => {
    const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
    const block = document.querySelector<HTMLElement>(
      `.editor-host [data-meo-rendered-block-start-line="${line}"]`
    );
    if (!block) throw new Error(`Missing production Live rendered block at line ${line}`);
    return scroller.getBoundingClientRect().top - block.getBoundingClientRect().top;
  }, startLine);
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

const createPreviewHtml = (lines: readonly string[]): string => [
  ...lines.map((text, index) => {
    const line = index + 1;
    if (line === 20) {
      return '<table data-source-line="20" data-source-end-line="36" style="display:block;height:520px;margin:0"><tbody><tr><td>rendered table block</td></tr></tbody></table>';
    }
    if (line > 20 && line <= 36) return '';
    return `<p data-source-line="${line}" style="height:28px;margin:0">${text}</p>`;
  }),
  '<div class="meo-export-mermaid" data-source-line="150" data-source-b64="Zmxvd2NoYXJ0IFREO0EtLT5C"></div>'
].join('');
const previewHtml = createPreviewHtml(fixtureLines);

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-viewport-anchor-production-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js',
    plugins: [{
      name: 'viewport-anchor-public-editor-seam',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/editor$/ }, () => (
          { path: 'viewport-anchor-test-editor', namespace: 'viewport-anchor-test' }
        ));
        builder.onLoad({ filter: /.*/, namespace: 'viewport-anchor-test' }, () => ({
          loader: 'ts',
          contents: `
            import { createEditor as createRealEditor } from ${JSON.stringify(editorModulePath)};
            export function createEditor(options: Parameters<typeof createRealEditor>[0]) {
              const editor = createRealEditor(options);
              let foreignEditor: ReturnType<typeof createRealEditor> | null = null;
              (window as any).__viewportAnchorTransaction = {
                editor,
                createForeignToken(text: string) {
                  if (!foreignEditor) {
                    const parent = document.createElement('div');
                    parent.style.display = 'none';
                    document.body.append(parent);
                    foreignEditor = createRealEditor({
                      ...options,
                      parent,
                      text,
                      initialMode: 'source',
                      previewViewportSurface: undefined,
                      onApplyChanges() {}
                    });
                  }
                  return foreignEditor.captureViewportAnchorToken('editor');
                },
                destroyForeign() {
                  foreignEditor?.destroy();
                  foreignEditor = null;
                }
              };
              return editor;
            }
          `
        }));
      }
    }]
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
        previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'light',
        gitChangesGutter: false, gitDiffLineHighlights: false,
        diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false,
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        vscodeTheme: null
      }}));
    }, fixture);
    await page.waitForSelector('.editor-host > .cm-editor');
    if (process.argv.includes('--rendered-block-preview-only')) {
      await page.click('[data-mode="live"]');
      await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live');
      await page.evaluate((anchor) => {
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'revealSelection', anchor, head: anchor, focus: false
        }}));
      }, renderedBlockStart);
      await waitForFrames(page, 6);
      const liveOffset = await scrollLiveRenderedBlockToOffset(page, 20, 90);
      assert.ok(Math.abs(liveOffset - 90) <= 2, `Live block offset was ${liveOffset}`);

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
            hasMermaid: false,
            styles: {
              light: 'html,body{margin:0}.meo-export-doc{padding:0}',
              dark: 'html,body{margin:0}.meo-export-doc{padding:0}'
            }
          } }
        }}));
      }, { id: requestId, html: previewHtml });
      await page.waitForFunction(() => (
        document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview' &&
        document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
          ?.querySelector('[data-source-line="20"]')
      ));
      await waitForFrames(page, 3);
      const previewOffset = await page.$eval<HTMLIFrameElement, number>('.preview-frame', (frame) => {
        const block = frame.contentDocument?.querySelector<HTMLElement>('[data-source-line="20"]');
        if (!block) throw new Error('Missing Preview rendered block');
        return -block.getBoundingClientRect().top;
      });
      assert.ok(
        Math.abs(previewOffset - liveOffset) <= 2,
        `Live to Preview lost rendered-block offset: ${liveOffset} -> ${previewOffset}`
      );
      console.log(`Live rendered block to Preview offset passed: ${liveOffset} -> ${previewOffset}`);
      return;
    }
    await page.evaluate(({ anchor, head }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor, head, focus: true
      }}));
    }, { anchor: selectionStart, head: selectionEnd });
    await waitForFrames(page, 4);

    const invalidTransactionTrace = await page.evaluate(async (originalText) => {
      const seam = (window as any).__viewportAnchorTransaction;
      const editor = seam.editor;
      const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
      const wait = async (frameCount = 10) => {
        for (let index = 0; index < frameCount; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const foreignText = `expanded invalid foreign heading\n${originalText}`;
      const foreignToken = seam.createForeignToken(originalText);
      let foreignTarget = 0;
      await editor.runViewportAnchorTransaction(foreignToken, 'editor', async () => {
        editor.setText(foreignText);
        await wait(2);
        foreignTarget = Math.min(640, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
        scroller.scrollTop = foreignTarget;
      });
      await wait();
      const foreign = {
        scrollTop: scroller.scrollTop,
        target: foreignTarget,
        maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        text: editor.getText()
      };

      let nullTarget = 0;
      await editor.runViewportAnchorTransaction(null, 'editor', async () => {
        editor.setText(originalText);
        await wait(2);
        nullTarget = Math.min(420, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
        scroller.scrollTop = nullTarget;
      });
      await wait();
      return {
        foreign,
        nullToken: {
          scrollTop: scroller.scrollTop,
          target: nullTarget,
          maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
          text: editor.getText()
        }
      };
    }, fixture);
    assert.equal(invalidTransactionTrace.foreign.text.startsWith('expanded invalid foreign heading\n'), true);
    assert.ok(
      Math.abs(
        invalidTransactionTrace.foreign.scrollTop - Math.min(
          invalidTransactionTrace.foreign.target,
          invalidTransactionTrace.foreign.maxScrollTop
        )
      ) <= 40,
      `foreign receipt pulled the production viewport back: ${JSON.stringify(invalidTransactionTrace)}`
    );
    assert.equal(invalidTransactionTrace.nullToken.text, fixture);
    assert.ok(
      Math.abs(
        invalidTransactionTrace.nullToken.scrollTop - Math.min(
          invalidTransactionTrace.nullToken.target,
          invalidTransactionTrace.nullToken.maxScrollTop
        )
      ) <= 1,
      `null receipt pulled the production viewport back: ${JSON.stringify(invalidTransactionTrace)}`
    );
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
    const previewExitAnchor = traceResult.before.anchor;
    const previewExitLine = previewExitAnchor.documentPosition;
    assert.ok(
      Number.isInteger(previewExitLine) && previewExitLine >= 1 && previewExitLine <= fixtureLines.length,
      `Preview anchor must expose a 1-based source line: ${JSON.stringify(previewExitAnchor)}`
    );
    const previewExitText = fixtureLines[previewExitLine - 1];
    assert.equal(
      fixtureLines.filter((line) => line === previewExitText).length,
      1,
      `Preview anchor line must have unique public text: ${JSON.stringify(previewExitAnchor)}`
    );
    const finalState = await page.evaluate(({ anchorLine, anchorText }) => {
      const selection = window.getSelection();
      const editorContent = document.querySelector<HTMLElement>('.editor-host .cm-content');
      const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller');
      const scrollerTop = scroller?.getBoundingClientRect().top ?? 0;
      const anchors = Array.from(document.querySelectorAll<HTMLElement>('.editor-host .cm-line'))
        .filter((line) => line.textContent === anchorText);
      const anchor = anchors.length === 1 ? anchors[0] : null;
      return {
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
        selection: selection?.toString() ?? '',
        focusInEditor: Boolean(editorContent && document.activeElement && editorContent.contains(document.activeElement)),
        anchorLine,
        anchorMatches: anchors.length,
        anchorViewportOffset: anchor ? anchor.getBoundingClientRect().top - scrollerTop : null
      };
    }, {
      anchorLine: previewExitLine,
      anchorText: previewExitText
    });
    assert.equal(finalState.mode, 'live');
    assert.equal(finalState.selection, 'semantic anchor');
    assert.equal(finalState.focusInEditor, true);
    assert.equal(finalState.anchorMatches, 1, `Expected one public anchor line: ${JSON.stringify(finalState)}`);
    assert.ok(
      Math.abs((finalState.anchorViewportOffset ?? 99) - previewExitAnchor.viewportOffset) <= 2,
      `Preview to different editable mode lost its semantic anchor: ${JSON.stringify(finalState)}`
    );
    if (process.argv.includes('--preview-live-only')) {
      console.log(`Preview to Live semantic anchor passed: ${JSON.stringify(finalState)}`);
      return;
    }

    await page.evaluate((anchor) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor, head: anchor, focus: false
      }}));
    }, renderedBlockStart);
    await waitForFrames(page, 6);
    const liveRenderedAnchor = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>(
        '.editor-host [data-meo-rendered-block-start-line="20"]'
      )!;
      if (!block) throw new Error('Missing production Live rendered block');
      return Number(block.dataset.meoRenderedBlockStartLine);
    });
    assert.equal(liveRenderedAnchor, 20);
    const liveOffset = await scrollLiveRenderedBlockToOffset(page, 20, 90);
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

    const moveHiddenEditorAndPreview = async (
      documentText: string,
      hiddenLine: number,
      previewLine: number,
      previewOffset: number
    ) => {
      const lines = documentText.split('\n');
      const hiddenPosition = lines.slice(0, hiddenLine - 1).reduce((length, line) => length + line.length + 1, 0);
      await page.evaluate((position) => {
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'revealSelection', anchor: position, head: position, focus: false, preserveViewport: false
        }}));
      }, hiddenPosition);
      await waitForFrames(page, 3);
      await page.evaluate(({ line, offset }) => {
        const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
        const target = frame.contentDocument?.querySelector<HTMLElement>(`[data-source-line="${line}"]`);
        if (!target) throw new Error(`Missing Preview line ${line}`);
        const scroller = frame.contentDocument!.scrollingElement!;
        scroller.scrollTop += target.getBoundingClientRect().top + offset;
        const selection = frame.contentDocument!.getSelection()!;
        const range = frame.contentDocument!.createRange();
        range.selectNodeContents(target);
        selection.removeAllRanges();
        selection.addRange(range);
        frame.contentDocument!.body.tabIndex = -1;
        frame.contentDocument!.body.focus({ preventScroll: true });
      }, { line: previewLine, offset: previewOffset });
      await waitForFrames(page, 2);
    };
    const readPreviewTrace = async () => page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const frameDocument = frame.contentDocument!;
      const visible = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
        .find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top <= 0 && rect.bottom > 0;
        });
      const editorScroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
      const editorTop = editorScroller.getBoundingClientRect().top;
      const hiddenEditorLine = Array.from(document.querySelectorAll<HTMLElement>('.editor-host .cm-line'))
        .findIndex((line) => line.getBoundingClientRect().bottom > editorTop) + 1;
      const hiddenSelectionText = document.querySelector<HTMLElement>('.editor-host .cm-activeLine')?.textContent ?? '';
      return {
        line: Number(visible?.dataset.sourceLine ?? 0),
        offset: visible ? -visible.getBoundingClientRect().top : null,
        hiddenEditorLine,
        hiddenSelectionText,
        focusInPreview: document.activeElement === frame,
        focusInEditor: Boolean(document.activeElement && document.querySelector('.editor-host')?.contains(document.activeElement)),
        selectionLength: frameDocument.getSelection()?.toString().length ?? 0,
        text: Array.from(document.querySelectorAll<HTMLElement>('.editor-host .cm-line'))
          .map((line) => line.textContent ?? '').join('\n')
      };
    });
    const fulfillNextPreviewRender = async (
      previousRequestId: string,
      html: string,
      firstLine: string
    ): Promise<string> => {
      const nextRequestId = await page.waitForFunction((previous) => (
        (window as typeof window & { __hostMessages?: Array<{ type?: string; requestId?: string }> })
          .__hostMessages?.findLast((message) => (
            message.type === 'requestPreviewRender' && message.requestId !== previous
          ))?.requestId ?? ''
      ), {}, previousRequestId).then((handle) => handle.jsonValue() as Promise<string>);
      await page.evaluate(({ id, nextHtml }) => {
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'previewRenderResult', requestId: id,
          result: { ok: true, value: {
            html: nextHtml,
            hasMermaid: false,
            styles: {
              light: 'html,body{margin:0}.meo-export-doc{padding:0}',
              dark: 'html,body{margin:0}.meo-export-doc{padding:0}'
            }
          } }
        }}));
      }, { id: nextRequestId, nextHtml: html });
      await page.waitForFunction((expected) => (
        document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
          ?.querySelector<HTMLElement>('[data-source-line="1"]')?.textContent === expected
      ), {}, firstLine);
      await waitForFrames(page, 6);
      return nextRequestId;
    };

    await page.click('[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
    await moveHiddenEditorAndPreview(fixture, 3, 76, 18);
    const externalBefore = await readPreviewTrace();
    assert.ok(
      externalBefore.hiddenSelectionText === 'semantic line 3' && externalBefore.line === 76,
      `external trace did not separate hidden Editor and Preview: ${JSON.stringify(externalBefore)}`
    );
    const externalLines = [...fixtureLines];
    externalLines[0] = 'clean external revision expanded semantic line 1';
    const externalText = externalLines.join('\n');
    const requestBeforeExternal = await page.evaluate(() => (
      (window as any).__hostMessages.findLast((message: any) => message.type === 'requestPreviewRender')?.requestId ?? ''
    ));
    await page.evaluate((text) => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'docChanged', text, version: 2 } }));
    }, externalText);
    const externalRequestId = await fulfillNextPreviewRender(
      requestBeforeExternal,
      createPreviewHtml(externalLines),
      externalLines[0]
    );
    const externalAfter = await readPreviewTrace();
    assert.equal(externalAfter.line, 76, JSON.stringify({ externalBefore, externalAfter }));
    assert.ok(Math.abs((externalAfter.offset ?? 99) - 18) <= 2, JSON.stringify(externalAfter));
    assert.ok(externalAfter.text.includes(externalLines[0]), 'clean external revision did not update the production Editor');
    assert.equal(externalAfter.focusInEditor, false, 'clean external revision stole focus into the hidden Editor');

    await moveHiddenEditorAndPreview(externalText, 4, 100, 12);
    const reloadBefore = await readPreviewTrace();
    assert.ok(
      reloadBefore.hiddenSelectionText === 'semantic line 4' && reloadBefore.line === 100,
      `reload trace did not separate hidden Editor and Preview: ${JSON.stringify(reloadBefore)}`
    );
    const reloadLines = [...externalLines];
    reloadLines[0] = 'disk reload expanded semantic line 1 again';
    const reloadText = reloadLines.join('\n');
    const reloadRequestsBefore = await page.evaluate(() => (
      (window as any).__hostMessages.filter((message: any) => message.type === 'reloadDocumentFromDisk').length
    ));
    await page.$eval<HTMLButtonElement>('[data-action="discard"]', (button) => {
      button.click();
      button.click();
    });
    await page.waitForFunction((count) => (
      (window as any).__hostMessages.filter((message: any) => message.type === 'reloadDocumentFromDisk').length > count
    ), {}, reloadRequestsBefore);
    await page.evaluate((text) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'documentReloadedFromDisk', reloadId: 1, version: 3, text,
        topLine: 3, topLineOffset: 25
      }}));
    }, reloadText);
    await fulfillNextPreviewRender(externalRequestId, createPreviewHtml(reloadLines), reloadLines[0]);
    const reloadAfter = await readPreviewTrace();
    assert.equal(reloadAfter.line, 100, JSON.stringify({ reloadBefore, reloadAfter }));
    assert.ok(Math.abs((reloadAfter.offset ?? 99) - 12) <= 2, JSON.stringify(reloadAfter));
    assert.ok(reloadAfter.text.includes(reloadLines[0]), 'disk reload did not update the production Editor');
    assert.equal(reloadAfter.focusInEditor, false, 'disk reload stole focus into the hidden Editor');
    const reloadReceipt = await page.waitForFunction(() => (
      (window as any).__hostMessages.findLast((message: any) => (
        message.type === 'documentReloadPresentationCompleted' && message.reloadId === 1
      )) ?? null
    )).then((handle) => handle.jsonValue() as Promise<{ presented: boolean }>);
    assert.equal(reloadReceipt.presented, true, 'disk reload presentation was not accepted');
    await page.evaluate(() => (window as any).__viewportAnchorTransaction.destroyForeign());
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
