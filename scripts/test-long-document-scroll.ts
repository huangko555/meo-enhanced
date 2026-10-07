import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Page } from 'puppeteer-core';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
// A table taller than the viewport keeps an adopted widget alive while its rows remeasure.
const fixture = [
  '# Table height cache regression', '',
  '| Content | Result |', '| --- | --- |',
  ...Array.from({ length: 4 }, (_, row) => `| ${Array.from({ length: 8 }, (_, line) =>
    `Row ${row} line ${line} ${'wrapping content '.repeat(6)}`).join('<br>')} | Row ${row} |`), '',
  Array.from({ length: 90 }, (_, index) => [
    `## Section ${index + 1}`, '',
    `- 1. **List item ${index + 1}** with wrapped content and ${'long reading text '.repeat(6)}`, '',
    '> - [ ] Quoted task with **bold** text', '',
    '| Content | Result |', '| --- | --- |',
    `| Row ${index + 1}<br>- 1. Nested list | **Wrapped** ${'table text '.repeat(8)} |`, ''
  ].join('\n')).join('\n')
].join('\n');
const source = option('document') ? fs.readFileSync(option('document')!, 'utf8') : fixture;
const modes = option('mode') ? [option('mode')!] : ['live', 'source', 'preview', 'split'];
const starts = option('start-line') ? [Number(option('start-line'))] : [425, 610];
const width = Number(option('width') ?? 1200);
const full = process.argv.includes('--full');
const steps = Number(option('steps') ?? (full ? 1000 : 70));
const gesture = process.argv.includes('--gesture');
const build = await Bun.build({
  entrypoints: ['scripts/test-long-document-scroll-entry.ts'], target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

async function frames(page: Page, count: number) {
  await page.evaluate(async count => {
    for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame);
  }, count);
}

async function snapshot(page: Page, preview: boolean) {
  return page.evaluate(preview => {
    const doc = preview
      ? document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument! : document;
    const scroller = preview ? doc.scrollingElement!
      : doc.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
    const rect = preview ? { top: 0, bottom: doc.defaultView!.innerHeight } : scroller.getBoundingClientRect();
    const view = preview ? null : (window as any).LongDocumentScrollHarness.EditorView.findFromDOM(scroller);
    const tops: Record<string, number> = {};
    const elements = preview ? doc.querySelectorAll<HTMLElement>('[data-source-line]')
      : scroller.querySelectorAll<HTMLElement>('.cm-content > .cm-line, [data-meo-rendered-block-start-line], .meo-md-html-table tbody tr');
    for (const element of elements) {
      if (!preview && element.closest('.cm-scroller') !== scroller) continue;
      const bounds = element.getBoundingClientRect();
      if (bounds.height < 1 || bounds.bottom <= rect.top || bounds.top >= rect.bottom) continue;
      let key: string;
      if (preview) key = `${element.tagName}:${element.dataset.sourceLine}:${element.dataset.sourceEndLine}`;
      else if (element.matches('tr')) {
        const shell = element.closest<HTMLElement>('[data-meo-rendered-block-start-line]');
        key = `row:${shell?.dataset.meoRenderedBlockStartLine}:${(element as HTMLTableRowElement).rowIndex}`;
      } else if (element.dataset.meoRenderedBlockStartLine) {
        key = `block:${element.dataset.meoRenderedBlockKind}:${element.dataset.meoRenderedBlockStartLine}`;
      } else {
        key = `line:${view.state.doc.lineAt(view.posAtDOM(element, 0)).number}`;
      }
      tops[key] = bounds.top - rect.top;
    }
    return { top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight, tops };
  }, preview);
}

const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  for (const mode of modes) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width, height: 900 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.exposeFunction('__renderScrollPreview', (message: any) => {
        if (message.type !== 'requestPreviewRender') return null;
        return { type: 'previewRenderResult', requestId: message.requestId,
          result: { ok: true, value: exportRuntime.renderPreviewDocument({
            markdownText: message.text, sourceDocumentPath: 'C:/tmp/long-document-scroll.md',
            uiLanguage: message.uiLanguage, styleEnvironment: message.environment
          }) } };
      });
      await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({
        getState(){},setState(){},postMessage(message){
          window.__renderScrollPreview(message).then(response=>{
            if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));
          });
        }
      });` });
      await page.addScriptTag({ content: await build.outputs[0]!.text() });
      await page.evaluate(({ source, mode }) => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', documentId: 'file:///long-document-scroll.md', text: source, version: 1,
        savedRevision: { version: 1, text: source }, diagnostics: [], mode: mode === 'split' ? 'source' : mode,
        uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '',
        previewSourceColoring: true, editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
        gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
        diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false, largeDocumentOptimizationEnabled: true,
        findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right',
        outlineVisible: true, outlineWidth: 300, restoreReadingPositionOnOpen: false, vscodeTheme: null
      } })), { source, mode });
      await page.waitForSelector('.editor-wrapper:not(.meo-preload-editor-shell)');
      if (mode === 'split') {
        await page.click('.source-preview-button');
        await page.waitForFunction(() => document.querySelector('.editor-surface')?.hasAttribute('data-source-preview'));
      }
      if (mode === 'preview' || mode === 'split') {
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === true);
      }
      if (mode === 'live') {
        await frames(page, 12);
        const result = await page.evaluate(async () => {
          const { EditorView, isolateHistory, redo, undo } = (window as any).LongDocumentScrollHarness;
          const view = EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')!);
          const tables = () => {
            const widgets: any[] = [];
            for (const source of view.state.facet(EditorView.decorations)) {
              const ranges = typeof source === 'function' ? source(view) : source;
              for (const cursor = ranges.iter(); cursor.value; cursor.next()) {
                const widget = cursor.value.spec.widget;
                if (widget?.constructor.name === 'HtmlTableWidget') widgets.push(widget);
              }
            }
            return widgets;
          };
          const before = tables().find(widget => document.querySelector(
            `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${widget.tableData.startLine}"]`
          ));
          if (!before) throw new Error('Height cache contract needs a measured table');
          const measured = document.querySelector<HTMLElement>(
            `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${before.tableData.startLine}"]`
          )!.getBoundingClientRect().height;
          const signature = before.tableData.signature;
          view.dispatch({ changes: { from: 0, insert: 'x' } });
          const after = tables().find(widget => widget.tableData.signature === signature);
          const result = { measured, after: after?.measuredHeight, estimate: after?.estimatedHeight };
          view.dispatch({ changes: { from: 0, to: 1 } });
          const startLine = before.tableData.startLine;
          const current = () => tables().find(widget => widget.tableData.startLine === startLine)!;
          const shell = () => document.querySelector<HTMLElement>(
            `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${startLine}"]`
          )!;
          const settle = async () => {
            for (let frame = 0; frame < 12; frame++) await new Promise(requestAnimationFrame);
          };
          const originalDocument = view.state.doc.toString();
          const range = current().tableData.sourceRanges[1][0];
          const original = view.state.doc.sliceString(range.from, range.to);
          const expanded = original + '<br>Height cache edited line'.repeat(20);
          view.dispatch({ changes: { from: range.from, to: range.to, insert: expanded }, annotations: isolateHistory.of('full') });
          await settle();
          const measure = () => ({ measured: shell().getBoundingClientRect().height, cached: current().measuredHeight, estimate: current().estimatedHeight });
          const edited = measure();
          if (!undo(view)) throw new Error('Table height edit could not be undone');
          await settle();
          const restored = measure();
          if (!redo(view)) throw new Error('Table height edit could not be redone');
          await settle();
          const redone = measure();
          if (!undo(view)) throw new Error('Table height edit could not be restored');
          await settle();
          return { ...result, edited, restored, redone, final: measure(), documentRestored: view.state.doc.toString() === originalDocument };
        });
        assert.ok(result.after > 0 && Math.abs(result.after - result.measured) <= 1, 'Unchanged table lost its measured height during decoration replacement: ' + JSON.stringify(result));
        assert.ok(result.edited.measured > result.measured + 1, 'Cell content edit did not increase table height');
        for (const state of [result.edited, result.restored, result.redone, result.final]) {
          assert.ok(Math.abs(state.cached - state.measured) <= 1 && Math.abs(state.estimate - state.measured) <= 1, 'Table content/history lost its measured height: ' + JSON.stringify(result));
        }
        assert.ok(Math.abs(result.redone.measured - result.edited.measured) <= 1, 'Redo did not restore the edited height');
        assert.ok(Math.abs(result.restored.measured - result.measured) <= 1 && Math.abs(result.final.measured - result.measured) <= 1 && result.documentRestored, 'Table content or geometry was not restored');
        console.log('Unchanged table measurement survives decoration replacement');
        await frames(page, 30);
      }
      const input = await page.createCDPSession();
      for (const preview of mode === 'split' ? [false, true] : [mode === 'preview']) {
        for (const start of starts) {
          await page.evaluate(({ start, preview }) => {
            if (preview) {
              const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
              const mapped = Array.from(doc.querySelectorAll<HTMLElement>('[data-source-line]'));
              const target = mapped.find(element => Number(element.dataset.sourceLine) >= start) ?? mapped.at(-1)!;
              target.scrollIntoView({ block: 'start' });
            } else {
              const { EditorView, getViewportController } = (window as any).LongDocumentScrollHarness;
              const view = EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')!);
              const controller = getViewportController(view);
              controller.revealPositionUntilStable(
                view.state.doc.line(Math.min(start, view.state.doc.lines)).from,
                { y: 'start', geometry: 'line-block' }, controller.beginNavigationReveal()
              );
            }
          }, { start, preview });
          await frames(page, 20);
          const box = await (await page.$(preview ? '.preview-frame' : '.editor-host > .cm-editor .cm-scroller'))!.boundingBox();
          assert.ok(box);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          for (const delta of [-100, 100]) {
            let checkedSteps = 0;
            for (let step = 0; step < steps; step++) {
              const before = await snapshot(page, preview);
              const intent = Math.max(-before.top, Math.min(delta, before.max - before.top));
              if (Math.abs(intent) <= 1) break;
              if (gesture) await input.send('Input.synthesizeScrollGesture', {
                x: box.x + box.width / 2, y: box.y + box.height / 2,
                yDistance: -intent, speed: 400, gestureSourceType: 'mouse', preventFling: true
              });
              else await page.mouse.wheel({ deltaY: delta });
              await frames(page, 4);
              const after = await snapshot(page, preview);
              const commonKeys = Object.keys(before.tops).filter(key => after.tops[key] !== undefined);
              assert.ok(commonKeys.length > 0, 'Scroll step has no shared visible-content witness');
              checkedSteps++;
              const corrections = Object.entries(before.tops).flatMap(([key, top]) => {
                const next = after.tops[key];
                return next !== undefined && Math.abs(next - top + intent) > 3.5
                  ? [{ key, correction: next - top + intent, before: top, after: next }] : [];
              });

              assert.equal(corrections.length, 0,
                `${mode}/${preview ? 'preview' : 'editor'}/${start}/${delta}/${step} jumped: ${JSON.stringify({ corrections: corrections.slice(0, 5), beforeTop: before.top, afterTop: after.top })}`);
              assert.ok(Math.abs(after.top - before.top) > 1, `${mode} scrolling stalled at ${step}`);
            }
            assert.ok(checkedSteps > 0, `${mode}/${preview ? 'preview' : 'editor'}/${start}/${delta}: scroll direction was not exercised: ${JSON.stringify(await snapshot(page, preview))}`);
            if (full) {
              const boundary = await snapshot(page, preview);
              assert.ok(delta < 0 ? boundary.top <= 1 : boundary.max - boundary.top <= 1,
                'Full traversal did not reach its document boundary: ' + JSON.stringify(boundary));
            }
          }
          const beforeIdle = await snapshot(page, preview);
          await frames(page, 30);
          const afterIdle = await snapshot(page, preview);
          for (const [key, top] of Object.entries(beforeIdle.tops)) {
            const next = afterIdle.tops[key];
            if (next !== undefined) assert.ok(Math.abs(next - top) <= 3.5, `${mode} late layout shifted ${key}: ${next - top}`);
          }
          console.log(`${mode}/${preview ? 'preview' : 'editor'}: line ${start}, both directions and idle geometry passed`);
        }
      }
    } finally { await page.close(); }
  }
} catch (error) { primaryError = error; }
finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
