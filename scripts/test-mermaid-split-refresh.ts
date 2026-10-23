import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';

// Exercise main-document source edits through the production editor. A held renderer
// makes the old-diagram/loading transition observable without timing a CPU.
const build = await Bun.build({
  entrypoints: ['scripts/test-mermaid-editing-entry.ts'], target: 'browser', format: 'iife'
});
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const result = await page.evaluate(async () => {
    const calls: string[] = [];
    let release: (() => void) | null = null;
    let heldSource = 'New';
    let theme = 0;
    (window as any).mermaid = {
      initialize() { theme += 1; },
      async render(_id: string, source: string) {
        calls.push(source);
        if (source.includes(heldSource)) await new Promise<void>(resolve => { release = resolve; });
        if (source.includes('INVALID')) throw new Error('incomplete diagram');
        return { svg: `<svg width="180" height="80" data-theme="${theme}" aria-roledescription="flowchart-v2" data-source="${encodeURIComponent(source)}"></svg>` };
      }
    };
    const waitFor = async (predicate: () => boolean) => {
      const deadline = performance.now() + 3000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error('Mermaid preview refresh did not settle');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const editor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app'),
      // Begin outside the fence so the button still exercises reading-to-edit entry.
      text: 'before\n\n```mermaid\ngraph TD\nA[Old] --> B[End]\n```\n\nafter',
      initialMode: 'live', onApplyChanges() {}
    });
    try {
      await waitFor(() => Boolean(document.querySelector('.meo-mermaid-svg-wrapper svg')));
      document.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn')!.click();
      await waitFor(() => Boolean(document.querySelector('.meo-mermaid-editing-preview .meo-mermaid-svg-wrapper > svg')));
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-preview')!;
      const inner = editor.view;
      const label = (text: string) => {
        const source = inner.state.doc.toString();
        const from = source.indexOf('A[') + 2;
        inner.dispatch({ changes: { from, to: source.indexOf(']', from), insert: text } });
      };
      const visibleSource = () => decodeURIComponent(block.querySelector('.meo-mermaid-svg-wrapper > svg')?.getAttribute('data-source') ?? '');
      const oldDiagram = block.querySelector('.meo-mermaid-block');
      const oldSvg = block.querySelector('.meo-mermaid-svg-wrapper > svg');
      const start = performance.now();
      const from = inner.state.doc.toString().indexOf('Old');
      inner.dispatch({ changes: { from, to: from + 3, insert: 'New' } });
      await waitFor(() => release !== null);
      const renderStartMs = Math.round(performance.now() - start);
      // The document preloader can start work before the split refresh's
      // debounce fires. Hold it across that refresh to catch DOM replacement.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 260 - (performance.now() - start))));
      const pending = {
        sameContainer: oldDiagram === block.querySelector('.meo-mermaid-block'),
        sameSvg: oldSvg === block.querySelector('.meo-mermaid-svg-wrapper > svg'),
        loading: Boolean(block.querySelector('.meo-mermaid-loading')),
        renderCalls: calls.length,
        renderStartMs
      };
      release!();
      await waitFor(() => block.querySelector('.meo-mermaid-svg-wrapper > svg')?.getAttribute('data-source')?.includes('New') ?? false);
      heldSource = 'never-held';
      const beforeBurst = calls.length;
      const burstStart = performance.now();
      for (const text of ['Burst1', 'Burst2', 'Burst3', 'Burst4']) {
        label(text);
        editor.refreshDecorations();
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      await waitFor(() => visibleSource().includes('Burst4'));
      const burst = { renderCalls: calls.length - beforeBurst, readyMs: Math.round(performance.now() - burstStart) };
      const stableSvg = block.querySelector('.meo-mermaid-svg-wrapper > svg');
      const beforeNoop = calls.length;
      for (let index = 0; index < 3; index += 1) editor.refreshDecorations();
      await new Promise(resolve => setTimeout(resolve, 260));
      const unchanged = { sameSvg: stableSvg === block.querySelector('.meo-mermaid-svg-wrapper > svg'), renderCalls: calls.length - beforeNoop };

      const beforeCached = calls.length;
      label('Old');
      await waitFor(() => visibleSource().includes('Old'));
      const cached = { renderCalls: calls.length - beforeCached, loading: Boolean(block.querySelector('.meo-mermaid-loading')) };

      heldSource = 'Slow';
      release = null;
      label('Slow');
      await waitFor(() => release !== null);
      const superseded: string[] = [];
      const observer = new MutationObserver(() => { superseded.push(visibleSource()); });
      observer.observe(block, { childList: true, subtree: true });
      label('Fast');
      await new Promise(resolve => setTimeout(resolve, 120));
      release!();
      await waitFor(() => visibleSource().includes('Fast'));
      observer.disconnect();

      label('INVALID');
      await waitFor(() => Boolean(block.querySelector('.meo-mermaid-error-badge')));
      const error = { visible: Boolean(block.querySelector('.meo-mermaid-error-badge')), source: visibleSource() };
      heldSource = 'Recovered';
      release = null;
      label('Recovered');
      await waitFor(() => release !== null);
      await new Promise(resolve => setTimeout(resolve, 120));
      const recoveryPending = { source: visibleSource(), loading: Boolean(block.querySelector('.meo-mermaid-loading')) };
      release!();
      await waitFor(() => visibleSource().includes('Recovered'));
      const recovered = { errors: block.querySelectorAll('.meo-mermaid-error-badge').length };

      heldSource = 'Recovered';
      release = null;
      const beforeTheme = block.querySelector('.meo-mermaid-svg-wrapper > svg');
      document.documentElement.style.setProperty('--meo-background', '#111111');
      document.documentElement.style.setProperty('--meo-foreground', '#eeeeee');
      (window as any).MermaidEditingHarness.refreshMermaidTheme();
      await waitFor(() => release !== null);
      const themePending = {
        sameContainer: oldDiagram === block.querySelector('.meo-mermaid-block'),
        sameSvg: beforeTheme === block.querySelector('.meo-mermaid-svg-wrapper > svg'),
        loading: Boolean(block.querySelector('.meo-mermaid-loading'))
      };
      release!();
      await waitFor(() => block.querySelector('.meo-mermaid-svg-wrapper > svg') !== beforeTheme);

      heldSource = 'Disposed';
      release = null;
      label('Disposed');
      await waitFor(() => release !== null);
      editor.setMode('source');
      release!();
      await new Promise(resolve => setTimeout(resolve, 150));
      const sourceMode = { previews: document.querySelectorAll('.meo-mermaid-editing-preview').length };
      return { pending, burst, unchanged, cached, superseded, error, recoveryPending, recovered, themePending, sourceMode };
    } finally { editor.destroy(); }
  });
  console.log(JSON.stringify(result));
  assert.equal(result.pending.sameContainer, true, 'Split edits must reuse the presentation container');
  assert.equal(result.pending.sameSvg, true, 'Keep the last diagram visible until its replacement is ready');
  assert.equal(result.pending.loading, false, 'Editing a rendered split diagram must not show a loading row');
  assert.equal(result.burst.renderCalls, 1, 'Continuous typing must render only the final source');
  assert.deepEqual(result.unchanged, { sameSvg: true, renderCalls: 0 }, 'Unchanged decoration refresh must not remount SVG');
  assert.deepEqual(result.cached, { renderCalls: 0, loading: false }, 'Returning to a rendered source must reuse its cached result');
  assert.ok(result.superseded.every(source => !source.includes('Slow')), 'A superseded render must never replace the last valid diagram');
  assert.equal(result.error.visible, true);
  assert.ok(result.error.source.includes('Fast'), 'Incomplete source must show an error while retaining the last valid diagram');
  assert.ok(result.recoveryPending.source.includes('Fast'));
  assert.equal(result.recoveryPending.loading, false, 'Recovering from incomplete input must not reintroduce a loading row');
  assert.equal(result.recovered.errors, 0);
  assert.deepEqual(result.themePending, { sameContainer: true, sameSvg: true, loading: false });
  assert.equal(result.sourceMode.previews, 0, 'Switching to source must dispose pending preview work');

  const priority = await page.evaluate(async () => {
    let backgroundCalls = 0;
    const order: string[] = [];
    let editStart = 0;
    (window as any).mermaid = {
      initialize() {},
      async render(_id: string, source: string) {
        if (source.includes('BACKGROUND')) {
          backgroundCalls += 1;
          if (backgroundCalls > 1) {
            order.push('background');
            await new Promise(resolve => setTimeout(resolve, 400));
          }
          // Failed/offscreen diagrams are not cached. Retrying them while
          // typing must not take the renderer ahead of the visible edit.
          throw new Error('invalid offscreen diagram');
        }
        if (source.includes('Foreground1')) order.push('edit');
        return { svg: `<svg width="180" height="80" data-source="${encodeURIComponent(source)}"></svg>` };
      }
    };
    const waitFor = async (predicate: () => boolean) => {
      const deadline = performance.now() + 3000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error('Mermaid foreground priority did not settle');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const editor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app'), initialMode: 'live', onApplyChanges() {},
      text: 'before\n\n```mermaid\ngraph TD\nA[Foreground] --> B[End]\n```\n\n'
        + 'Ordinary paragraph\n\n'.repeat(100) + '```mermaid\nBACKGROUND\n```'
    });
    try {
      await waitFor(() => Boolean(document.querySelector('.meo-mermaid-block svg')));
      document.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn')!.click();
      await waitFor(() => Boolean(document.querySelector('.meo-mermaid-editing-preview .meo-mermaid-svg-wrapper > svg')) && backgroundCalls > 0);
      const block = document.querySelector('.meo-mermaid-editing-preview') as any;
      const inner = editor.view;
      const from = inner.state.doc.toString().indexOf('Foreground') + 'Foreground'.length;
      editStart = performance.now();
      inner.dispatch({ changes: { from, insert: '1' } });
      await waitFor(() => block.querySelector('.meo-mermaid-svg-wrapper > svg')?.getAttribute('data-source')?.includes('Foreground1') ?? false);
      const readyMs = Math.round(performance.now() - editStart);
      await waitFor(() => backgroundCalls >= 2);
      return { order, readyMs };
    } finally { editor.destroy(); }
  });
  console.log(JSON.stringify({ foregroundPriority: priority }));
  assert.equal(priority.order[0], 'edit', 'Background retries must not start before the visible split edit');
  console.log('PASS Mermaid split refresh: old diagram, typing batch, cache, stale results, errors, theme, disposal');
} finally { await browser.close(); }
