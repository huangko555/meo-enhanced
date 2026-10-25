import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { closeTestBrowser } from './browser-test-helpers';
import { browser, server, open, frames, assertStablePaint, captureResult, observedPaints } from './input-presentation-test-helpers';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const padding = '\n\n' + 'Padding paragraph with **formatting**.\n\n'.repeat(5000);
const notes = ['# Notes', '', 'References[^one] and [^two].', '',
  '| Location | Description |', '| --- | --- |', '| item | Reference[^two] |', '| nested | > - [ ] Note[^one] |', '',
  '[^one]: Note typing target.', '', '[^two]: Second note.', '', '    Continuation.', '',
  ...Array.from({ length: 40 }, (_, i) => `Nearby tail ${i}.`)].join('\n');
const source = ['# Complex source', '', ...Array.from({ length: 90 }, (_, i) => `Prefix paragraph ${i}.\n`),
  '> A quote before the input.', '',
  '3. First item.', '4. Second item.', '   1. Nested item.', '   2. Other nested item.', '5. Final item.', '',
  '- [ ] Earlier task.', '- [x] Checked task.', '- [ ] Typing target with reference[^one].', '',
  '```typescript', 'const preserved = 123;', '```', '',
  '| A | B |', '| --- | --- |', '| stable | Reference[^two] |', '',
  '<details open><summary>Details</summary><p>Preserved HTML.</p></details>', '',
  '$$', 'x^2+y^2=1', '$$', '', 'Reference[^one] and [^two].', '',
  '[^one]: First note.', '', '[^two]: Second note.', '',
  ...Array.from({ length: 60 }, (_, i) => `Suffix paragraph ${i}.\n`)].join('\n');

async function setMode(page: Page, mode: 'source' | 'live') {
  if (mode === 'source') return;
  await page.locator(`.mode-group [data-mode="${mode}"]`).click();
  await page.waitForFunction(() => document.querySelector('.editor-host > .cm-editor.meo-mode-live')
    && !document.querySelector('.mode-group [aria-busy="true"]'));
}
async function placeCaret(page: Page, needle: string, center = true) {
  await page.evaluate(needle => {
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    const start = view.state.doc.toString().indexOf(needle);
    if (start < 0) throw new Error('Missing input target');
    const position = view.state.doc.lineAt(start).to;
    view.dispatch({ selection: { anchor: position }, scrollIntoView: true }); view.focus();
  }, needle);
  await delay(500);
  if (center) for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => {
      const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      const point = view.coordsAtPos(view.state.selection.main.head), rect = view.scrollDOM.getBoundingClientRect();
      view.scrollDOM.scrollTop += point.top - rect.top - rect.height / 2;
    });
    await delay(200);
  }
  await page.evaluate(() => document.fonts.ready.then(() => {}));
  await frames(page, 8);
}
async function observe(page: Page, kind: 'gutter' | 'preview', beforeInputOnly = false) {
  return page.evaluate(({ kind, beforeInputOnly }) => {
    const scope = window as any;
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    const doc = kind === 'gutter' ? document : document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const selector = kind === 'gutter' ? '.editor-host .cm-lineNumbers > .cm-gutterElement' : '[data-source-line]:not([data-meo-preview-gap])';
    const height = kind === 'gutter' ? innerHeight : doc.defaultView!.innerHeight;
    const witnesses = [...doc.querySelectorAll<HTMLElement>(selector)].filter(element => {
      const r = element.getBoundingClientRect();
      const from = Number(element.dataset.sourceLine), to = Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine);
      return r.top >= 80 && r.bottom < height - 25 && element.textContent!.trim()
        && (kind === 'gutter' ? /^\d+$/.test(element.textContent!.trim()) : beforeInputOnly ? to < line : !(from <= line && line <= to));
    }).map(element => ({ element, label: kind === 'gutter' ? element.textContent!.trim() : `${element.dataset.sourceLine}:${element.textContent}` }));
    const read = () => witnesses.map(({ element, label }) => {
      const r = element.getBoundingClientRect();
      return { label, connected: element.isConnected, top: r.top, left: r.left, width: r.width, height: r.height };
    });
    scope.__complexInputFrames = []; scope.__presentationFrames = scope.__complexInputFrames;
    const generation = scope.__complexSamplingGeneration = (scope.__complexSamplingGeneration ?? 0) + 1;
    scope.__complexSampling = true;
    const current = () => scope.__complexSampling && scope.__complexSamplingGeneration === generation;
    const sample = () => { if (!current()) return;
      setTimeout(() => { if (current()) scope.__complexInputFrames.push(read()); }, 0); requestAnimationFrame(sample);
    }; requestAnimationFrame(sample);
    return read();
  }, { kind, beforeInputOnly });
}
async function assertObserved(page: Page, baseline: Awaited<ReturnType<typeof observe>>, label: string) {
  const tolerance = await page.evaluate(() => 0.5 / devicePixelRatio);
  const samples = await page.evaluate(() => { const scope = window as any; scope.__complexSampling = false; return scope.__complexInputFrames as typeof baseline[]; });
  assert.ok(baseline.length >= 3 && samples.length >= 5, `${label}: require visible witnesses and intermediate frames`);
  for (const frame of samples) for (const [index, value] of frame.entries()) {
    assert.equal(frame.length, baseline.length, `${label}: witness sampling changed`);
    assert.equal(value.connected, true, `${label}: unchanged reading DOM was replaced`);
    for (const key of ['top', 'left', 'width', 'height'] as const) {
      // DOM geometry is fractional; the compositor comparison separately
      // requires the actual unchanged glyphs and controls to retain their paint.
      assert.ok(Math.abs(value[key] - baseline[index]![key]) <= tolerance,
        `${label}: ${key} moved: ${JSON.stringify({ baseline: baseline[index], value })}`);
    }
  }
}
async function settledNumericInput(page: Page) {
  for (const key of ['1', '2', 'Backspace', 'Backspace']) {
    if (key.length === 1) await page.keyboard.type(key); else await page.keyboard.press(key);
    await delay(440); // Commit each actual Preview/worker revision, including deletion.
  }
}

let primary: unknown, stage = 'startup';
try {
  const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
  if (!only || only === 'notes') for (const large of [false, true]) for (const scale of [1, 1.25]) {
    stage = `Live notes, large ${large}, scale ${scale}`;
    const text = notes + (large ? padding : ''), page = await browser.newPage(), host = await open(page, text);
    try {
      await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: scale });
      await setMode(page, 'live'); await placeCaret(page, 'Note typing target.', false);
      const baseline = await observe(page, 'gutter');
      const clip = await page.$eval('.editor-host .cm-lineNumbers', element => {
        const r = element.getBoundingClientRect(); return { left: Math.ceil(r.left), top: 80, width: Math.floor(r.width), height: 730 };
      });
      await assertStablePaint(page, clip, () => settledNumericInput(page), stage);
      await assertObserved(page, baseline, stage);
      assert.equal(host.readHost(), text); assert.deepEqual(host.errors, []);
      await captureResult(page, `complex-live-notes-${large}-${scale}`);
    } finally { host.dispose(); await page.close(); }
  }
  if (!only || only === 'preview') for (const large of [false, true]) for (const sync of [false, true]) {
    stage = `Complex split Preview, large ${large}, sync ${sync}`;
    // A deep prefix exceeds CSSOM's fractional style.height serialization
    // precision, unlike a large document whose input is near its beginning.
    const text = (large ? 'Deep prefix paragraph.\n\n'.repeat(4500) : '') + source + (large ? padding : '');
    const page = await browser.newPage(), host = await open(page, text, true);
    try {
      await page.locator('.source-preview-button').click();
      await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('[data-source-line]'));
      await page.waitForFunction(() => {
        const host = document.querySelector<HTMLElement>('.preview-host');
        return host && !host.hidden && !host.inert && getComputedStyle(host).visibility !== 'hidden';
      });
      if (await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed') === 'true') !== sync) {
        await page.locator('.source-preview-scroll-sync-button').click();
      }
      await placeCaret(page, 'Typing target with reference');
      if (!sync) {
        await page.locator('[data-meo-align-viewport="preview"]').click();
        await page.evaluate(() => (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view.focus());
      }
      await delay(500); await frames(page, 8);
      const baseline = await observe(page, 'preview');
      const frameRect = await page.$eval('.preview-frame', element => ({ left: element.getBoundingClientRect().left, top: element.getBoundingClientRect().top }));
      const clips = baseline.filter(value => value.width > 8 && value.height > 8).map(value => ({
        left: Math.ceil(frameRect.left + value.left + 2), top: Math.ceil(frameRect.top + value.top + 2),
        width: Math.floor(value.width - 4), height: Math.floor(value.height - 4)
      }));
      await assertStablePaint(page, clips, () => settledNumericInput(page), stage);
      await assertObserved(page, baseline, stage);
      assert.equal(host.readHost(), text); assert.ok(host.renders.length >= 3, 'check actual edited Preview commits'); assert.deepEqual(host.errors, []);
      // New lines move later source coordinates and block indexes. Only the
      // reading content above the edit should stay put; later blocks reflow.
      const structural = await observe(page, 'preview', true);
      const structuralClips = structural.filter(value => value.width > 8 && value.height > 8).map(value => ({
        left: Math.ceil(frameRect.left + value.left + 2), top: Math.ceil(frameRect.top + value.top + 2),
        width: Math.floor(value.width - 4), height: Math.floor(value.height - 4)
      }));
      const position = await page.evaluate(() => (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view.state.selection.main.head as number);
      const pasted = '\n\nPasted paragraph with **formatting** and reference[^two].';
      const expected = text.slice(0, position) + pasted + text.slice(position);
      await assertStablePaint(page, structuralClips, async () => {
        assert.equal(await page.evaluate(pasted => {
          const data = new DataTransfer(); data.setData('text/plain', pasted);
          const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
          document.activeElement!.dispatchEvent(event); return event.defaultPrevented;
        }, pasted), true);
        await delay(500); assert.equal(host.readHost(), expected);
        for (const [key, value] of [['z', text], ['y', expected], ['z', text]]) {
          await page.keyboard.down('Control'); await page.keyboard.press(key!); await page.keyboard.up('Control');
          await delay(500); assert.equal(host.readHost(), value);
        }
      }, stage + ' multiline paste and history');
      await assertObserved(page, structural, stage + ' multiline paste and history');
      assert.deepEqual(host.errors, []);
      await captureResult(page, `complex-preview-${large}-${sync}`);
    } finally { host.dispose(); await page.close(); }
  }
  if (!only || only === 'table') for (const large of [false, true]) for (const row of [0, 1]) {
    stage = `Long table, large ${large}, row ${row}`;
    const text = ['# Long table', '', ...Array.from({ length: 80 }, (_, i) => `Prefix ${i}.`), '',
      '| A | B |', '| --- | --- |', ...Array.from({ length: 200 }, (_, i) => `| ${i} | unchanged ${i} |`), '',
      'After table.', '', ...Array.from({ length: 80 }, (_, i) => `Tail ${i}.`)].join('\n') + (large ? padding : '');
    const page = await browser.newPage(), host = await open(page, text);
    try {
      await setMode(page, 'live'); await placeCaret(page, '| A | B |');
      const selector = `textarea[data-table-row="${row}"][data-table-col="0"]`;
      await page.waitForSelector(selector);
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.evaluate(selector => {
          const input = document.querySelector<HTMLElement>(selector)!;
          document.querySelector('.editor-host .cm-scroller')!.scrollTop += input.getBoundingClientRect().top - 180;
        }, selector); await delay(200);
      }
      const point = await page.$eval(selector, element => { const r = element.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.mouse.click(point.x, point.y); await page.keyboard.press('End'); await frames(page, 8);
      const baseline = await page.evaluate(selector => {
        const scope = window as any, input = document.querySelector<HTMLTextAreaElement>(selector)!;
        scope.__tableInput = input; scope.__tableFrames = []; scope.__tableSampling = true;
        const read = () => ({ connected: input.isConnected, top: input.getBoundingClientRect().top,
          active: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, value: input.value });
        const sample = () => { if (!scope.__tableSampling) return;
          setTimeout(() => { if (scope.__tableSampling) scope.__tableFrames.push(read()); }, 0); requestAnimationFrame(sample);
        }; requestAnimationFrame(sample); return read();
      }, selector);
      await page.keyboard.type('1234567890'.repeat(10), { delay: 3 }); await delay(1100);
      const samples = await page.evaluate(() => { const scope = window as any; scope.__tableSampling = false; return scope.__tableFrames as typeof baseline[]; });
      for (const sample of samples) {
        assert.ok(sample.connected && sample.active, `${stage}: active cell was replaced or lost focus`);
        assert.ok(Math.abs(sample.top - baseline.top) <= 1, `${stage}: viewport left the active cell: ${JSON.stringify(sample)}`);
        assert.equal(sample.start, sample.end, `${stage}: numeric input changed the native selection`);
      }
      assert.ok(host.readHost().includes(baseline.value + '1234567890'.repeat(10)), `${stage}: native cell edits must reach the source`);
      assert.deepEqual(host.errors, []); await captureResult(page, `complex-long-table-${large}-${row}`);
    } finally { host.dispose(); await page.close(); }
  }
  if (!only || only === 'literal-enter') for (const large of [false, true]) for (const mode of ['source', 'live'] as const) {
    stage = `Rapid quoted code Enter ${mode}, large ${large}`;
    const text = '> ```ts\n> const value = {}\n> ```\n\nAfter' + (large ? '\n'.repeat(8000) : '');
    const at = text.indexOf('{}') + 1;
    const page = await browser.newPage();
    // Source accepts input before its first syntax reply. Hold actual requests,
    // including blob-backed workers, until the immediate input checks finish.
    if (large && mode === 'source') await page.evaluateOnNewDocument(() => {
      const NativeWorker = window.Worker;
      const pending: Array<() => void> = [];
      let released = false;
      (window as any).__heldMarkdownRequests = pending;
      (window as any).__releaseMarkdownRequests = () => {
        released = true;
        for (const send of pending.splice(0)) send();
      };
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          const send = this.postMessage.bind(this);
          this.postMessage = (message, transfer) => {
            if (!released && typeof message.blocks === 'boolean' && typeof message.tabSize === 'number') {
              pending.push(() => send(message, transfer as Transferable[]));
            } else send(message, transfer as Transferable[]);
          };
        }
      };
    });
    const host = await open(page, text, false, mode);
    try {
      await page.evaluate(at => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        view.dispatch({ selection: { anchor: at }, scrollIntoView: true }); view.focus();
      }, at);
      await frames(page, 4);
      if (large && mode === 'source') assert.ok(await page.evaluate(() => (window as any).__heldMarkdownRequests.length > 0),
        stage + ': the first input must precede the held syntax result');
      for (let key = 0; key < 3; key++) await page.keyboard.press('Enter');
      await delay(700);
      const expected = text.slice(0, at) + '\n> '.repeat(3) + text.slice(at);
      assert.ok(host.readHost() === expected, stage + ': retain the container during pending parses: '
        + JSON.stringify({ actual: host.readHost().slice(0, 90), expected: expected.slice(0, 90) }));
      // A different document must not inherit a previous block's continuation.
      await page.evaluate(() => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Plain' }, selection: { anchor: 5 } });
      });
      await page.keyboard.press('Enter'); await delay(300);
      assert.equal(host.readHost(), 'Plain\n', stage + ': discard obsolete continuation');
      if (large && mode === 'source') await page.evaluate(() => (window as any).__releaseMarkdownRequests());
      const closingEnd = text.indexOf('\n> ```') + '\n> ```'.length;
      await page.evaluate(({ text, closingEnd }) => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: closingEnd } });
      }, { text, closingEnd });
      await delay(700);
      for (let key = 0; key < 3; key++) { await page.keyboard.press('Enter'); await delay(400); }
      assert.ok(!host.readHost().slice(closingEnd).includes('> '), stage + ': closing fences must return to normal quote exit');
      assert.deepEqual(host.errors, []);
    } finally { host.dispose(); await page.close(); }
  }
  if (!only || only === 'mermaid') for (const large of [false, true]) {
    stage = `Unchanged Mermaid below heading input, large ${large}`;
    const distant = ('Unchanged paragraph with **formatting** and ordinary text. '.repeat(4) + '\n\n').repeat(2400);
    const block = '### Mermaid heading target\n\n```mermaid\nflowchart LR\nA[Original chart] --> B{Ready}\nB --> C[Keep this chart]\n```';
    const text = (large ? distant : '# Before\n\n') + block + '\n\nAfter.\n\n' + (large ? distant : '');
    if (large) assert.ok(Buffer.byteLength(text) > 1024 * 1024, 'Exercise a deep block in a one MiB document');
    const page = await browser.newPage(), host = await open(page, text, false, 'live');
    try {
      await placeCaret(page, 'Mermaid heading target', false);
      await page.evaluate(() => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        const caret = view.coordsAtPos(view.state.selection.main.head)!;
        view.scrollDOM.scrollTop += caret.top - view.scrollDOM.getBoundingClientRect().top - 100;
      });
      await page.waitForSelector('.meo-mermaid-block svg'); await delay(600); await frames(page, 8);
      const clip = await page.evaluate(() => {
        const scope = window as any, svg = document.querySelector('.meo-mermaid-block svg')!;
        const shell = svg.closest<HTMLElement>('.meo-rendered-block-preview')!;
        scope.__headingMermaid = { svg, shell, removed: 0, rendering: 0 };
        scope.__headingMermaidObserver = new MutationObserver(records => {
          for (const record of records) {
            for (const node of record.removedNodes) if (node === svg || node.contains(svg)) scope.__headingMermaid.removed++;
            if (record.type === 'attributes' && record.attributeName === 'data-meo-mermaid-rendering') scope.__headingMermaid.rendering++;
          }
        });
        scope.__headingMermaidObserver.observe(document.querySelector('.editor-host')!, { subtree: true, childList: true, attributes: true,
          attributeFilter: ['data-meo-mermaid-rendering'] });
        const rect = svg.getBoundingClientRect();
        if (rect.top < 150 || rect.bottom > innerHeight - 20) throw new Error('Chart must remain visible below its heading');
        return { left: Math.ceil(rect.left + 3), top: Math.ceil(rect.top + 3), width: Math.floor(rect.width - 6), height: Math.floor(rect.height - 6) };
      });
      const assertRetained = async (action: string) => {
        const result = await page.evaluate(() => {
          const { svg, shell, removed, rendering } = (window as any).__headingMermaid;
          const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
          const source = view.state.doc.toString(), start = source.indexOf('```mermaid'), end = source.indexOf('\n```', start) + 4;
          const toolbar = shell.querySelector('.meo-mermaid-toolbar')!;
          return { svg: svg.isConnected, shell: shell.isConnected, removed, rendering,
            from: Number(toolbar.dataset.meoBlockFrom) === start, to: Number(toolbar.dataset.meoBlockTo) === end,
            firstLine: Number(shell.dataset.meoRenderedBlockStartLine) === view.state.doc.lineAt(start).number,
            lastLine: Number(shell.dataset.meoRenderedBlockEndLine) === view.state.doc.lineAt(end).number };
        });
        assert.deepEqual(result, { svg: true, shell: true, removed: 0, rendering: 0, from: true, to: true, firstLine: true, lastLine: true }, stage + ': ' + action);
      };
      await assertStablePaint(page, clip, () => settledNumericInput(page), stage);
      await assertRetained('settled insertion and deletion');
      await assertStablePaint(page, clip, async () => {
        await page.keyboard.type('444444', { delay: 6 });
        for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
        await delay(650);
      }, stage + ' rapid input');
      await assertRetained('rapid input');
      // A real newline may move the chart, but must only rebase its source
      // metadata. History and toolbar actions must target the rebased fence.
      await page.keyboard.press('Enter'); await delay(500); await frames(page, 6);
      await assertRetained('line-number shift');
      await page.keyboard.press('Backspace'); await delay(500); await frames(page, 6);
      await assertRetained('line-number restoration');
      assert.equal(host.readHost(), text);
      await page.evaluate(() => (window as any).__headingMermaidObserver.disconnect());
      await page.$eval('.meo-mermaid-mode-btn', node => (node as HTMLElement).click());
      await page.waitForFunction(() => document.querySelector('.meo-mermaid-toolbar')?.getAttribute('data-meo-mermaid-mode') === 'edit');
      assert.equal(await page.evaluate(() => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        const from = view.state.doc.toString().indexOf('```mermaid'), to = view.state.doc.toString().indexOf('\n```', from) + 4;
        return view.state.selection.main.head >= from && view.state.selection.main.head <= to;
      }), true, stage + ': edit action follows the current fence');
      assert.deepEqual(host.errors, []); await captureResult(page, `complex-mermaid-heading-${large}`);
    } finally { host.dispose(); await page.close(); }
  }
  if (!only || only === 'tokens') for (const large of [false, true]) for (const language of ['markdown', 'typescript']) {
    stage = `Token inheritance ${language}, large ${large}`;
    const body = language === 'markdown' ? '### Nested heading 55555' : 'const value = 55555;';
    const text = `# Stable heading\n\n\`\`\`${language}\n${body}\n\`\`\`\n\n` + (large ? '\n'.repeat(8000) : 'After.');
    const page = await browser.newPage(), host = await open(page, text, false, 'live');
    try {
      await page.evaluate(() => {
        const scope = window as any;
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        scope.__tokenView = view;
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('55555') + 5 } });
        view.focus();
        scope.__readInputToken = () => {
          const { node } = view.domAtPos(view.state.selection.main.head - 1);
          const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement!;
          const style = getComputedStyle(element);
          return { color: style.color, weight: style.fontWeight };
        };
        scope.__hasPaintedInputToken = () => {
          const { node } = view.domAtPos(view.state.selection.main.head - 1);
          const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement!;
          const color = element.style.color;
          return !!color && !color.includes('var(');
        };
      });
      // The code fallback and content foreground can be different colors.
      // Capture the baseline only after a concrete Shiki token is painted.
      const baseline = await page.waitForFunction(() => {
        const scope = window as any;
        const token = scope.__readInputToken();
        return scope.__hasPaintedInputToken() && token.color !== getComputedStyle(scope.__tokenView.contentDOM).color ? token : false;
      });
      const before = await baseline.jsonValue();
      await baseline.dispose();
      for (let index = 0; index < 8; index++) {
        await page.keyboard.type('5'); await frames(page, 1);
        assert.deepEqual(await page.evaluate(() => (window as any).__readInputToken()), before, `${stage}: inherit the accepted token on every key`);
      }
      await delay(700);
      assert.ok(host.readHost().includes('55555' + '5'.repeat(8)), stage + ': preserve input source');
      assert.deepEqual(host.errors, []);
    } finally { host.dispose(); await page.close(); }
  }
  console.log(`Complex production input presentation passed (${observedPaints} compositor paints)`);
} catch (error) { primary = error; console.error('Complex input failed during:', stage); throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
