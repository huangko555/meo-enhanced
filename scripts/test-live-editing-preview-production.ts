import assert from 'node:assert/strict';
import { browser, server, open, frames, captureResult } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';
import { assessLargeDocument } from '../src/foundation/largeDocument';

// Native input and the production Workers/renderers must make preview progress
// during typing, rather than waiting for the full-document quiet window.
type Kind = 'mermaid' | 'html' | 'math';
const cases: Array<{ kind: Kind; name: string; block: string; layout?: string; latex?: boolean }> = [
  ...['stacked', 'side-by-side'].map(layout => ({ kind: 'mermaid' as const, name: `mermaid/${layout}`, layout,
    block: '```mermaid\nflowchart LR\nA[Seed42] --> B[End]\n```' })),
  { kind: 'html', name: 'html', block: '<div id="editing-preview-probe">Seed42</div>' },
  { kind: 'math', name: 'math/dollars', block: '$$\nx=42\n$$' },
  { kind: 'math', name: 'math/latex', block: '\\[\nx=42\n\\]', latex: true },
  { kind: 'math', name: 'math/fence', block: '```math\nx=42\n```' }
];
try {
  for (const large of [false, true]) for (const test of cases) {
    const { kind, block } = test, label = `${test.name}/${large ? 'large' : 'ordinary'}`;
    const marker = kind === 'math' ? '42' : 'Seed42';
    const text = (large ? 'Reading paragraph.\n\n'.repeat(800) : '') + 'Before\n\n' + block + '\n\nAfter\n\n'
      + (large ? 'Background paragraph.\n\n'.repeat(1200)
        + ('## Rich tail\n\n| Name | Value |\n| --- | --- |\n| **A** | `value` |\n\n```ts\nconst value = 1;\n```\n\n$$\ny=2\n$$\n\n').repeat(8) : '');
    assert.equal(assessLargeDocument(text).boundedEditorWork, large, `${label}: fixture must select the production work budget`);
    const page = await browser.newPage(), host = await open(page, text, false, 'live', { latexDelimiters: test.latex });
    page.on('console', message => { if (message.type() === 'error') host.errors.push(message.text()); });
    try {
      if (large) {
        await page.evaluate(block => {
          const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
          view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.toString().indexOf(block), { y: 'start', yMargin: 80 }) });
        }, block);
        await frames(page, 12);
      }
      const reading = kind === 'mermaid' ? '.meo-mermaid-block svg' : kind === 'html' ? '#editing-preview-probe' : '.meo-md-math-fenced-display .katex';
      await page.waitForSelector(reading);
      await page.click(kind === 'mermaid' ? '.meo-mermaid-mode-btn' : reading);
      if (test.layout) {
        const side = await page.evaluate(() => !!document.querySelector('.meo-mermaid-inline-preview:not([hidden])'));
        if (side !== (test.layout === 'side-by-side')) await page.click('.meo-mermaid-editing-preview .meo-mermaid-layout-btn');
        await page.waitForFunction(side => !!document.querySelector('.meo-mermaid-inline-preview:not([hidden])') === side,
          {}, test.layout === 'side-by-side');
      }
      const selector = kind === 'mermaid' ? '.meo-mermaid-editing-preview .meo-mermaid-svg-wrapper'
        : kind === 'html' ? '.meo-md-html-live-result' : '.meo-math-live-result .katex-html';
      await page.waitForFunction(({ selector, marker }) => document.querySelector(selector)?.textContent?.includes(marker), {}, { selector, marker });
      await frames(page, 8);
      await page.evaluate(({ marker, selector }) => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(marker) + marker.length } });
        view.focus();
        const observation = (window as any).editingPreviewProbe = { accepted: marker, inputs: [] as any[], paints: [] as any[] };
        document.addEventListener('input', event => {
          const input = event as InputEvent;
          if (!(input.target as Element)?.closest('.cm-content') || !input.data) return;
          observation.accepted += input.data;
          observation.inputs.push({ value: observation.accepted, time: performance.now(), trusted: input.isTrusted });
        }, true);
        const observer = new MutationObserver(() => {
          const value = document.querySelector(selector)?.textContent?.match(new RegExp(marker + '[0-9]*'))?.[0];
          const input = observation.inputs.find((entry: any) => entry.value === value);
          if (!input || observation.paints.some((entry: any) => entry.value === value)) return;
          const record = { value, input: input.time, dom: performance.now(), frame: 0 };
          observation.paints.push(record);
          requestAnimationFrame(() => { record.frame = performance.now(); });
        });
        observer.observe(view.dom, { childList: true, subtree: true, characterData: true });
      }, { marker, selector });
      await page.keyboard.type('1');
      await page.waitForFunction(() => {
        const probe = (window as any).editingPreviewProbe;
        return probe.paints.some((entry: any) => entry.value === probe.accepted && entry.frame);
      }, { timeout: 5000 });
      await page.keyboard.type('234567892345', { delay: 60 });
      await page.waitForFunction(() => {
        const probe = (window as any).editingPreviewProbe;
        return probe.paints.some((entry: any) => entry.value === probe.accepted && entry.frame);
      }, { timeout: 5000 });
      const observation = await page.evaluate(() => (window as any).editingPreviewProbe);
      const duringInput = observation.paints.filter((entry: any) => entry.value !== marker + '1'
        && entry.frame > 0 && entry.frame < observation.inputs.at(-1).time).length;
      const singleMs = observation.paints[0].frame - observation.inputs[0].time;
      assert.ok(observation.inputs.length === 13 && observation.inputs.every((entry: any) => entry.trusted));
      assert.ok(host.readHost().includes(marker + '1234567892345'));
      assert.deepEqual(host.errors, []);
      assert.ok(duringInput >= 2, `${label}: preview must advance during native typing; observed ${duringInput} intermediate paints`);
      await captureResult(page, `editing-preview-${label}`);
      const composition = await page.createCDPSession(), committed = marker + '12345678923456';
      const expectedDocument = text.replace(marker, committed);
      try {
        await composition.send('Input.imeSetComposition', { text: '6', selectionStart: 1, selectionEnd: 1 });
        await frames(page, 8);
        const preedit = await page.evaluate(({ selector, committed }) => {
          const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
          return { composing: view.composing, accepted: view.state.doc.toString().includes(committed),
            rendered: document.querySelector(selector)?.textContent?.includes(committed) };
        }, { selector, committed });
        assert.ok(preedit.composing && preedit.accepted, `${label}: fixture must establish real native preedit`);
        assert.equal(preedit.rendered, false, `${label}: expensive preview work must wait for composition commit`);
        await composition.send('Input.insertText', { text: '6' });
        await page.waitForFunction(({ selector, committed }) => document.querySelector(selector)?.textContent?.includes(committed),
          { timeout: 5000 }, { selector, committed });
        assert.equal(await page.evaluate(() => (document.querySelector('.editor-host .cm-content') as any)
          .cmTile.root.view.state.doc.toString()), expectedDocument, `${label}: IME must commit exactly once`);
        assert.equal(host.readHost(), expectedDocument, `${label}: committed text must reach the document owner`);
        assert.deepEqual(host.errors, []);
      } finally { await composition.detach(); }
      console.log(`${label}: single ${Math.round(singleMs)}ms, ${duringInput} intermediate preview paints`);
    } finally { host.dispose(); await page.close(); }
  }
} finally { try { await closeTestBrowser(browser); } finally { server.stop(true); } }
