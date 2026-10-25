import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import exportRuntime from '../src/export/runtime';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const documentArgument = process.argv.find((argument) => argument.startsWith('--document='));
if (!documentArgument) throw new Error('Expected --document=<absolute markdown path>');
const focused = process.argv.includes('--focus');
if (!focused && !process.argv.includes('--confirm-long-run')) {
  throw new Error('Full-document font sweep requires --confirm-long-run');
}
const source = fs.readFileSync(documentArgument.slice('--document='.length), 'utf8');
const lineCount = source.split(/\r?\n/).length;
// The representative document can change; address a real top-level diagram by its source anchor.
const mermaidMap = new MarkdownIt().parse(source, {}).find((token) =>
  token.type === 'fence' && token.info.trim() === 'mermaid' && token.level === 0 && token.map)?.map;
const mermaidLine = mermaidMap ? mermaidMap[0] + 1 : null;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-font-full-document-'));
const build = await Bun.build({
  entrypoints: [path.join(root, 'scripts/test-font-size-full-document-entry.ts')],
  outdir: tempDir,
  target: 'browser',
  format: 'iife',
  naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
let primaryError: unknown;
const failures: Array<Record<string, unknown>> = [];
let activeStep: Record<string, unknown> | null = null;
let sweepCompleted = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  page.on('pageerror', (error) => console.error('Browser error:', error));
  await page.exposeFunction('__renderFontTestPreview', async (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    return {
      type: 'previewRenderResult',
      requestId: message.requestId,
      result: { ok: true, value: exportRuntime.renderPreviewDocument({
        markdownText: message.text,
        sourceDocumentPath: 'C:/font-test.md',
        uiLanguage: message.uiLanguage,
        styleEnvironment: message.environment
      }) }
    };
  });
  await page.setContent('<!doctype html><body class="vscode-light"><div id="app" class="editor-root"><div class="mode-toolbar meo-preload-toolbar" role="presentation" aria-hidden="true"></div><div class="editor-wrapper meo-preload-editor-shell" role="presentation" aria-hidden="true"><div class="editor-host"></div></div></body>');
  await page.addStyleTag({ content: ':root{--vscode-editor-background:#fff;--vscode-editor-foreground:#24292f;--vscode-sideBar-background:#f6f8fa;--vscode-panel-border:#d0d7de;--vscode-toolbar-hoverBackground:#eaeef2}html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}' });
  await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
  await page.addScriptTag({ content: `
    window.acquireVsCodeApi=()=>({
      postMessage(message){window.__renderFontTestPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));})},
      getState(){return null},setState(){}
    });
    window.mermaid={initialize(){},async render(id,source){
      await new Promise(resolve=>setTimeout(resolve,source.includes('sequenceDiagram')?180:90));
      const height=Math.min(650,190+source.split('\\n').length*3);
      return {svg:'<svg width="800" height="'+height+'" viewBox="0 0 800 '+height+'"><rect width="180" height="80"></rect></svg>'};
    }};
  ` });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
  await page.evaluate((text) => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///font-full-document.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: 'live',
    uiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'light',
    previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'light',
    gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
  } })), source);
  await page.waitForSelector('.editor-host > .cm-editor .cm-scroller');
  await page.waitForFunction((expectedLines) => (window as any).__fontTestView()?.state.doc.lines === expectedLines,
    { timeout: 10000 }, lineCount);
  // Document state is installed before the startup cover releases the toolbar.
  // Only begin physical menu interaction once that presentation is visible.
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLElement>('.more-tools-wrapper > button');
    return Boolean(button && !button.closest('.meo-preload-toolbar')
      && getComputedStyle(button).visibility === 'visible'
      && button.getBoundingClientRect().width > 0);
  }, { timeout: 10000 });
  await page.click('.more-tools-wrapper > button');
  await page.click('[data-editor-font-size-mode="custom"]');
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('.editor-font-size-stepper-button:last-child')!.click());
  await page.evaluate(async () => { for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame); });
  const initialFont = await page.evaluate(() => document.querySelector<HTMLOutputElement>('.editor-font-size-value')?.value);
  if (initialFont !== '15') throw new Error(`Expected to start at 15px, got ${initialFont}`);
  let samples = 0;
  let bottomConstrainedSteps = 0;
  const requestedLines = process.argv.find((argument) => argument.startsWith('--lines='))?.slice('--lines='.length);
  const positions = requestedLines ? requestedLines.split(',').map(Number) : focused ? [1, mermaidLine ?? 634, 788, 1005, 1020].filter((line) => line <= lineCount) : Array.from(new Set([
    1, ...[634, 788, 1005, 1020].filter((line) => line <= lineCount), ...(mermaidLine ? [mermaidLine] : []), lineCount,
    ...Array.from({ length: Math.ceil(lineCount / 12) }, (_, index) => Math.min(lineCount, 1 + index * 12))
  ])).sort((a, b) => a - b);
  const requestedModes = process.argv.find((argument) => argument.startsWith('--modes='))?.slice('--modes='.length);
  const modes = requestedModes ? requestedModes.split(',') : ['live', 'source', 'source-split', 'preview'];
  const measureStep = async (mode: string, direction: 1 | -1) => page.evaluate(async ({ sampleMode, delta }) => {
    const scroller = sampleMode === 'preview'
      ? document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.scrollingElement
      : document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller');
    if (!scroller) return { skipped: 'missing scroller' };
    const doc = scroller.ownerDocument;
    const bounds = sampleMode === 'preview'
      ? { top: 0, bottom: document.querySelector<HTMLIFrameElement>('.preview-frame')!.clientHeight, left: 0 }
      : scroller.getBoundingClientRect();
    const view = sampleMode === 'preview' ? null : (window as any).__fontTestView();
    const position = view?.posAtCoords({ x: bounds.left + 100, y: bounds.top + 2 }) ?? view?.viewport.from;
    const sourceLine = view && position !== undefined ? view.state.doc.lineAt(position).number : null;
    const domAtTop = view && position !== undefined ? view.domAtPos(position).node : null;
    const topElement = domAtTop instanceof HTMLElement ? domAtTop : domAtTop?.parentElement;
    const codeMirrorLine = topElement?.closest<HTMLElement>('.cm-line');
    const codeMirrorLineTop = codeMirrorLine ? codeMirrorLine.getBoundingClientRect().top - bounds.top : null;
    const table = sampleMode === 'preview' ? null : Array.from(document.querySelectorAll<HTMLElement>('.editor-host .meo-md-html-table-shell'))
      .find((item) => item.getBoundingClientRect().top <= bounds.top + 2 && item.getBoundingClientRect().bottom > bounds.top + 2);
    const tableStartLine = table?.dataset.meoRenderedBlockStartLine;
    const tableRows = (shell: HTMLElement | null | undefined) => Array.from(
      shell?.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')
        ?.querySelectorAll<HTMLElement>(':scope > thead > tr, :scope > tbody > tr') ?? []
    );
    const rows = tableRows(table);
    const rowIndex = rows.findIndex((item) => item.getBoundingClientRect().bottom > bounds.top + 2);
    const topPlaceholder = sampleMode === 'live'
      ? doc.elementFromPoint(bounds.left + 100, bounds.top + 2)?.closest<HTMLElement>('.meo-md-long-code-placeholder')
      : null;
    const placeholderLine = topPlaceholder?.dataset.meoRenderedBlockStartLine;
    const topRenderedBlock = sampleMode === 'live'
      ? doc.elementFromPoint(bounds.left + 100, bounds.top + 2)?.closest<HTMLElement>('.meo-rendered-block-preview, .meo-md-html-block')
      : null;
    const renderedBlockLine = topRenderedBlock?.dataset.meoRenderedBlockStartLine;
    const renderedBlockClass = topRenderedBlock?.classList.contains('meo-md-html-block') ? 'meo-md-html-block' : 'meo-rendered-block-preview';
    const previewLine = sampleMode === 'preview' ? Array.from(doc.querySelectorAll<HTMLElement>('[data-source-line]'))
      .find((item) => item.getBoundingClientRect().bottom > bounds.top + 40) : null;
    const previewInitialRect = previewLine?.getBoundingClientRect();
    const previewTracksProgress = Boolean(previewInitialRect
      && previewInitialRect.height >= bounds.bottom - bounds.top
      && previewInitialRect.top <= bounds.top + 40
      && previewInitialRect.bottom > bounds.top + 40);
    const currentTop = () => {
      if (sampleMode === 'preview') {
        const line = previewLine?.dataset.sourceLine;
        const item = line ? doc.querySelector<HTMLElement>(`[data-source-line="${line}"]`) : null;
        if (!item) return null;
        const rect = item.getBoundingClientRect();
        return previewTracksProgress
          ? (bounds.top + 40 - rect.top) / rect.height * (bounds.bottom - bounds.top)
          : rect.top - bounds.top;
      }
      if (table && rowIndex >= 0) {
        const currentTable = document.querySelector<HTMLElement>(`.editor-host .meo-md-html-table-shell[data-meo-rendered-block-start-line="${tableStartLine}"]`);
        const row = tableRows(currentTable)[rowIndex];
        if (row) return row.getBoundingClientRect().top - bounds.top;
      }
      if (placeholderLine) {
        const current = document.querySelector<HTMLElement>(`.editor-host .meo-md-long-code-placeholder[data-meo-rendered-block-start-line="${placeholderLine}"]`);
        if (current) return current.getBoundingClientRect().top - bounds.top;
      }
      if (renderedBlockLine) {
        const current = document.querySelector<HTMLElement>(`.editor-host .${renderedBlockClass}[data-meo-rendered-block-start-line="${renderedBlockLine}"]`);
        if (current) return current.getBoundingClientRect().top - bounds.top;
      }
      if (!sourceLine) return null;
      const dom = view.domAtPos(view.state.doc.line(sourceLine).from).node;
      const element = dom instanceof HTMLElement ? dom : dom.parentElement;
      const line = element?.closest<HTMLElement>('.cm-line, [data-meo-rendered-block-start-line]');
      if (line) return line.getBoundingClientRect().top - bounds.top;
      const pointPosition = view.posAtCoords({ x: bounds.left + 100, y: bounds.top + 2 });
      const pointLine = pointPosition === null ? null : view.state.doc.lineAt(pointPosition).number;
      const visibleLine = doc.elementFromPoint(bounds.left + 100, bounds.top + 2)?.closest<HTMLElement>('.cm-line');
      return pointLine === sourceLine && visibleLine
        ? visibleLine.getBoundingClientRect().top - bounds.top : null;
    };
    const record = () => ({ top: currentTop(), scroll: scroller.scrollTop, maxScroll: scroller.scrollHeight - scroller.clientHeight,
      topVisibleLine: view ? view.state.doc.lineAt(view.posAtCoords({ x: bounds.left + 100, y: bounds.top + 2 }) ?? view.viewport.from).number : null,
      visible: Array.from(doc.querySelectorAll<HTMLElement>(sampleMode === 'preview' ? '[data-source-line]' : '.editor-host .cm-line'))
        .filter((item) => { const rect = item.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom; }).length });
    const trace = [record()];
    const button = document.querySelector<HTMLButtonElement>(delta > 0 ? '.editor-font-size-stepper-button:last-child' : '.editor-font-size-stepper-button:first-child')!;
    button.focus();
    button.click();
    for (let frame = 0; frame < 14; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      trace.push(record());
    }
    // CodeMirror's synchronous post-click DOM can still be dirty. Record all
    // fourteen actual rendering opportunities, preserving the original painted
    // window without querying coordinates in the unpainted style mutation.
    const initialTop = trace[0]!.top;
    const painted = trace.slice(1);
    // Either direction can hit the document end: shrinkage also lowers the
    // maximum scroll. Prove that preserving this source anchor would require an
    // unavailable scroll position, then account for the unavoidable deficit.
    const isBottomConstrained = (item: (typeof trace)[number]) => initialTop !== null && item.top !== null
      && item.scroll + item.top - initialTop > item.maxScroll + 1
      && item.scroll >= item.maxScroll - 1;
    const bottomConstrained = painted.some(isBottomConstrained);
    const displacement = initialTop === null ? 0 : Math.max(...painted.map((item) => item.top === null
      ? 9999 : isBottomConstrained(item) ? 0 : Math.abs(item.top - initialTop)));
    return { sourceLine: sourceLine ?? previewLine?.dataset.sourceLine, codeMirrorLineTop, placeholderLine, renderedBlockLine, tableStartLine, tableRow: rowIndex, displacement, bottomConstrained, trace };
  }, { sampleMode: mode, delta: direction });
  for (const mode of modes) {
    if (mode !== 'live') {
      await page.evaluate((nextMode) => document.querySelector<HTMLButtonElement>(`button[data-mode="${nextMode === 'source-split' ? 'source' : nextMode}"]`)!.click(), mode);
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (mode === 'source-split') {
        await page.evaluate(() => document.querySelector<HTMLButtonElement>('.source-preview-button')!.click());
        await page.waitForFunction(() => document.querySelector('.editor-surface')?.hasAttribute('data-source-preview'));
      }
    }
    for (const [positionIndex, line] of positions.entries()) {
      if (mode === 'preview') {
        await page.evaluate((target) => {
          const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
          const doc = frame?.contentDocument;
          const entries = Array.from(doc?.querySelectorAll<HTMLElement>('[data-source-line]') ?? []);
          const item = entries.find((entry) => {
            const start = Number(entry.dataset.sourceLine);
            const end = Number(entry.dataset.sourceEndLine ?? start);
            return start <= target && end >= target;
          }) ?? entries.reduce<HTMLElement | null>((nearest, entry) => (
            !nearest || Math.abs(Number(entry.dataset.sourceLine) - target) < Math.abs(Number(nearest.dataset.sourceLine) - target)
              ? entry : nearest
          ), null);
          if (item) {
            const start = Number(item.dataset.sourceLine);
            const end = Number(item.dataset.sourceEndLine ?? start);
            const progress = Math.max(0, Math.min(1, (target - start) / Math.max(1, end - start + 1)));
            const rect = item.getBoundingClientRect();
            doc!.scrollingElement!.scrollTop += rect.top + rect.height * progress - 50;
          }
        }, line);
      } else {
        await page.evaluate((target) => (window as any).__fontTestScrollToLine(target), line);
        // CodeMirror's height map can refine long rendered blocks after the first jump.
        for (let attempt = 0; attempt < 3; attempt++) {
          await page.evaluate(async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });
          await page.evaluate((target) => (window as any).__fontTestScrollToLine(target), line);
        }
      }
      await page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); });
      if (process.argv.includes('--details') && mode === 'live') {
        const nearbyBlocks = await page.evaluate(() => {
          const rect = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!.getBoundingClientRect();
          return Array.from(document.querySelectorAll<HTMLElement>('.editor-host [data-meo-rendered-block-start-line]'))
            .map((item) => ({ kind: item.className, line: item.dataset.meoRenderedBlockStartLine, top: Math.round(item.getBoundingClientRect().top - rect.top), bottom: Math.round(item.getBoundingClientRect().bottom - rect.top) }))
            .filter((item) => item.bottom > -rect.height && item.top < rect.height);
        });
        console.log(`live line ${line} nearby blocks: ${JSON.stringify(nearbyBlocks)}`);
      }
      const scenario = mode === 'live' && line === mermaidLine ? ['preview', 'side-by-side', 'stacked'] : ['default'];
      for (const blockMode of scenario) {
        if (blockMode !== 'default') {
          if (process.argv.includes('--details')) console.log('mermaid probe', await page.evaluate((targetLine) => {
            const view = (window as any).__fontTestView();
            const rect = view.scrollDOM.getBoundingClientRect();
            const top = view.posAtCoords({ x: rect.left + 100, y: rect.top + 2 });
            return { topLine: top === null ? null : view.state.doc.lineAt(top).number,
              viewportFrom: view.state.doc.lineAt(view.viewport.from).number,
              viewportTo: view.state.doc.lineAt(view.viewport.to).number,
              scrollTop: view.scrollDOM.scrollTop,
              scrollHeight: view.scrollDOM.scrollHeight,
              clientHeight: view.scrollDOM.clientHeight,
              targetTop: view.lineBlockAt(view.state.doc.line(targetLine).from).top,
              controls: Array.from(document.querySelectorAll<HTMLElement>('.meo-mermaid-toolbar'))
                .map((item) => item.getAttribute('aria-label')) };
          }, line));
          await page.waitForFunction((targetLine) => {
            const anchor = String((window as any).__fontTestView().state.doc.line(targetLine).from);
            return Array.from(document.querySelectorAll<HTMLElement>('.meo-mermaid-toolbar'))
              .some((item) => item.dataset.meoBlockFrom === anchor);
          }, { timeout: 5000 }, line);
        }
        if (blockMode !== 'default') {
          await page.evaluate(({ line, layout }) => {
            const view = (window as any).__fontTestView();
            const anchor = String(view.state.doc.line(line).from);
            const toolbar = view.dom.querySelector<HTMLElement>(`.meo-mermaid-toolbar[data-meo-block-from="${anchor}"]`)!;
            if ((toolbar.dataset.meoMermaidMode === 'edit') !== (layout !== 'preview')) toolbar.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn')!.click();
          }, { line, layout: blockMode });
          if (blockMode !== 'preview') {
            await page.waitForSelector('.meo-mermaid-toolbar[data-meo-mermaid-mode="edit"]');
            await page.evaluate(({ line, layout }) => {
              const view = (window as any).__fontTestView(), anchor = String(view.state.doc.line(line).from);
              const side = view.dom.querySelector(`.meo-mermaid-inline-preview[data-meo-mermaid-anchor="${anchor}"]`);
              if (!!side !== (layout === 'side-by-side')) view.dom.querySelector<HTMLButtonElement>(`[data-meo-mermaid-anchor="${anchor}"] .meo-mermaid-layout-btn:not(:disabled)`)!.click();
            }, { line, layout: blockMode });
            await page.waitForFunction(({ line, layout }) => {
              const view = (window as any).__fontTestView(), anchor = String(view.state.doc.line(line).from);
              return !!view.dom.querySelector(`.meo-mermaid-inline-preview[data-meo-mermaid-anchor="${anchor}"]`) === (layout === 'side-by-side');
            }, {}, { line, layout: blockMode });
          }
          if (!process.argv.includes('--rapid-mermaid')) await page.evaluate(async () => { for (let i=0; i<20; i++) await new Promise(requestAnimationFrame); });
        }
        for (let step = 0; step < 5; step++) {
          activeStep = { mode, line, blockMode, direction: `increase-${step}` };
          const up = await measureStep(mode, 1);
          samples += 1;
          if (up.bottomConstrained) bottomConstrainedSteps += 1;
          if ('displacement' in up && up.displacement > 12) failures.push({ mode, line, blockMode, direction: `increase-${step}`, ...up });
        }
        for (let step = 0; step < 5; step++) {
          activeStep = { mode, line, blockMode, direction: `decrease-${step}` };
          const down = await measureStep(mode, -1);
          samples += 1;
          if (down.bottomConstrained) bottomConstrainedSteps += 1;
          if (down.displacement > 12) failures.push({ mode, line, blockMode, direction: `decrease-${step}`, ...down });
        }
      }
      if (focused) console.log(`${mode} line ${line}: ${failures.length} anomalies so far`);
      else if (positionIndex % 20 === 19) console.log(`${mode}: ${positionIndex + 1}/${positions.length} positions, ${failures.length} anomalies`);
      await page.evaluate(async () => { for (let i = 0; i < 24; i++) await new Promise(requestAnimationFrame); });
    }
    console.log(`${mode}: ${positions.length} positions checked`);
  }
  console.log(`Font sweep: ${samples} changes, ${failures.length} anomalies`);
  console.log(`Bottom-constrained steps: ${bottomConstrainedSteps}`);
  console.log(`Anomaly locations: ${JSON.stringify(Object.entries(failures.reduce<Record<string, number>>((counts, failure) => {
    const key = `${failure.mode}:${failure.line}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {})))}`);
  console.log(JSON.stringify(failures.slice(0, process.argv.includes('--details') ? 6 : 12).map(({ trace, ...failure }) => ({
    ...failure,
    trace: Array.isArray(trace) ? (process.argv.includes('--details') ? trace : [
      trace[0], trace[1], trace[2],
      trace.reduce((worst: any, item: any) => item.top === null || (
        worst.top !== null && Math.abs(item.top - trace[0].top) > Math.abs(worst.top - trace[0].top)
      ) ? item : worst, trace[0]),
      trace.at(-1)
    ]) : trace
  })), null, 2));
  sweepCompleted = true;
  if (failures.length) throw new Error(`${failures.length} font-size viewport anomalies`);
} catch (error) {
  if (!sweepCompleted) {
    console.error('Interrupted font step:', JSON.stringify(activeStep));
    console.error('Font anomalies before interruption:', JSON.stringify(failures));
  }
  primaryError = error;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
