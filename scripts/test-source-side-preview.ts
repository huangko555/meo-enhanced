import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser',
  format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 760 });
  let previewRenderCount = 0;
  let nextPreviewRenderDelayMs = 0;
  await page.exposeFunction('__renderSourceSidePreview', async (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    previewRenderCount += 1;
    const delayMs = nextPreviewRenderDelayMs;
    nextPreviewRenderDelayMs = 0;
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    return {
      type: 'previewRenderResult',
      requestId: message.requestId,
      result: {
        ok: true,
        value: exportRuntime.renderPreviewDocument({
          markdownText: message.text,
          sourceDocumentPath: 'C:/tmp/source-side-preview.md',
          uiLanguage: message.uiLanguage,
          styleEnvironment: message.environment
        })
      }
    };
  });
  await page.exposeFunction('__delayNextSourceSidePreviewRender', (delayMs: number) => {
    nextPreviewRenderDelayMs = Math.max(0, delayMs);
  });
  await page.exposeFunction('__getSourceSidePreviewRenderCount', () => previewRenderCount);
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__renderSourceSidePreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });

  const compactComplexBlock = [
    '<details>',
    '<summary>Compact complex block</summary>',
    ...Array.from({ length: 36 }, (_, index) => `<p>Collapsed source row ${index + 1}</p>`),
    '</details>'
  ].join('\n');
  const narrowTable = [
    '| A | Content-heavy column | C | D | E | F | G | H | I |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 1 | This column needs materially more room than the compact labels | 3 | 4 | 5 | 6 | 7 | 8 | 9 |'
  ].join('\n');
  const reportedTable = [
    '| asd | asd | asd | asd | |',
    '| --- | --- | --- | --- | --- |',
    '| **asd**332 | *asd* | ~~asd~~ | `asd` | #asd |',
    '| asd | asd | asd | sadasd | sadasd |',
    '| | | | [linked cell](https://example.com/)LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL | |',
    '| - asd | | | | |'
  ].join('\n');
  const structuredMappingBlock = [
    '## Structured mapping fixture',
    '',
    '- Apple',
    '- Banana',
    '  - Banana milk',
    '  - Banana cake',
    '    - Deep nested item',
    '      - Deeper nested item with `code`',
    '',
    'Ordered list:',
    '',
    ...Array.from({ length: 20 }, (_, index) => `${index + 1}. Ordered item ${index + 1}`),
    '   1. Nested ordered item',
    '',
    'Task list:',
    '',
    '- [x] Completed task',
    '- [ ] Pending task',
    '- [ ] Task with **formatting** and `code`',
    '- [x] Task with a displaced footnote[^mapping-note]',
    '',
    '[^mapping-note]: Footnote definitions render outside their source position.',
    '',
    'Mixed list:',
    '',
    '1. First ordered item',
    '   - Nested unordered item',
    '   - Nested task item',
    '     - [ ] Child task',
    '2. Second ordered item',
    '   > Quote in list',
    '   >',
    '   > ```js',
    '   > console.log("code in quote in list");',
    '   > ```',
    '3. Third ordered item',
    '',
    '## Structured mapping end',
    '',
    'The content after the structured range must align on both surfaces.'
  ].join('\n');
  const highlightedCodeBlock = [
    '## Highlight continuity fixture',
    '',
    '```typescript',
    'const previewHighlight = "before";',
    '```'
  ].join('\n');
  const rawHtmlTable = [
    '<table>',
    '  <thead><tr><th>HTML type</th><th>Expected behavior</th><th>Interaction</th></tr></thead>',
    '  <tbody>',
    '    <tr><td>Inline style</td><td>Embedded ordinary text</td><td>Edit current line</td></tr>',
    '    <tr><td>Link</td><td>Always shows navigation target</td><td>Click target</td></tr>',
    '    <tr><td>Block HTML</td><td>No card background</td><td>Source button edits</td></tr>',
    '  </tbody>',
    '</table>'
  ].join('\n');
  const modeTable = [
    '| Mode row | Content |',
    '| --- | --- |',
    ...Array.from({ length: 14 }, (_, index) => (
      `| Mode row ${index + 1} | Complex table content ${index + 1} |`
    ))
  ].join('\n');
  const text = [
    'Intro paragraph for formatting continuity.',
    highlightedCodeBlock,
    `### Long heading ${'6'.repeat(180)}`,
    '',
    `Ordinary paragraph ${'7'.repeat(220)}`,
    '',
    `- Ordinary list item ${'unbroken'.repeat(55)}`,
    ...Array.from({ length: 22 }, (_, index) => (
      `## Section ${index + 1}\n\nParagraph ${index + 1} with enough text to exercise semantic linked scrolling.`
    )),
    compactComplexBlock,
    narrowTable,
    reportedTable,
    rawHtmlTable,
    modeTable,
    structuredMappingBlock,
    ...Array.from({ length: 118 }, (_, index) => {
      const section = index + 23;
      return `## Section ${section}\n\nParagraph ${section} with enough text to exercise semantic linked scrolling.`;
    })
  ].join('\n\n');
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///source-side-preview.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: 'source', uiLanguage: 'en',
    uiLanguagePreference: 'auto', automaticUiLanguage: 'en', sourceLineNumbers: 'on',
    previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
    editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
    gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
    restoreReadingPositionOnOpen: false, vscodeTheme: null
  } })), text);
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.source-preview-button')?.offsetParent !== null);
  const preloadCount = previewRenderCount;

  await page.click('.source-preview-button');
  await page.waitForFunction(() => {
    const preview = document.querySelector<HTMLIFrameElement>('.preview-frame');
    return document.querySelector('.editor-surface')?.hasAttribute('data-source-preview')
      && preview?.contentDocument?.body.textContent?.includes('Section 140')
      && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility !== 'hidden';
  });
  const layout = await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('.editor-host')!;
    const preview = document.querySelector<HTMLElement>('.preview-host')!;
    const button = document.querySelector<HTMLButtonElement>('.source-preview-button')!;
    const syncButton = document.querySelector<HTMLButtonElement>('.source-preview-scroll-sync-button')!;
    const previewRect = preview.getBoundingClientRect();
    const syncRect = syncButton.getBoundingClientRect();
    return {
      editorWidth: editor.getBoundingClientRect().width,
      previewWidth: preview.getBoundingClientRect().width,
      editorVisible: !editor.hidden,
      previewVisible: !preview.hidden,
      pressed: button.getAttribute('aria-pressed'),
      label: button.textContent?.trim(),
      syncPressed: syncButton.getAttribute('aria-pressed'),
      syncVisible: syncButton.offsetParent !== null,
      splitIcon: button.querySelector('svg')?.getAttribute('data-icon'),
      syncIcon: syncButton.querySelector('svg')?.getAttribute('data-icon'),
      syncIconSize: syncButton.querySelector('svg')?.getBoundingClientRect().width,
      syncBorderRadius: getComputedStyle(syncButton).borderRadius,
      syncBorderWidth: getComputedStyle(syncButton).borderTopWidth,
      syncBoxShadow: getComputedStyle(syncButton).boxShadow,
      syncSize: { width: syncRect.width, height: syncRect.height },
      syncOffset: {
        left: syncRect.left - previewRect.left,
        top: syncRect.top - previewRect.top
      },
      focusedInEditor: editor.contains(document.activeElement)
    };
  });
  assert.equal(layout.editorVisible, true);
  assert.equal(layout.previewVisible, true);
  assert.equal(layout.pressed, 'true');
  assert.equal(layout.label, 'Exit split');
  assert.equal(layout.syncPressed, 'true');
  assert.equal(layout.syncVisible, true);
  assert.equal(layout.splitIcon, 'square-split-horizontal');
  assert.equal(layout.syncIcon, 'link');
  assert.equal(layout.syncIconSize, 14);
  assert.equal(layout.syncBorderRadius, '50%');
  assert.equal(layout.syncBorderWidth, '1px');
  assert.notEqual(layout.syncBoxShadow, 'none');
  assert.deepEqual(layout.syncSize, { width: 20, height: 20 });
  assert.ok(layout.syncOffset.left >= 2 && layout.syncOffset.left <= 4, JSON.stringify(layout));
  assert.ok(Math.abs(layout.syncOffset.top - 2) <= 0.5, JSON.stringify(layout));
  assert.equal(layout.focusedInEditor, true, 'Opening side Preview should restore editor focus');
  assert.ok(Math.abs(layout.editorWidth - layout.previewWidth) <= 2, JSON.stringify(layout));
  const tableFit = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return Array.from(frameDocument.querySelectorAll<HTMLTableElement>('table')).map(table => {
      const wrapper = table.closest<HTMLElement>('.meo-table-scroll, .meo-export-html-block')!;
      const wrapperRect = wrapper.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      const columns = Array.from(table.querySelectorAll<HTMLTableColElement>('col'));
      const lastCells = Array.from(table.rows)
        .map(row => row.cells.item(row.cells.length - 1))
        .filter((cell): cell is HTMLTableCellElement => cell !== null);
      return {
        wrapperClass: wrapper.className,
        wrapperClientWidth: wrapper.clientWidth,
        tableStyleWidth: table.style.width,
        tableRectWidth: tableRect.width,
        overflow: wrapper.scrollWidth - wrapper.clientWidth,
        overflowX: getComputedStyle(wrapper).overflowX,
        rightOverflow: tableRect.right - wrapperRect.right,
        rightSafetyInset: wrapperRect.right - tableRect.right,
        viewportRightOverflow: tableRect.right - frameDocument.documentElement.clientWidth,
        lastCellRightOverflow: Math.max(
          Number.NEGATIVE_INFINITY,
          ...lastCells.map(cell => cell.getBoundingClientRect().right - frameDocument.documentElement.clientWidth)
        ),
        widths: columns.map(column => column.getBoundingClientRect().width)
      };
    });
  });
  assert.ok(tableFit.length >= 2, JSON.stringify(tableFit));
  assert.ok(tableFit.every(table => table.overflow <= 0.5), JSON.stringify(tableFit));
  assert.ok(
    tableFit.every(table => table.overflowX === 'clip' || table.overflowX === 'hidden'),
    JSON.stringify(tableFit)
  );
  assert.ok(tableFit.every(table => table.rightOverflow <= 0.5), JSON.stringify(tableFit));
  assert.ok(tableFit.every(table => table.viewportRightOverflow <= -0.75), JSON.stringify(tableFit));
  assert.ok(tableFit.every(table => table.lastCellRightOverflow <= -0.75), JSON.stringify(tableFit));
  assert.ok(tableFit[0].widths[1] > tableFit[0].widths[0], JSON.stringify(tableFit));

  const transitionTableStartLine = text.slice(0, text.indexOf('| asd | asd | asd | asd | |')).split('\n').length;
  const transitionTableAnchorLine = transitionTableStartLine + 2;
  const alignSourceLineAtReadingBand = async (lineNumber: number) => {
    await page.click('.line-jump-input');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(String(lineNumber));
    await page.keyboard.press('Enter');
    await page.waitForFunction(line => Array.from(
      document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')
    ).some(element => Number(element.textContent) === line), {}, lineNumber);
    await page.evaluate(line => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      const gutter = Array.from(document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement'))
        .find(element => Number(element.textContent) === line)!;
      const viewport = scroller.getBoundingClientRect();
      scroller.scrollTop += gutter.getBoundingClientRect().top - viewport.top - viewport.height / 3;
    }, lineNumber);
    await new Promise(resolve => setTimeout(resolve, 100));
  };
  const startPreviewAnchorSampling = async (lineNumber: number) => page.evaluate(line => {
    const samples: Array<{ visible: boolean; offset: number | null; scrollTop: number; width: number }> = [];
    let active = true;
    const sample = () => {
      if (!active) return;
      const host = document.querySelector<HTMLElement>('.preview-host')!;
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const frameDocument = frame.contentDocument!;
      const viewportOffset = frameDocument.documentElement.clientHeight / 3;
      const projection = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
        .filter(element => {
          const start = Number(element.dataset.sourceLine);
          const end = Number(element.dataset.sourceEndLine ?? start);
          return start <= line && end >= line;
        })
        .map(element => {
          const start = Number(element.dataset.sourceLine);
          const end = Number(element.dataset.sourceEndLine ?? start);
          const rect = element.getBoundingClientRect();
          const ratio = (line - start) / Math.max(1, end - start + 1);
          return {
            offset: rect.top + rect.height * ratio - viewportOffset,
            span: end - start,
            height: rect.height
          };
        })
        .sort((left, right) => left.span - right.span || left.height - right.height)[0];
      samples.push({
        visible: !host.hidden && getComputedStyle(host).visibility !== 'hidden',
        offset: projection?.offset ?? null,
        scrollTop: frameDocument.scrollingElement?.scrollTop ?? 0,
        width: frame.getBoundingClientRect().width
      });
      requestAnimationFrame(sample);
    };
    (window as typeof window & {
      __previewModeAnchorProbe?: { samples: typeof samples; stop(): void };
    }).__previewModeAnchorProbe = { samples, stop: () => { active = false; } };
    requestAnimationFrame(sample);
  }, lineNumber);
  const stopPreviewAnchorSampling = async () => page.evaluate(() => {
    const probe = (window as typeof window & {
      __previewModeAnchorProbe: {
        samples: Array<{ visible: boolean; offset: number | null; scrollTop: number; width: number }>;
        stop(): void;
      };
    }).__previewModeAnchorProbe;
    probe.stop();
    return probe.samples;
  });

  const compactBlockStartLine = text.slice(0, text.indexOf('<details>')).split('\n').length;
  await page.click('.line-jump-input');
  await page.keyboard.type(String(compactBlockStartLine));
  await page.keyboard.press('Enter');
  await new Promise(resolve => setTimeout(resolve, 120));
  const compactBlockTrace = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const positions: number[] = [];
    for (let frame = 0; frame < 150; frame += 1) {
      scroller.scrollTop += 6;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      positions.push(frameDocument.scrollingElement!.scrollTop);
    }
    return positions;
  });
  const compactBlockReverseSteps = compactBlockTrace.filter((position, index) => (
    index > 0 && position < compactBlockTrace[index - 1] - 1
  ));
  assert.equal(
    compactBlockReverseSteps.length,
    0,
    `Compact complex blocks must not make linked Preview reverse: ${JSON.stringify(compactBlockTrace)}`
  );
  let longestStationaryPreviewRun = 0;
  let stationaryPreviewRun = 0;
  for (let index = 1; index < compactBlockTrace.length; index += 1) {
    if (Math.abs(compactBlockTrace[index] - compactBlockTrace[index - 1]) <= 0.1) {
      stationaryPreviewRun += 1;
      longestStationaryPreviewRun = Math.max(longestStationaryPreviewRun, stationaryPreviewRun);
    } else {
      stationaryPreviewRun = 0;
    }
  }
  assert.ok(
    longestStationaryPreviewRun <= 8,
    `A mapped complex range must not create a long stationary Preview plateau: ${JSON.stringify({ longestStationaryPreviewRun, compactBlockTrace })}`
  );
  const structuredTargets = [
    'Deeper nested item with',
    'Ordered item 6',
    'Ordered item 14',
    'Pending task',
    'Nested unordered item',
    'console.log("code in quote in list")',
    'Structured mapping end'
  ].map(marker => ({
    marker,
    line: text.slice(0, text.indexOf(marker)).split('\n').length
  }));
  const structuredAlignment = [] as Array<{
    marker: string;
    line: number;
    previewOffset: number | null;
    previewRange: [number, number] | null;
  }>;
  for (const target of structuredTargets) {
    await page.click('.line-jump-input');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(String(target.line));
    await page.keyboard.press('Enter');
    await page.waitForFunction(marker => Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .some(line => line.textContent?.includes(marker)), {}, target.marker);
    await page.evaluate(marker => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find(candidate => candidate.textContent?.includes(marker))!;
      const viewport = scroller.getBoundingClientRect();
      scroller.scrollTop += line.getBoundingClientRect().top - viewport.top - viewport.height / 3;
    }, target.marker);
    await new Promise(resolve => setTimeout(resolve, 40));
    structuredAlignment.push(await page.evaluate(({ marker, line }) => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const frameDocument = frame.contentDocument!;
      const readingBand = frameDocument.documentElement.clientHeight / 3;
      const candidates = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
        .filter(element => {
          const start = Number(element.dataset.sourceLine);
          const end = Number(element.dataset.sourceEndLine ?? start);
          return start <= line && end >= line;
        })
        .map(element => {
          const rect = element.getBoundingClientRect();
          return {
            offset: rect.top - readingBand,
            range: [Number(element.dataset.sourceLine), Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine)] as [number, number],
            height: rect.height
          };
        })
        .sort((left, right) => Math.abs(left.offset) - Math.abs(right.offset) || left.height - right.height);
      return {
        marker,
        line,
        previewOffset: candidates[0]?.offset ?? null,
        previewRange: candidates[0]?.range ?? null
      };
    }, target));
  }
  assert.ok(
    structuredAlignment.every(sample => sample.previewOffset !== null && Math.abs(sample.previewOffset) <= 120),
    `The same structured source range must remain in the Preview reading band: ${JSON.stringify(structuredAlignment)}`
  );
  const highlightedSourceLine = text.slice(0, text.indexOf('const previewHighlight')).split('\n').length;
  await page.click('.line-jump-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(highlightedSourceLine));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const code = Array.from(frameDocument?.querySelectorAll<HTMLElement>('code.hljs') ?? [])
      .find(candidate => candidate.textContent?.includes('previewHighlight'));
    const sources = Array.from(code?.querySelectorAll<HTMLElement>('.meo-export-code-line-source') ?? []);
    return sources.length > 0 && sources.every(source => source.dataset.meoShiki && source.querySelector('span[style*="color"]'));
  }, { timeout: 10000 });
  await page.evaluate(() => {
    const samples: Array<{ text: string; highlighted: boolean }> = [];
    let active = true;
    const sample = () => {
      if (!active) return;
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      const code = Array.from(frameDocument?.querySelectorAll<HTMLElement>('code.hljs') ?? [])
        .find(candidate => candidate.textContent?.includes('previewHighlight'));
      const sources = Array.from(code?.querySelectorAll<HTMLElement>('.meo-export-code-line-source') ?? []);
      samples.push({
        text: code?.textContent ?? '',
        highlighted: sources.length > 0
          && sources.every(source => Boolean(source.dataset.meoShiki && source.querySelector('span[style*="color"]')))
      });
      requestAnimationFrame(sample);
    };
    (window as typeof window & {
      __previewHighlightContinuityProbe?: { samples: typeof samples; stop(): void };
    }).__previewHighlightContinuityProbe = { samples, stop: () => { active = false; } };
    requestAnimationFrame(sample);
  });
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  await page.waitForFunction(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const code = Array.from(frameDocument?.querySelectorAll<HTMLElement>('code.hljs') ?? [])
      .find(candidate => candidate.textContent?.includes('previewHighlight'));
    const sources = Array.from(code?.querySelectorAll<HTMLElement>('.meo-export-code-line-source') ?? []);
    return code?.textContent?.includes(';X')
      && sources.length > 0
      && sources.every(source => source.dataset.meoShiki && source.querySelector('span[style*="color"]'));
  }, { timeout: 10000 });
  const highlightContinuityFrames = await page.evaluate(() => {
    const probe = (window as typeof window & {
      __previewHighlightContinuityProbe: { samples: Array<{ text: string; highlighted: boolean }>; stop(): void };
    }).__previewHighlightContinuityProbe;
    probe.stop();
    return probe.samples;
  });
  assert.ok(
    highlightContinuityFrames.every(frame => !frame.text.includes(';X') || frame.highlighted),
    `Updated code must not become visible before its syntax colors are ready: ${JSON.stringify(highlightContinuityFrames)}`
  );
  const structuredStartLine = text.slice(0, text.indexOf('## Structured mapping fixture')).split('\n').length;
  const structuredEndLine = text.slice(0, text.indexOf('## Structured mapping end')).split('\n').length;
  await page.click('.line-jump-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(structuredStartLine));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.cm-line')?.isConnected === true);
  const semanticScrollTrace = await page.evaluate(async ({ startLine, endLine }) => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const samples: Array<{ sourceLine: number | null; previewLine: number | null; delta: number | null }> = [];
    for (let step = 0; step <= 100; step += 1) {
      scroller.scrollTop += 12;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const sourceBand = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      const sourceLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement'))
        .map(element => ({ element, rect: element.getBoundingClientRect() }))
        .filter(entry => entry.rect.bottom >= sourceBand)
        .sort((left, right) => Math.abs(left.rect.top - sourceBand) - Math.abs(right.rect.top - sourceBand))[0]
        ?.element.textContent;
      const previewBand = frameDocument.documentElement.clientHeight / 3;
      const previewCandidates = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
        .map(element => {
          const rect = element.getBoundingClientRect();
          const start = Number(element.dataset.sourceLine);
          const end = Number(element.dataset.sourceEndLine ?? start);
          const ratio = rect.height > 0 ? Math.max(0, Math.min(1, (previewBand - rect.top) / rect.height)) : 0;
          return {
            contains: rect.top <= previewBand && rect.bottom >= previewBand,
            distance: rect.top <= previewBand ? previewBand - rect.top : rect.top - previewBand,
            height: rect.height,
            line: Math.round(start + (end - start) * ratio)
          };
        })
        .filter(entry => Number.isFinite(entry.line))
        .sort((left, right) => Number(right.contains) - Number(left.contains)
          || (left.contains && right.contains ? left.height - right.height : left.distance - right.distance));
      const parsedSourceLine = Number(sourceLine);
      const previewLine = previewCandidates[0]?.line ?? null;
      if (!Number.isFinite(parsedSourceLine) || parsedSourceLine < startLine || parsedSourceLine > endLine) continue;
      samples.push({
        sourceLine: Number.isFinite(parsedSourceLine) ? parsedSourceLine : null,
        previewLine,
        delta: Number.isFinite(parsedSourceLine) && previewLine !== null
          ? previewLine - parsedSourceLine
          : null
      });
    }
    return samples;
  }, { startLine: structuredStartLine, endLine: structuredEndLine });
  assert.ok(
    semanticScrollTrace.every(sample => sample.delta !== null && Math.abs(sample.delta) <= 12),
    `Linked scrolling must keep the same semantic source range in the reading band: ${JSON.stringify(semanticScrollTrace)}`
  );
  assert.ok(
    tableFit.every(table => table.rightSafetyInset >= 0.75),
    `The final collapsed border needs a visible safety inset: ${JSON.stringify(tableFit)}`
  );

  await page.keyboard.down('Control');
  await page.keyboard.press('Home');
  await page.keyboard.up('Control');
  const countBeforeTyping = previewRenderCount;
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await page.keyboard.type('**Intro**');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(previewRenderCount, countBeforeTyping, 'Preview refresh must yield during active typing');
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
    return frame?.contentDocument?.querySelector('strong')?.textContent === 'Intro';
  }, { timeout: 3000 });
  assert.equal(previewRenderCount, countBeforeTyping + 1, 'A typing burst should coalesce to one render');

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    scroller.scrollTop = 1800;
  });
  await page.waitForFunction(() => (
    (document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.scrollingElement?.scrollTop ?? 0) > 200
  ));

  const refreshScrollTop = await page.$eval('.cm-scroller', element => element.scrollTop);
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const frameDocument = frame.contentDocument!;
    const firstText = frameDocument.querySelector('.meo-export-doc')?.firstChild;
    if (firstText) {
      const range = frameDocument.createRange();
      range.selectNodeContents(firstText);
      const selection = frameDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const probe = {
      frameHiddenTransitions: 0,
      editorScrollTops: [] as number[],
      previewScrollTops: [] as number[],
      previewFrames: [] as Array<{
        editorScrollTop: number;
        scrollTop: number;
        sourceLine: number | null;
        anchorTop: number | null;
      }>,
      samplePreviewFrames: false,
      stablePreviewNode: frameDocument.querySelector<HTMLElement>('h2')
    };
    new MutationObserver((records) => {
      if (
        frame.style.visibility === 'hidden' ||
        records.some(record => record.oldValue?.includes('visibility: hidden'))
      ) probe.frameHiddenTransitions += 1;
    }).observe(frame, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    document.querySelector<HTMLElement>('.cm-scroller')!.addEventListener('scroll', () => {
      probe.editorScrollTops.push(document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop);
    }, { passive: true });
    frameDocument.addEventListener('scroll', () => {
      probe.previewScrollTops.push(frameDocument.scrollingElement!.scrollTop);
    }, { passive: true });
    const samplePreviewFrame = () => {
      if (!probe.samplePreviewFrames) return;
      const currentDocument = frame.contentDocument;
      const scrollTop = currentDocument?.scrollingElement?.scrollTop ?? 0;
      const anchor = Array.from(currentDocument?.querySelectorAll<HTMLElement>('[data-source-line]') ?? [])
        .find((element) => element.getBoundingClientRect().bottom > 0);
      probe.previewFrames.push({
        editorScrollTop: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
        scrollTop,
        sourceLine: anchor ? Number(anchor.dataset.sourceLine) : null,
        anchorTop: anchor?.getBoundingClientRect().top ?? null
      });
      requestAnimationFrame(samplePreviewFrame);
    };
    (probe as typeof probe & { startPreviewFrameSampling(): void; stopPreviewFrameSampling(): void })
      .startPreviewFrameSampling = () => {
        probe.previewScrollTops = [];
        probe.previewFrames = [];
        probe.samplePreviewFrames = true;
        requestAnimationFrame(samplePreviewFrame);
      };
    (probe as typeof probe & { startPreviewFrameSampling(): void; stopPreviewFrameSampling(): void })
      .stopPreviewFrameSampling = () => { probe.samplePreviewFrames = false; };
    (window as typeof window & { __sourcePreviewContinuityProbe?: typeof probe }).__sourcePreviewContinuityProbe = probe;
  });
  const sourceBounds = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.mouse.click(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + 24
  );
  await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: { startPreviewFrameSampling(): void };
    }).__sourcePreviewContinuityProbe;
    probe.startPreviewFrameSampling();
  });
  await page.mouse.move(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2
  );
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.wheel({ deltaY: 120 });
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await new Promise(resolve => setTimeout(resolve, 120));
  const sourceDrivenFrames = await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: {
        previewFrames: Array<{ editorScrollTop: number; scrollTop: number }>;
        stopPreviewFrameSampling(): void;
      };
    }).__sourcePreviewContinuityProbe;
    probe.stopPreviewFrameSampling();
    return probe.previewFrames;
  });
  const sourceFollowerLagFrames = sourceDrivenFrames.filter((frame, index) => {
    if (index === 0) return false;
    const previous = sourceDrivenFrames[index - 1];
    return Math.abs(frame.editorScrollTop - previous.editorScrollTop) > 1
      && Math.abs(frame.scrollTop - previous.scrollTop) <= 1;
  });
  assert.equal(
    sourceFollowerLagFrames.length,
    0,
    `Source-driven linked scrolling must update Preview in the same sampled frame: ${JSON.stringify(sourceDrivenFrames)}`
  );
  const sourceDrivenPreviewReverseSteps = sourceDrivenFrames.filter((frame, index) => (
    index > 0 && frame.scrollTop < sourceDrivenFrames[index - 1].scrollTop - 1
  ));
  assert.equal(
    sourceDrivenPreviewReverseSteps.length,
    0,
    `Source-driven Preview must remain monotonic through compact complex blocks: ${JSON.stringify(sourceDrivenFrames)}`
  );
  await page.mouse.click(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2
  );
  await new Promise(resolve => setTimeout(resolve, 40));
  const continuityScrollTop = await page.$eval('.cm-scroller', element => element.scrollTop);
  await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: { startPreviewFrameSampling(): void };
    }).__sourcePreviewContinuityProbe;
    probe.startPreviewFrameSampling();
  });
  const renderCountBeforeContinuityEdit = previewRenderCount;
  await page.evaluate(() => (
    (window as typeof window & { __delayNextSourceSidePreviewRender(delayMs: number): Promise<void> })
      .__delayNextSourceSidePreviewRender(500)
  ));
  const continuityEdit = 'CONTINUITY';
  await page.keyboard.type(continuityEdit);
  await page.waitForFunction(async count => (
    await (window as typeof window & { __getSourceSidePreviewRenderCount(): Promise<number> })
      .__getSourceSidePreviewRenderCount()
  ) > count, {}, renderCountBeforeContinuityEdit);
  const inFlightPresentation = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const status = document.querySelector<HTMLElement>('.preview-status')!;
    return {
      frameVisibility: frame.style.visibility,
      oldFrameStillVisible: frame.contentDocument?.body.textContent?.includes('Section 140'),
      statusHidden: status.hidden
    };
  });
  await page.waitForFunction(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes('CONTINUITY')
  ), { timeout: 3000 });
  await new Promise(resolve => setTimeout(resolve, 100));
  const continuity = await page.evaluate((beforeScrollTop) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: {
        frameHiddenTransitions: number;
        editorScrollTops: number[];
        previewScrollTops: number[];
        previewFrames: Array<{
          editorScrollTop: number;
          scrollTop: number;
          sourceLine: number | null;
          anchorTop: number | null;
        }>;
        stablePreviewNode: HTMLElement | null;
        stopPreviewFrameSampling(): void;
      };
    }).__sourcePreviewContinuityProbe;
    probe.stopPreviewFrameSampling();
    const editorScrollTop = document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop;
    return {
      ...probe,
      stablePreviewNodePreserved: probe.stablePreviewNode?.isConnected === true
        && frameDocument.querySelector('h2') === probe.stablePreviewNode,
      editorScrollDelta: editorScrollTop - beforeScrollTop,
      documentOverflow: frameDocument.documentElement.scrollWidth - frameDocument.documentElement.clientWidth,
      bodyOverflow: frameDocument.body.scrollWidth - frameDocument.body.clientWidth,
      horizontalScrollbarHeight: frameDocument.defaultView!
        .getComputedStyle(frameDocument.documentElement, '::-webkit-scrollbar').height
    };
  }, continuityScrollTop);
  assert.deepEqual(inFlightPresentation, {
    frameVisibility: '',
    oldFrameStillVisible: true,
    statusHidden: true
  }, 'An existing Preview must remain unobstructed while its replacement renders');
  assert.equal(continuity.frameHiddenTransitions, 0, 'Preview updates must never hide the current frame');
  assert.equal(continuity.stablePreviewNodePreserved, true, 'Unchanged Preview blocks must survive a live update');
  assert.ok(Math.abs(continuity.editorScrollDelta) <= 2, JSON.stringify(continuity));
  assert.ok(continuity.previewFrames.length >= 2, JSON.stringify(continuity));
  assert.ok(continuity.previewFrames.every(frame => frame.sourceLine !== null), JSON.stringify(continuity));
  const previewScrollRange = Math.max(...continuity.previewFrames.map(frame => frame.scrollTop))
    - Math.min(...continuity.previewFrames.map(frame => frame.scrollTop));
  assert.ok(previewScrollRange <= 1, JSON.stringify(continuity));
  assert.ok(continuity.documentOverflow <= 1 && continuity.bodyOverflow <= 1, JSON.stringify(continuity));
  assert.equal(continuity.horizontalScrollbarHeight, '0px');

  await page.evaluate(() => {
    const frameWindow = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!;
    const wide = frameWindow.document.createElement('div');
    wide.className = 'meo-export-html-block';
    wide.dataset.testGenuineHorizontalOverflow = 'true';
    const content = frameWindow.document.createElement('div');
    content.style.width = '1800px';
    content.style.height = '1px';
    wide.append(content);
    frameWindow.document.querySelector('.meo-export-doc')!.append(wide);
    frameWindow.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const overflow = frameDocument?.querySelector<HTMLElement>('[data-test-genuine-horizontal-overflow]');
    return Boolean(overflow && overflow.scrollWidth - overflow.clientWidth > 500);
  });
  const genuineOverflow = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const localScroller = frameDocument.querySelector<HTMLElement>('[data-test-genuine-horizontal-overflow]')!;
    return {
      rootOverflow: frameDocument.documentElement.scrollWidth - frameDocument.documentElement.clientWidth,
      rootScrollbarHeight: frameDocument.defaultView!
        .getComputedStyle(frameDocument.documentElement, '::-webkit-scrollbar').height,
      localOverflow: localScroller.scrollWidth - localScroller.clientWidth,
      localOverflowX: frameDocument.defaultView!.getComputedStyle(localScroller).overflowX
    };
  });
  assert.ok(genuineOverflow.localOverflow > 500, JSON.stringify(genuineOverflow));
  assert.equal(genuineOverflow.localOverflowX, 'auto');
  assert.ok(genuineOverflow.rootOverflow <= 1, JSON.stringify(genuineOverflow));
  assert.equal(genuineOverflow.rootScrollbarHeight, '0px');
  await page.evaluate(() => {
    const frameWindow = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!;
    frameWindow.document.querySelector('[data-test-genuine-horizontal-overflow]')?.remove();
    frameWindow.dispatchEvent(new Event('resize'));
  });

  // Keep the caret inside the currently rendered Source viewport so this check
  // observes selection movement rather than CodeMirror virtualizing an old,
  // off-screen DOM selection left by an earlier fixture phase.
  await page.mouse.click(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2
  );
  const selectionBefore = await page.evaluate(() => {
    const selection = document.getSelection();
    const anchorNode = selection?.anchorNode;
    const line = anchorNode instanceof Element
      ? anchorNode.closest<HTMLElement>('.cm-line')
      : anchorNode?.parentElement?.closest<HTMLElement>('.cm-line');
    if (!selection || !anchorNode || !line) return null;
    const range = document.createRange();
    range.selectNodeContents(line);
    range.setEnd(anchorNode, selection.anchorOffset);
    return { lineText: line.textContent, offset: range.toString().length };
  });
  const frameBounds = await page.$eval('.preview-frame', frame => {
    const rect = frame.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const editorScrollBefore = await page.$eval('.cm-scroller', element => element.scrollTop);
  await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: {
        frameHiddenTransitions: number;
        editorScrollTops: number[];
        previewScrollTops?: number[];
        startPreviewFrameSampling(): void;
      };
    }).__sourcePreviewContinuityProbe;
    probe.editorScrollTops = [];
    probe.previewScrollTops = [];
    probe.startPreviewFrameSampling();
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    frameDocument.addEventListener('scroll', () => {
      probe.previewScrollTops!.push(frameDocument.scrollingElement!.scrollTop);
    }, { passive: true });
  });
  await page.mouse.move(frameBounds.x + frameBounds.width / 2, frameBounds.y + frameBounds.height / 2);
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.wheel({ deltaY: 120 });
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await page.waitForFunction(previous => (
    Math.abs(document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop - previous) > 100
  ), { timeout: 3000 }, editorScrollBefore);
  const selectionAfter = await page.evaluate(() => {
    document.querySelector<HTMLElement>('.cm-content')?.focus({ preventScroll: true });
    const selection = document.getSelection();
    const anchorNode = selection?.anchorNode;
    const line = anchorNode instanceof Element
      ? anchorNode.closest<HTMLElement>('.cm-line')
      : anchorNode?.parentElement?.closest<HTMLElement>('.cm-line');
    if (!selection || !anchorNode || !line) return null;
    const range = document.createRange();
    range.selectNodeContents(line);
    range.setEnd(anchorNode, selection.anchorOffset);
    return { lineText: line.textContent, offset: range.toString().length };
  });
  assert.deepEqual(selectionAfter, selectionBefore, 'Preview-driven scroll must not move Source selection');
  const scrollTrace = await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: {
        editorScrollTops: number[];
        previewScrollTops?: number[];
        previewFrames: Array<{ editorScrollTop: number; scrollTop: number }>;
        stopPreviewFrameSampling(): void;
      };
    }).__sourcePreviewContinuityProbe;
    probe.stopPreviewFrameSampling();
    return {
      editor: probe.editorScrollTops,
      preview: probe.previewScrollTops ?? [],
      frames: probe.previewFrames
    };
  });
  const hasReverseStep = (values: number[]) => values.some((value, index) => (
    index > 0 && value < values[index - 1] - 1
  ));
  assert.equal(hasReverseStep(scrollTrace.preview), false, JSON.stringify(scrollTrace));
  assert.equal(hasReverseStep(scrollTrace.editor), false, JSON.stringify(scrollTrace));
  const previewFollowerLagFrames = scrollTrace.frames.filter((frame, index) => {
    if (index === 0) return false;
    const previous = scrollTrace.frames[index - 1];
    return Math.abs(frame.scrollTop - previous.scrollTop) > 5
      && Math.abs(frame.editorScrollTop - previous.editorScrollTop) <= 1;
  });
  assert.equal(
    previewFollowerLagFrames.length,
    0,
    `Preview-driven linked scrolling must update Source in the same sampled frame: ${JSON.stringify(scrollTrace.frames)}`
  );

  await page.click('button[data-mode="live"]');
  await page.waitForFunction(() => (
    document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live'
    && document.querySelector<HTMLElement>('.preview-host')?.hidden === true
  ));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => {
    const samples: Array<{ hidden: boolean; scrollTop: number }> = [];
    let remaining = 24;
    const sample = () => {
      const host = document.querySelector<HTMLElement>('.preview-host')!;
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument;
      samples.push({
        hidden: host.hidden || getComputedStyle(host).visibility === 'hidden',
        scrollTop: frameDocument?.scrollingElement?.scrollTop ?? 0
      });
      remaining -= 1;
      if (remaining > 0) requestAnimationFrame(sample);
    };
    (window as typeof window & { __sourceSplitEntrySamples?: typeof samples }).__sourceSplitEntrySamples = samples;
    requestAnimationFrame(sample);
  });
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
  await new Promise(resolve => setTimeout(resolve, 450));
  const splitEntrySamples = await page.evaluate(() => (
    (window as typeof window & {
      __sourceSplitEntrySamples: Array<{ hidden: boolean; scrollTop: number }>;
    }).__sourceSplitEntrySamples
  ));
  const visibleSplitEntryPositions = splitEntrySamples
    .filter(sample => !sample.hidden)
    .map(sample => sample.scrollTop);
  assert.ok(visibleSplitEntryPositions.length >= 2, JSON.stringify(splitEntrySamples));
  assert.ok(
    Math.max(...visibleSplitEntryPositions) - Math.min(...visibleSplitEntryPositions) <= 1,
    `A split Preview must be at its final position before its first visible frame: ${JSON.stringify(splitEntrySamples)}`
  );

  const modeAnchorText = 'Section 80';
  const modeAnchorLine = text.slice(0, text.indexOf(`## ${modeAnchorText}`)).split('\n').length;
  await page.click('.line-jump-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(modeAnchorLine));
  await page.keyboard.press('Enter');
  await page.waitForFunction(anchorText => Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
    .some(line => line.textContent?.includes(anchorText)), {}, modeAnchorText);
  await page.evaluate(anchorText => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find(candidate => candidate.textContent?.includes(anchorText))!;
    const viewport = scroller.getBoundingClientRect();
    scroller.scrollTop += line.getBoundingClientRect().top - viewport.top - viewport.height / 3;
  }, modeAnchorText);
  await new Promise(resolve => setTimeout(resolve, 120));
  const readModeAnchorOffset = async (surface: 'editor' | 'preview') => page.evaluate(({ surface, anchorText }) => {
    if (surface === 'preview') {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const heading = Array.from(frame.contentDocument!.querySelectorAll<HTMLElement>('h2'))
        .find(candidate => candidate.textContent?.includes(anchorText))!;
      return heading.getBoundingClientRect().top;
    }
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find(candidate => candidate.textContent?.includes(anchorText))!;
    return line.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, { surface, anchorText: modeAnchorText });
  const modeAnchorOffsets: Array<{ mode: string; offset: number }> = [
    { mode: 'source', offset: await readModeAnchorOffset('editor') }
  ];
  await page.click('button[data-mode="live"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live');
  await new Promise(resolve => setTimeout(resolve, 160));
  modeAnchorOffsets.push({ mode: 'live', offset: await readModeAnchorOffset('editor') });
  await page.evaluate(anchorText => {
    const samples: number[] = [];
    let remaining = 16;
    const sample = () => {
      const root = document.querySelector<HTMLElement>('#app');
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
      const heading = Array.from(frame?.contentDocument?.querySelectorAll<HTMLElement>('h2') ?? [])
        .find(candidate => candidate.textContent?.includes(anchorText));
      if (root?.dataset.mode === 'preview' && heading) samples.push(heading.getBoundingClientRect().top);
      remaining -= 1;
      if (remaining > 0) requestAnimationFrame(sample);
    };
    (window as typeof window & { __fullPreviewEntryAnchorSamples?: number[] })
      .__fullPreviewEntryAnchorSamples = samples;
    requestAnimationFrame(sample);
  }, modeAnchorText);
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
  await new Promise(resolve => setTimeout(resolve, 160));
  modeAnchorOffsets.push({ mode: 'preview', offset: await readModeAnchorOffset('preview') });
  const fullPreviewEntryAnchorSamples = await page.evaluate(() => (
    (window as typeof window & { __fullPreviewEntryAnchorSamples?: number[] })
      .__fullPreviewEntryAnchorSamples ?? []
  ));
  assert.ok(fullPreviewEntryAnchorSamples.length >= 2, JSON.stringify(fullPreviewEntryAnchorSamples));
  assert.ok(
    Math.max(...fullPreviewEntryAnchorSamples) - Math.min(...fullPreviewEntryAnchorSamples) <= 2,
    `Full Preview must enter at its final reading position: ${JSON.stringify(fullPreviewEntryAnchorSamples)}`
  );
  const fullPreviewTableFit = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return Array.from(frameDocument.querySelectorAll<HTMLTableElement>('table')).map(table => {
      const wrapper = table.closest<HTMLElement>('.meo-table-scroll, .meo-export-html-block')!;
      const wrapperRect = wrapper.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      return {
        overflow: wrapper.scrollWidth - wrapper.clientWidth,
        overflowX: getComputedStyle(wrapper).overflowX,
        rightOverflow: tableRect.right - wrapperRect.right,
        rightSafetyInset: wrapperRect.right - tableRect.right
      };
    });
  });
  assert.ok(fullPreviewTableFit.every(table => table.overflow <= 0.5), JSON.stringify(fullPreviewTableFit));
  assert.ok(
    fullPreviewTableFit.every(table => table.overflowX === 'clip' || table.overflowX === 'hidden'),
    JSON.stringify(fullPreviewTableFit)
  );
  assert.ok(fullPreviewTableFit.every(table => table.rightOverflow <= 0.5), JSON.stringify(fullPreviewTableFit));
  assert.ok(fullPreviewTableFit.every(table => table.rightSafetyInset >= 0.75), JSON.stringify(fullPreviewTableFit));
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
  await new Promise(resolve => setTimeout(resolve, 160));
  modeAnchorOffsets.push({ mode: 'source-return', offset: await readModeAnchorOffset('editor') });
  const baselineModeAnchorOffset = modeAnchorOffsets[0].offset;
  assert.ok(
    modeAnchorOffsets.every(sample => Math.abs(sample.offset - baselineModeAnchorOffset) <= 20),
    `Mode switches must keep one semantic reading anchor on the same screen band: ${JSON.stringify(modeAnchorOffsets)}`
  );

  const complexTableStartLine = text.slice(0, text.indexOf('| Mode row | Content |')).split('\n').length;
  const complexTableAnchorText = 'Mode row 8';
  const complexTableAnchorLine = complexTableStartLine + 9;
  await page.click('.line-jump-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(String(complexTableAnchorLine));
  await page.keyboard.press('Enter');
  await page.waitForFunction(anchorText => Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
    .some(line => line.textContent?.includes(anchorText)), {}, complexTableAnchorText);
  await page.evaluate(anchorText => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find(candidate => candidate.textContent?.includes(anchorText))!;
    const viewport = scroller.getBoundingClientRect();
    scroller.scrollTop += line.getBoundingClientRect().top - viewport.top - viewport.height / 3;
  }, complexTableAnchorText);
  await new Promise(resolve => setTimeout(resolve, 100));
  const complexTableSourceOffset = await page.evaluate(anchorText => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find(candidate => candidate.textContent?.includes(anchorText))!;
    return line.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, complexTableAnchorText);
  await page.click('button[data-mode="live"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live');
  await new Promise(resolve => setTimeout(resolve, 160));
  const complexTableLiveProjection = await page.evaluate(({ startLine, targetLine }) => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const blocks = Array.from(document.querySelectorAll<HTMLElement>(
      '[data-meo-rendered-block-start-line][data-meo-rendered-block-end-line]'
    ));
    const block = blocks.find(candidate => Number(candidate.dataset.meoRenderedBlockStartLine) === startLine);
    if (!block) return Number.NaN;
    const rect = block.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    const endLine = Number(block.dataset.meoRenderedBlockEndLine);
    const progress = (targetLine - startLine) / Math.max(1, endLine - startLine);
    return rect.top - viewport.top + rect.height * progress;
  }, { startLine: complexTableStartLine, targetLine: complexTableAnchorLine });
  assert.ok(
    Math.abs(complexTableLiveProjection - complexTableSourceOffset) <= 20,
    JSON.stringify({ complexTableSourceOffset, complexTableLiveProjection })
  );
  const complexLiveSemanticAnchor = await page.evaluate(startLine => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const viewport = scroller.getBoundingClientRect();
    const readingY = viewport.top + viewport.height / 3;
    const block = Array.from(document.querySelectorAll<HTMLElement>(
      '[data-meo-rendered-block-start-line][data-meo-rendered-block-end-line]'
    )).find(candidate => Number(candidate.dataset.meoRenderedBlockStartLine) === startLine);
    if (!block) return null;
    const rect = block.getBoundingClientRect();
    return {
      startLine: Number(block.dataset.meoRenderedBlockStartLine),
      endLine: Number(block.dataset.meoRenderedBlockEndLine),
      progress: Math.max(0, Math.min(1, (readingY - rect.top) / Math.max(1, rect.height)))
    };
  }, complexTableStartLine);
  assert.ok(complexLiveSemanticAnchor, 'The table fixture must expose a rendered semantic range');
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
  await new Promise(resolve => setTimeout(resolve, 160));
  const complexPreviewSemanticOffset = await page.evaluate(anchor => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const readingBand = frameDocument.documentElement.clientHeight / 3;
    const entry = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
      .filter(element => (
        Number(element.dataset.sourceLine) === anchor.startLine
        && Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine) === anchor.endLine
      ))
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .sort((left, right) => Math.abs(left.rect.top - readingBand) - Math.abs(right.rect.top - readingBand))[0];
    return entry
      ? entry.rect.top + entry.rect.height * anchor.progress - readingBand
      : null;
  }, complexLiveSemanticAnchor!);
  assert.ok(
    complexPreviewSemanticOffset !== null && Math.abs(complexPreviewSemanticOffset) <= 2,
    `Live-to-Preview must preserve continuous table progress: ${JSON.stringify({ complexLiveSemanticAnchor, complexPreviewSemanticOffset })}`
  );
  const previewCapturedSemanticAnchor = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const viewportTop = frameDocument.scrollingElement?.scrollTop ?? 0;
    const viewportAnchor = viewportTop + frameDocument.documentElement.clientHeight / 3;
    const entries = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          start: Number(element.dataset.sourceLine),
          end: Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine),
          top: rect.top + viewportTop,
          bottom: rect.bottom + viewportTop,
          tag: element.tagName,
          height: rect.height
        };
      })
      .sort((left, right) => left.top - right.top || left.bottom - right.bottom || left.start - right.start);
    let low = 0;
    let high = entries.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (entries[middle].top <= viewportAnchor + 0.5) low = middle + 1;
      else high = middle - 1;
    }
    const candidate = entries[Math.max(0, high)];
    return candidate ? {
      startLine: candidate.start,
      endLine: candidate.end,
      progress: Math.max(0, Math.min(1, (viewportAnchor - candidate.top) / Math.max(1, candidate.height)))
    } : null;
  });
  assert.ok(previewCapturedSemanticAnchor, 'Preview must capture a semantic range at the reading band');
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
  await new Promise(resolve => setTimeout(resolve, 160));
  const complexSourceSemanticOffset = await page.evaluate(anchor => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const viewport = scroller.getBoundingClientRect();
    const lineSpan = Math.max(1, anchor.endLine - anchor.startLine + 1);
    const rangeOffset = lineSpan * anchor.progress;
    const lineIndex = Math.min(lineSpan - 1, Math.floor(rangeOffset));
    const lineNumber = anchor.startLine + lineIndex;
    const lineProgress = anchor.progress >= 1 ? 1 : rangeOffset - lineIndex;
    const gutter = Array.from(document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement'))
      .find(element => Number(element.textContent) === lineNumber);
    if (!gutter) return null;
    const rect = gutter.getBoundingClientRect();
    return rect.top + rect.height * lineProgress - viewport.top - viewport.height / 3;
  }, previewCapturedSemanticAnchor!);
  assert.ok(
    complexSourceSemanticOffset !== null && Math.abs(complexSourceSemanticOffset) <= 2,
    `Preview-to-Source must preserve continuous table progress: ${JSON.stringify({ previewCapturedSemanticAnchor, complexSourceSemanticOffset })}`
  );
  const complexTableSourceReturnOffset = await page.evaluate(anchorText => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find(candidate => candidate.textContent?.includes(anchorText))!;
    return line.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, complexTableAnchorText);
  assert.ok(
    Math.abs(complexTableSourceReturnOffset - complexTableSourceOffset) <= 20,
    JSON.stringify({ complexTableSourceOffset, complexTableSourceReturnOffset })
  );

  const splitSourceBounds = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(splitSourceBounds.x, splitSourceBounds.y);
  await page.mouse.wheel({ deltaY: 1 });
  await new Promise(resolve => setTimeout(resolve, 80));
  const splitModeRoundTripScrollTops = [await page.$eval(
    '.cm-scroller',
    element => (element as HTMLElement).scrollTop
  )];
  for (let round = 0; round < 8; round += 1) {
    await page.click('button[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
    await new Promise(resolve => setTimeout(resolve, 80));
    await page.click('button[data-mode="source"]');
    await page.waitForFunction(() => (
      document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source'
      && document.querySelector<HTMLElement>('.editor-surface')?.hasAttribute('data-source-preview')
      && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility !== 'hidden'
    ));
    await new Promise(resolve => setTimeout(resolve, 120));
    splitModeRoundTripScrollTops.push(await page.$eval(
      '.cm-scroller',
      element => (element as HTMLElement).scrollTop
    ));
  }
  const splitModeRoundTripBaseline = splitModeRoundTripScrollTops[0]!;
  const splitModeRoundTripDrift = splitModeRoundTripScrollTops.map(
    scrollTop => scrollTop - splitModeRoundTripBaseline
  );
  assert.ok(
    splitModeRoundTripDrift.every(drift => Math.abs(drift) <= 2),
    `Repeated Source split ↔ Preview round-trips must not accumulate viewport drift: ${JSON.stringify(splitModeRoundTripDrift)}`
  );

  const splitPreviewRoundTripBounds = await page.$eval('.preview-frame', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(splitPreviewRoundTripBounds.x, splitPreviewRoundTripBounds.y);
  await page.mouse.wheel({ deltaY: 1 });
  await new Promise(resolve => setTimeout(resolve, 80));
  const previewOwnedRoundTripScrollTops = [await page.$eval(
    '.preview-frame',
    frame => (frame as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop
  )];
  for (let round = 0; round < 8; round += 1) {
    await page.click('button[data-mode="preview"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
    await new Promise(resolve => setTimeout(resolve, 80));
    await page.click('button[data-mode="source"]');
    await page.waitForFunction(() => (
      document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source'
      && document.querySelector<HTMLElement>('.editor-surface')?.hasAttribute('data-source-preview')
      && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility !== 'hidden'
    ));
    await new Promise(resolve => setTimeout(resolve, 120));
    previewOwnedRoundTripScrollTops.push(await page.$eval(
      '.preview-frame',
      frame => (frame as HTMLIFrameElement).contentDocument!.scrollingElement!.scrollTop
    ));
  }
  const previewOwnedRoundTripBaseline = previewOwnedRoundTripScrollTops[0]!;
  const previewOwnedRoundTripDrift = previewOwnedRoundTripScrollTops.map(
    scrollTop => scrollTop - previewOwnedRoundTripBaseline
  );
  assert.ok(
    previewOwnedRoundTripDrift.every(drift => Math.abs(drift) <= 2),
    `Preview-owned Source split ↔ Preview round-trips must not accumulate viewport drift: ${JSON.stringify(previewOwnedRoundTripDrift)}`
  );

  await alignSourceLineAtReadingBand(transitionTableAnchorLine);
  await page.click('button[data-mode="live"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live');
  await new Promise(resolve => setTimeout(resolve, 120));
  await startPreviewAnchorSampling(transitionTableAnchorLine);
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
  await new Promise(resolve => setTimeout(resolve, 220));
  const splitModeEntryFrames = await stopPreviewAnchorSampling();
  const visibleSplitModeOffsets = splitModeEntryFrames
    .filter(frame => frame.visible && frame.offset !== null)
    .map(frame => frame.offset as number);
  assert.ok(visibleSplitModeOffsets.length >= 2, JSON.stringify(splitModeEntryFrames));
  assert.ok(
    Math.max(...visibleSplitModeOffsets) - Math.min(...visibleSplitModeOffsets) <= 1,
    `Split Preview content must not reflow after its first visible frame: ${JSON.stringify(splitModeEntryFrames)}`
  );

  await alignSourceLineAtReadingBand(transitionTableAnchorLine);
  const splitPreviewBounds = await page.$eval('.preview-frame', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(splitPreviewBounds.x, splitPreviewBounds.y);
  await page.mouse.wheel({ deltaY: 1 });
  await new Promise(resolve => setTimeout(resolve, 80));
  const sourceToFullReadingAnchor = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const viewportTop = frameDocument.scrollingElement?.scrollTop ?? 0;
    const viewportAnchor = viewportTop + frameDocument.documentElement.clientHeight / 3;
    const entries = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          startLine: Number(element.dataset.sourceLine),
          endLine: Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine),
          top: rect.top + viewportTop,
          bottom: rect.bottom + viewportTop,
          height: rect.height
        };
      })
      .sort((left, right) => left.top - right.top || left.bottom - right.bottom || left.startLine - right.startLine);
    let low = 0;
    let high = entries.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (entries[middle].top <= viewportAnchor + 0.5) low = middle + 1;
      else high = middle - 1;
    }
    const candidate = entries[Math.max(0, high)];
    return candidate ? {
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      progress: Math.max(0, Math.min(1, (viewportAnchor - candidate.top) / Math.max(1, candidate.height)))
    } : null;
  });
  assert.ok(sourceToFullReadingAnchor, 'Split Preview must expose a semantic reading anchor');
  await startPreviewAnchorSampling(transitionTableAnchorLine);
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
  await new Promise(resolve => setTimeout(resolve, 220));
  const sourceToFullPreviewFrames = await stopPreviewAnchorSampling();
  const visibleSourceToFullPreviewFrames = sourceToFullPreviewFrames
    .filter(frame => frame.visible && frame.offset !== null);
  const finalFullPreviewFrame = visibleSourceToFullPreviewFrames.at(-1);
  assert.ok(finalFullPreviewFrame, JSON.stringify(sourceToFullPreviewFrames));
  assert.ok(
    Math.abs(finalFullPreviewFrame.offset as number) <= 20,
    `Source-to-Preview must project the complex anchor after full-width layout: ${JSON.stringify(sourceToFullPreviewFrames)}`
  );
  const finalReadingAnchorOffset = await page.evaluate(anchor => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const readingBand = frameDocument.documentElement.clientHeight / 3;
    const entry = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
      .filter(element => (
        Number(element.dataset.sourceLine) === anchor.startLine
        && Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine) === anchor.endLine
      ))
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .sort((left, right) => Math.abs(left.rect.top - readingBand) - Math.abs(right.rect.top - readingBand))[0];
    return entry
      ? entry.rect.top + entry.rect.height * anchor.progress - readingBand
      : null;
  }, sourceToFullReadingAnchor!);
  assert.ok(
    finalReadingAnchorOffset !== null && Math.abs(finalReadingAnchorOffset) <= 1,
    `Source-to-Preview must preserve the already-visible Preview reading anchor: ${JSON.stringify({ sourceToFullReadingAnchor, finalReadingAnchorOffset, sourceToFullPreviewFrames })}`
  );
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
  await new Promise(resolve => setTimeout(resolve, 120));

  await page.evaluate(() => {
    const sourceScroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    sourceScroller.scrollTop = 600;
    sourceScroller.dispatchEvent(new Event('scroll'));
  });
  await new Promise(resolve => setTimeout(resolve, 120));
  await page.click('.preview-host > .document-scroll-top');
  await new Promise(resolve => setTimeout(resolve, 120));
  const previewButtonTop = await page.evaluate(() => ({
    source: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
    preview: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  }));
  assert.ok(
    previewButtonTop.source <= 0.5 && previewButtonTop.preview <= 0.5,
    `Preview back-to-top must move both linked surfaces: ${JSON.stringify(previewButtonTop)}`
  );

  const previewFrameBounds = await page.$eval('.preview-frame', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(previewFrameBounds.x, previewFrameBounds.y);
  await page.mouse.wheel({ deltaY: 600 });
  await new Promise(resolve => setTimeout(resolve, 120));
  await page.click('.editor-host > .document-scroll-top');
  await new Promise(resolve => setTimeout(resolve, 120));
  const sourceButtonTop = await page.evaluate(() => ({
    source: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
    preview: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  }));
  assert.ok(
    sourceButtonTop.source <= 0.5 && sourceButtonTop.preview <= 0.5,
    `Source back-to-top must move both linked surfaces: ${JSON.stringify(sourceButtonTop)}`
  );

  await page.click('.source-preview-scroll-sync-button');
  const independentState = await page.$eval('.source-preview-scroll-sync-button', button => ({
    pressed: button.getAttribute('aria-pressed'),
    independent: button.classList.contains('is-independent'),
    icon: button.querySelector('svg')?.getAttribute('data-icon')
  }));
  assert.equal(independentState.pressed, 'false');
  assert.equal(independentState.independent, true);
  assert.equal(independentState.icon, 'unlink');
  const independentStart = await page.evaluate(() => ({
    source: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
    preview: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  }));
  const syncButtonBounds = await page.$eval('.source-preview-scroll-sync-button', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(syncButtonBounds.x, syncButtonBounds.y);
  await page.mouse.wheel({ deltaY: 600 });
  await new Promise(resolve => setTimeout(resolve, 120));
  const independentWheel = await page.evaluate(() => ({
    source: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
    preview: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  }));
  assert.ok(
    independentWheel.preview > independentStart.preview + 100,
    `Wheel over the floating sync control must keep scrolling Preview: ${JSON.stringify({ independentStart, independentWheel })}`
  );
  assert.ok(
    Math.abs(independentWheel.source - independentStart.source) <= 0.5,
    `Independent Preview scrolling must not move Source: ${JSON.stringify({ independentStart, independentWheel })}`
  );
  await page.click('.source-preview-scroll-sync-button');
  await new Promise(resolve => setTimeout(resolve, 120));
  const relinkedState = await page.evaluate(() => ({
    pressed: document.querySelector('.source-preview-scroll-sync-button')?.getAttribute('aria-pressed'),
    source: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
    preview: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  }));
  assert.equal(relinkedState.pressed, 'true');
  assert.ok(
    relinkedState.source > independentStart.source + 100,
    `Re-enabling sync must align once from the last active Preview pane: ${JSON.stringify({ independentStart, independentWheel, relinkedState })}`
  );

  await page.click('.source-preview-button');
  const closed = await page.evaluate(() => ({
    split: document.querySelector('.editor-surface')?.hasAttribute('data-source-preview'),
    previewHidden: document.querySelector<HTMLElement>('.preview-host')?.hidden,
    editorHidden: document.querySelector<HTMLElement>('.editor-host')?.hidden,
    label: document.querySelector<HTMLButtonElement>('.source-preview-button')?.textContent?.trim(),
    syncVisible: document.querySelector<HTMLElement>('.source-preview-scroll-sync-button')?.offsetParent !== null
  }));
  assert.deepEqual(closed, {
    split: false,
    previewHidden: true,
    editorHidden: false,
    label: 'Split preview',
    syncVisible: false
  });
  const closedRenderCount = previewRenderCount;
  await page.keyboard.type('OFF');
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(previewRenderCount, closedRenderCount, 'Closed side Preview must add no typing work');
  assert.ok(preloadCount >= 1, 'The fixture should exercise the existing hidden preload path');
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}

console.log('Source side Preview checks passed');
