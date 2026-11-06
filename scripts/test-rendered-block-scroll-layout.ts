import { installPackagedMermaid } from './mermaid-runtime-test-helpers';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-block-scroll-layout-'));
const build = await Bun.build({
  entrypoints: ['scripts/test-rendered-block-scroll-layout-entry.ts'], outdir: temp,
  naming: 'bundle.js', format: 'iife', target: 'browser'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 700, height: 600 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}.cm-editor{height:100%}</style><div id="app" class="editor-host"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await installPackagedMermaid(page);
  await page.addScriptTag({ path: path.join(temp, 'bundle.js') });
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  const layoutCount = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return metrics.find(metric => metric.name === 'LayoutCount')!.value;
  };
  // The first attached table must reserve its Markdown editor's wrapped height
  // before the asynchronous table layout pass can expose a second geometry.
  await page.addStyleTag({ content: `
    .row-layout-contract table.meo-md-html-table { table-layout: fixed !important; width: 330px !important; }
    .row-layout-contract table.meo-md-html-table col { width: 165px !important; }
  ` });
  const firstRowLayout = await page.evaluate(async () => {
    const harness = (window as any).RenderedBlockScrollLayoutHarness;
    const editor = harness.createEditor({
      parent: document.getElementById('app'), initialMode: 'live', onApplyChanges() {},
      text: '| Label | Value |\n| --- | --- |\n| source | [x](https://example.invalid/' + 'long-path/'.repeat(24) + ') |\n'
    });
    editor.view.dom.classList.add('row-layout-contract');
    const row = editor.view.contentDOM.querySelector('tbody tr')!;
    const attached = row.getBoundingClientRect().height;
    for (let n = 0; n < 12; n++) await new Promise(requestAnimationFrame);
    const settled = row.getBoundingClientRect().height;
    const cells = Array.from(row.querySelectorAll<HTMLElement>('.meo-md-html-table-cell-content'))
      .map(cell => cell.getBoundingClientRect().height);
    const sourceFits = Array.from(row.querySelectorAll<HTMLTextAreaElement>('textarea'))
      .every(input => input.scrollHeight <= input.clientHeight + 1);
    editor.destroy();
    return { attached, settled, cells, sourceFits };
  });
  assert.ok(Math.abs(firstRowLayout.attached - firstRowLayout.settled) <= 1,
    `Reading a newly mounted table must not gain a second row height: ${JSON.stringify(firstRowLayout)}`);
  assert.ok(Math.max(...firstRowLayout.cells) - Math.min(...firstRowLayout.cells) <= 1,
    'Native input and cell hit areas must still span the whole shared row height');
  assert.equal(firstRowLayout.sourceFits, true, 'The native source editor must fit without an inner vertical scroll');
  const initial = await layoutCount();
  // Passive reading must not create caret mirrors for hidden, unfocused native
  // inputs. Those probes invalidate page layout and wake floating block chrome.
  await page.evaluate(() => {
    (window as any).passiveCaretProbes = 0;
    (window as any).detachedTableGeometryReads = 0;
    (window as any).tableTeardownGeometryReads = 0;
    const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function() {
      if (this.matches('.meo-md-html-table-shell, .meo-md-html-table-wrap') && !this.isConnected) {
        (window as any).detachedTableGeometryReads += 1;
      }
      if ((window as any).tableTeardown && this.matches(
        '.meo-md-html-table-shell, .meo-md-html-table-wrap, .cm-lineNumbers, .meo-git-gutter'
      )) (window as any).tableTeardownGeometryReads += 1;
      return getBoundingClientRect.call(this);
    };
    const appendChild = document.body.appendChild;
    document.body.appendChild = function<T extends Node>(node: T): T {
      if (node instanceof HTMLElement && node.style.left === '-10000px') {
        (window as any).passiveCaretProbes += 1;
      }
      return appendChild.call(this, node) as T;
    };
  });
  await page.evaluate(async () => {
    const harness = (window as any).RenderedBlockScrollLayoutHarness;
    const text = ['| A | B | C |', '| --- | --- | --- |',
      ...Array.from({ length: 60 }, (_, index) => `| row ${index} | value | value |`), '', 'end'].join('\n');
    (window as any).scrollLayoutEditor = harness.createEditor({
      parent: document.getElementById('app'), text, initialMode: 'live', onApplyChanges() {}
    });
    for (let n = 0; n < 12; n++) await new Promise(requestAnimationFrame);
  });
  const mountLayouts = (await layoutCount()) - initial;
  assert.equal(await page.evaluate(() => (window as any).detachedTableGeometryReads), 0,
    'Table construction must leave geometry to the attached layout pass');
  assert.equal(await page.evaluate(() => (window as any).passiveCaretProbes), 0,
    'Mounting a table for reading must not measure an unfocused textarea caret');
  assert.ok(mountLayouts <= 45,
    `Mounting a virtualized 60-row table must batch layout, observed ${mountLayouts} layouts`);
  const beforeScroll = await layoutCount();
  await page.evaluate(() => {
    const harness = (window as any).RenderedBlockScrollLayoutHarness;
    const view = (window as any).scrollLayoutEditor.view;
    view.scrollDOM.scrollTop = 180;
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    harness.refreshMountedTablePositions(view);
    harness.flushMountedTableLayouts(view);
    view.dom.getBoundingClientRect();
  });
  const scrollLayouts = (await layoutCount()) - beforeScroll;
  assert.ok(scrollLayouts <= 8, `A table scroll must not relayout per row: ${scrollLayouts}`);
  console.log(`60-row table: ${mountLayouts} mount layouts, ${scrollLayouts} scroll layouts`);
  const stablePositionMutations = await page.evaluate(async () => {
    const harness = (window as any).RenderedBlockScrollLayoutHarness;
    const view = (window as any).scrollLayoutEditor.view;
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    observer.observe(view.contentDOM, { attributes: true, subtree: true, attributeFilter: [
      'data-meo-rendered-block-start-line', 'data-meo-rendered-block-end-line',
      'data-table-from', 'data-table-to', 'data-table-signature',
      'data-source-line-number', 'data-table-cell-from', 'data-table-cell-to'
    ] });
    for (let n = 0; n < 3; n++) harness.refreshMountedTablePositions(view);
    await Promise.resolve();
    observer.disconnect();
    return mutations;
  });
  assert.equal(stablePositionMutations, 0,
    'Refreshing unchanged table positions must not wake layout and header observers');
  assert.equal(await page.evaluate(() => (window as any).passiveCaretProbes), 0,
    'Scrolling an inactive table must not create caret mirrors');
  const editingProbes = await page.evaluate(async () => {
    const view = (window as any).scrollLayoutEditor.view;
    view.scrollDOM.scrollTop = 0;
    for (let n = 0; n < 3; n++) await new Promise(requestAnimationFrame);
    const input = view.contentDOM.querySelector('tbody textarea') as HTMLTextAreaElement;
    input.focus();
    for (let n = 0; n < 3; n++) await new Promise(requestAnimationFrame);
    return { focused: document.activeElement === input, count: (window as any).passiveCaretProbes };
  });
  assert.equal(editingProbes.focused, true);
  assert.ok(editingProbes.count > 0, 'Editing must retain actual caret measurement');
  const teardownReads = await page.evaluate(() => {
    (window as any).tableTeardown = true;
    (window as any).scrollLayoutEditor.destroy();
    (window as any).tableTeardown = false;
    return (window as any).tableTeardownGeometryReads;
  });
  assert.equal(teardownReads, 0, 'Releasing a table must not measure discarded geometry');

  for (const kind of ['table', 'mermaid']) {
    await page.evaluate(async kind => {
      if (kind !== 'table') (window as any).scrollLayoutEditor.destroy();
      const harness = (window as any).RenderedBlockScrollLayoutHarness;
      const block = kind === 'table'
        ? ['| A | B |', '| --- | --- |', ...Array.from({ length: 60 }, (_, i) => `| ${i} | value |`)]
        : ['```mermaid', 'flowchart TD', ...Array.from({ length: 24 }, (_, i) => `N${i} --> N${i + 1}`), '```'];
      const text = [...Array.from({ length: 8 }, (_, i) => `before ${i}`), '', ...block,
        '', ...Array.from({ length: 60 }, (_, i) => `after ${i}`)].join('\n');
      (window as any).scrollLayoutEditor = harness.createEditor({
        parent: document.getElementById('app'), text, initialMode: 'live', onApplyChanges() {}
      });
    }, kind);
    if (kind === 'mermaid') await page.waitForSelector('.meo-mermaid-svg-wrapper svg');
    const bounds = await page.evaluate(async kind => {
      const view = (window as any).scrollLayoutEditor.view;
      for (let n = 0; n < 12; n++) await new Promise(requestAnimationFrame);
      const block = view.contentDOM.querySelector(kind === 'table' ? '.meo-md-html-table-wrap' : '.meo-mermaid-block')!;
      const scroller = view.scrollDOM;
      scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 650;
      for (let n = 0; n < 8; n++) await new Promise(requestAnimationFrame);
      const rect = scroller.getBoundingClientRect();
      const visibleTextLines = [...view.contentDOM.querySelectorAll('.cm-content > .cm-line')].filter((line: any) => {
        const r = line.getBoundingClientRect();
        return r.top >= rect.top && r.top < rect.bottom;
      }).length;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, visibleTextLines };
    }, kind);
    assert.equal(bounds.visibleTextLines, 0, `${kind} must fill the viewport without a text-line anchor`);
    await page.mouse.move(bounds.x, bounds.y);
    await page.mouse.wheel({ deltaY: -120 });
    await page.evaluate(async () => { for (let n = 0; n < 3; n++) await new Promise(requestAnimationFrame); });
    const result = await page.evaluate(() => {
      const harness = (window as any).RenderedBlockScrollLayoutHarness;
      const view = (window as any).scrollLayoutEditor.view;
      const scroller = view.scrollDOM;
      const before = scroller.scrollTop;
      // Emulate the CodeMirror boundary: a delayed height-map receipt may
      // anchor the native offset despite unchanged mounted reading geometry.
      const original = view.lineBlockAt;
      view.lineBlockAt = function(position: number) {
        return { ...original.call(this, position), top: original.call(this, position).top + 90 };
      };
      try {
        scroller.scrollTop += 90;
        harness.getViewportController(view).reconcileAfterEditorUpdate();
        return { before, after: scroller.scrollTop };
      } finally { view.lineBlockAt = original; }
    });
    assert.ok(Math.abs(result.after - result.before) <= 1,
      `${kind}-only viewport rebounded on delayed height measurement: ${JSON.stringify(result)}`);
    console.log(`${kind}-only viewport retained native reading position after a late height-map receipt`);
  }

  // Background warming must yield to real native scrolling. Visible requests
  // remain immediate, and cancelling queued work must never call Mermaid.
  await page.mouse.wheel({ deltaY: -120 });
  const scheduling = await page.evaluate(async () => {
    const harness = (window as any).RenderedBlockScrollLayoutHarness;
    const runtime = (window as any).mermaid;
    const original = runtime.render;
    const calls: string[] = [];
    runtime.render = async (id: string) => { calls.push(id); return { svg: '<svg/>' }; };
    try {
      const view = (window as any).scrollLayoutEditor.view;
      const scrolling = () => harness.getViewportController(view).isUserScrolling();
      const warm = (id: string, signal?: AbortSignal) => harness.preloadMermaidDocumentBatch({
        preload: () => harness.renderMermaidRuntime(id, 'flowchart TD\nA-->B')
      }, [{ rawSource: id }], () => !signal?.aborted, () => {}, signal, scrolling);
      const cold = warm('scroll-cold');
      await new Promise(resolve => setTimeout(resolve, 80));
      const coldDuringScroll = calls.includes('scroll-cold');
      await harness.renderMermaidRuntime('scroll-visible', 'flowchart TD\nA-->V');
      await harness.renderMermaidRuntime('scroll-edit', 'flowchart TD\nA-->C', undefined, true);
      const editDuringScroll = calls.includes('scroll-edit');
      const cancellation = new AbortController();
      const cancelled = warm('scroll-cancelled', cancellation.signal);
      await new Promise(resolve => setTimeout(resolve, 60));
      cancellation.abort();
      await cancelled;
      await cold;
      return { coldDuringScroll, editDuringScroll, calls };
    } finally { runtime.render = original; }
  });
  assert.equal(scheduling.coldDuringScroll, false, 'Background Mermaid layout must wait for native scrolling to settle');
  assert.equal(scheduling.editDuringScroll, true, 'Visible Mermaid requests must not wait behind scroll deferral');
  assert.equal(scheduling.calls.includes('scroll-visible'), true, 'Uncached visible diagrams must remain immediate');
  assert.equal(scheduling.calls.includes('scroll-cancelled'), false);
  assert.equal(scheduling.calls.includes('scroll-cold'), true, 'Cold rendering must resume after scrolling');
  console.log('Background Mermaid scroll deferral, visible updates and cancellation passed');
} catch (error) { primaryError = error; }
finally {
  fs.rmSync(temp, { recursive: true, force: true });
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
