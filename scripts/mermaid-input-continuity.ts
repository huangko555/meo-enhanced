import { installPackagedMermaid } from './mermaid-runtime-test-helpers';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { Browser } from 'puppeteer-core';
import { assessLargeDocument } from '../src/foundation/largeDocument';

export async function checkLiveInputQuietDeadlines(browser: Browser, bundle: string): Promise<void> {
  const worker = await Bun.build({ entrypoints: ['webview/src/markdownParseWorker.ts'], target: 'browser', format: 'iife' });
  assert.ok(worker.success);
  for (const large of [true, false]) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1000, height: 800 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.evaluate(({ code, large }) => {
        // Syntax and rich-block replies are separate stages. Hold the latter
        // so this input test cannot accidentally rely on their arrival order
        // instead of the production Live admission used below.
        const delayBlocks = large ? 'const sendQuietFixtureMessage = self.postMessage.bind(self); self.postMessage = (message, ...rest) => { if (message?.kind === "blocks") setTimeout(() => sendQuietFixtureMessage(message, ...rest), 500); else sendQuietFixtureMessage(message, ...rest); };\n' : '';
        document.body.dataset.meoMarkdownWorkerSrc = URL.createObjectURL(new Blob([delayBlocks, code], { type: 'text/javascript' }));
      }, { code: await worker.outputs[0]!.text(), large });
      await page.addScriptTag({ content: bundle });
      await page.evaluate(large => {
        const w = window as any;
        w.quietSources = [];
        w.mermaid = { initialize() {}, async render(_id: string, source: string) {
          w.quietSources.push(source);
          return { svg: `<svg width="180" height="80" viewBox="0 0 180 80" data-quiet-source="${source}"><rect width="180" height="80"/></svg>` };
        } };
        w.quietEditor = w.MermaidEditingHarness.createEditor({ parent: document.getElementById('app'), initialMode: 'live',
          text: 'Before\n\n```mermaid\nflowchart LR\nA[Alpha] --> B[End]\n```\n\nAfter\n\n'
            + (large ? 'Background paragraph.\n\n'.repeat(2000) : '') });
      }, large);
      assert.equal(await page.evaluate(() => (window as any).quietEditor.prepareLiveSyntax(() => true)), true,
        'the isolated fixture must use the same Live syntax admission as production bootstrap');
      await page.waitForSelector('.meo-mermaid-block svg');
      await page.click('.meo-mermaid-mode-btn');
      await page.evaluate(() => (window as any).quietEditor.whenVisiblePresentationReady(3000));
      const result = await page.evaluate(async () => {
        const w = window as any, view = w.quietEditor.view;
        const timers: Array<{ at: number; delay: number }> = [], nativeTimer = window.setTimeout, nativeNow = performance.now.bind(performance);
        let clock = 1000;
        Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
        window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) => {
          timers.push({ at: clock, delay: delay ?? 0 }); return nativeTimer(callback, delay, ...args);
        }) as typeof window.setTimeout;
        try {
          const from = view.state.doc.toString().indexOf('Alpha');
          view.dispatch({ changes: { from, to: from + 5, insert: 'Beta' },
            selection: { anchor: from + 4 }, userEvent: 'input.type' });
          // Painted frames and the quiet timer share one accepted input deadline.
          clock += 80;
          for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
          return { delays: timers.filter(timer => timer.at === clock).map(timer => timer.delay),
            large: w.MermaidEditingHarness.usesLargeDocumentDerivedWorkBudget(view.state), text: view.state.doc.toString(),
            sources: w.quietSources as string[] };
        } finally { window.setTimeout = nativeTimer; Object.defineProperty(performance, 'now', { configurable: true, value: nativeNow }); }
      });
      assert.equal(result.large, large, 'the deadline fixture must use the production input budget');
      assert.ok(result.text.includes('A[Beta]'));
      if (large) {
        assert.ok(result.delays.includes(40) && !result.delays.includes(120),
          'large input must consume elapsed time instead of restarting its 120ms quiet window: ' + JSON.stringify(result.delays));
      } else assert.ok(result.delays.includes(0) && !result.delays.includes(80) && result.sources.some(source => source.includes('A[Beta]')),
        'accepted Mermaid source must not restart an expired input quiet window: ' + JSON.stringify(result.delays));
    } catch (error) {
      const diagnostic = await page.evaluate(() => {
        const scope = window as any, editor = scope.quietEditor, block = document.querySelector('.meo-mermaid-block');
        const rect = block?.getBoundingClientRect();
        return { visibility: document.visibilityState, focused: document.hasFocus(), fonts: document.fonts.status,
          lines: editor?.view.state.doc.lines, runtime: typeof scope.mermaid?.render, sources: scope.quietSources,
          blocks: document.querySelectorAll('.meo-mermaid-block').length, svg: block?.querySelectorAll('svg').length,
          block: block?.outerHTML.slice(0, 1800), rect: rect && { top: rect.top, bottom: rect.bottom, width: rect.width },
          editorHeight: editor?.view.scrollDOM.clientHeight };
      }).catch(diagnosticError => ({ unavailable: String(diagnosticError) }));
      console.error('Mermaid quiet-deadline fixture failure: ' + JSON.stringify({ large, diagnostic }));
      throw error;
    } finally { await page.evaluate(() => (window as any).quietEditor?.destroy()); await page.close(); }
  }
  console.log('Live input quiet deadlines passed: painted frames share the accepted input quiet window');
}

export async function checkMermaidEditingControlStability(browser: Browser, bundle: string): Promise<void> {
  const worker = await Bun.build({ entrypoints: ['webview/src/markdownParseWorker.ts'], target: 'browser', format: 'iife' });
  assert.ok(worker.success);
  for (const large of [true, false]) for (const layout of ['side-by-side', 'stacked']) {
    const page = await browser.newPage();
    const label = `${large ? 'optimized' : 'ordinary'}/${layout}`;
    try {
      await page.setViewport({ width: 1050, height: 750 });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: large ? 'reduce' : 'no-preference' }]);
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.evaluate(code => { document.body.dataset.meoMarkdownWorkerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); }, await worker.outputs[0]!.text());
      await page.addScriptTag({ content: bundle });
      await page.evaluate(({ large, layout }) => {
        const w = window as any;
        w.mermaid = { initialize() {}, async render(_id: string, source: string) {
          await new Promise(resolve => setTimeout(resolve, 20));
          if (source.includes('INVALID')) throw new Error('Invalid diagram');
          return { svg: `<svg width="240" height="90" viewBox="0 0 240 90" data-control-source="${source}"><rect width="240" height="90"/></svg>` };
        } };
        w.MermaidEditingHarness.applyBuiltInVisualBaseline(large ? 'dark' : 'light');
        w.controlsEditor = w.MermaidEditingHarness.createEditor({ parent: document.getElementById('app'), initialMode: 'live',
          uiLanguage: large ? 'zh-CN' : 'en', text: 'Before\n\n```mermaid\nflowchart LR\n'
            + (layout === 'side-by-side' ? Array.from({ length: 40 }, (_, i) => '%% comment ' + i + '\n').join('') : '')
            + 'A[Alpha' + (large && layout === 'side-by-side' ? '5'.repeat(120) : '')
            + '] --> B[End]\n```\n\nAfter\n\n' + (large ? 'Background paragraph.\n\n'.repeat(21000) : '') });
      }, { large, layout });
      assert.equal(await page.evaluate(() => (window as any).controlsEditor.prepareLiveSyntax(() => true)), true);
      await page.waitForSelector('.meo-mermaid-block svg');
      await page.click('.meo-mermaid-mode-btn');
      await page.evaluate(layout => {
        const w = window as any, view = w.controlsEditor.view, text = view.state.doc.toString();
        view.dispatch({ effects: w.MermaidEditingHarness.setMermaidLayoutEffect.of({ anchor: text.indexOf('```'), layout }),
          selection: { anchor: text.indexOf('Alpha') + 5 }, scrollIntoView: true }); view.focus();
      }, layout);
      await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight');
      await page.evaluate(() => (window as any).controlsEditor.whenVisiblePresentationReady(3000));
      await page.waitForFunction(() => !document.querySelector('[data-meo-mermaid-rendering="true"]'));
      assert.equal(await page.evaluate(() => (window as any).MermaidEditingHarness.usesLargeDocumentDerivedWorkBudget(
        (window as any).controlsEditor.view.state)), large, label + ': actual input budget');
      if (layout === 'side-by-side') await page.waitForSelector('.meo-block-sticky-header:not([hidden]) .meo-mermaid-layout-btn');
      await page.mouse.move(0, 0);
      await page.evaluate(() => {
        const w = window as any;
        const initial = new Map([...document.querySelectorAll('.meo-mermaid-layout-btn')].map(button =>
          [button, { icon: button.querySelector('svg'), text: button.textContent, label: button.getAttribute('aria-label') }]));
        w.controlsSamples = []; w.controlsSampling = true; w.imageGuardChecked = false; w.imageGuardIntact = false;
        const sample = () => {
          const layouts = [...document.querySelectorAll('.meo-mermaid-layout-btn')].map(button => {
            const rect = button.getBoundingClientRect();
            return { same: initial.get(button)?.icon === button.querySelector('svg') && initial.get(button)?.text === button.textContent
              && initial.get(button)?.label === button.getAttribute('aria-label'),
              visible: rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0
                && getComputedStyle(button).visibility !== 'hidden' };
          });
          const copies = [...document.querySelectorAll<HTMLElement>('.meo-mermaid-toolbar .meo-copy-image-btn')].map(button => {
            const disabled = button.getAttribute('aria-disabled');
            if (disabled === 'true' && !w.imageGuardChecked) {
              const icon = button.firstElementChild; button.click(); w.imageGuardChecked = true;
              w.imageGuardIntact = button.firstElementChild === icon && button.getAttribute('aria-busy') === 'false';
            }
            return { disabled, opacity: getComputedStyle(button).opacity,
              floating: !!button.closest('.meo-block-sticky-header'), connected: button.isConnected };
          });
          w.controlsSamples.push({ layouts, copies });
          if (w.controlsSampling) requestAnimationFrame(sample);
        }; requestAnimationFrame(sample);
      });
      await page.keyboard.type('1234', { delay: 160 });
      await page.waitForFunction(() => document.querySelector('svg[data-control-source*="Alpha1234"]')
        && !document.querySelector('[data-meo-mermaid-rendering="true"]'));
      const result = await page.evaluate(() => { const w = window as any; w.controlsSampling = false;
        return { samples: w.controlsSamples, imageGuardChecked: w.imageGuardChecked, imageGuardIntact: w.imageGuardIntact }; });
      const samples = result.samples;
      assert.ok(samples.length > 10 && samples.every((s: any) => s.layouts.some((b: any) => b.visible) && s.layouts.every((b: any) => b.same)),
        label + ': layout caption/icon/action must stay on the accepted layout during input');
      assert.ok(samples.some((s: any) => s.copies.some((b: any) => b.disabled === 'true')), label + ': transient copy guard was exercised');
      assert.ok(result.imageGuardChecked && result.imageGuardIntact, label + ': visually stable pending image copy must still reject activation');
      assert.ok(samples.every((s: any) => s.copies.every((b: any) => b.opacity === '1')),
        label + ': short render updates must not pulse image button opacity: ' + JSON.stringify(samples
          .map((s: any, frame: number) => ({ frame, copies: s.copies })).filter((s: any) => s.copies.some((b: any) => b.opacity !== '1')).slice(0, 8)));
      if (large) {
        const copiedWhilePending = await page.evaluate(async () => {
          const w = window as any, view = w.controlsEditor.view;
          w.copiedSources = [];
          Object.defineProperty(navigator, 'clipboard', { configurable: true,
            value: { writeText: async (text: string) => { w.copiedSources.push(text); } } });
          const from = view.state.doc.toString().indexOf('Alpha');
          view.dispatch({ changes: { from, insert: 'Pending' }, userEvent: 'input.type' });
          (document.querySelector('.meo-mermaid-toolbar .meo-copy-code-btn') as HTMLElement).click();
          await Promise.resolve(); return w.copiedSources;
        });
        assert.deepEqual(copiedWhilePending, [], label + ': pending source discovery must not overwrite the clipboard with empty text');
        await page.waitForFunction(() => document.querySelector('svg[data-control-source*="PendingAlpha1234"]')
          && !document.querySelector('[data-meo-mermaid-rendering="true"]'));
        await page.click('.meo-mermaid-toolbar .meo-copy-code-btn');
        assert.ok(await page.evaluate(() => (window as any).copiedSources.at(-1)?.includes('PendingAlpha1234')),
          label + ': settled copy uses the latest complete source');
      }
      await page.evaluate(() => { const view = (window as any).controlsEditor.view, from = view.state.doc.toString().indexOf('Alpha');
        view.dispatch({ changes: { from, to: from + 5, insert: 'INVALID' }, userEvent: 'input.type' }); });
      await page.waitForSelector('.meo-mermaid-error-badge');
      await page.waitForFunction(() => [...document.querySelectorAll('.meo-mermaid-toolbar .meo-copy-image-btn')].every(button =>
        button.getAttribute('aria-disabled') === 'true' && getComputedStyle(button).opacity === '0.4'));
    } finally { await page.evaluate(() => (window as any).controlsEditor?.destroy()); await page.close(); }
  }
  console.log('Mermaid editing controls stayed stable across ordinary/optimized input, both layouts and sticky headers');
}

export async function checkMermaidInputContinuity(browser: Browser, bundle: string): Promise<void> {
  const worker = await Bun.build({ entrypoints: ['webview/src/markdownParseWorker.ts'], target: 'browser', format: 'iife' });
  assert.ok(worker.success);
  await checkMermaidPreviewScheduling(browser, bundle, await worker.outputs[0].text());
  for (const large of [false, true]) for (const layout of ['stacked', 'side-by-side']) {
    const text = 'Before.\n\n```mermaid\nflowchart LR\nA[Alpha] --> B[Beta]\nB --> C[Gamma]\nC --> D[Delta]\n```\n\nAfter.\n\n'
      + (large ? 'Background paragraph for actual document optimization.\n\n'.repeat(21000) : '');
    assert.equal(assessLargeDocument(text).boundedEditorWork, large);
    const page = await browser.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.setViewport({ width: 1100, height: 1100 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.addStyleTag({ content: '.meo-mermaid-block svg .node rect{fill:#fc02dc!important}' });
      await page.evaluate(code => {
        document.body.dataset.meoMarkdownWorkerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const NativeWorker = Worker;
        (window as any).mermaidContinuityWorkers = 0;
        window.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            this.addEventListener('message', event => { if (event.data?.kind === 'blocks') (window as any).mermaidContinuityWorkers++; });
          }
        };
      }, await worker.outputs[0].text());
      await installPackagedMermaid(page);
      await page.evaluate(() => {
        const g = window as any, render = g.mermaid.render.bind(g.mermaid);
        g.continuityRenderRequests = [];
        g.continuityPreviewTimeline = [];
        document.addEventListener('input', event => g.continuityPreviewTimeline.push({ input: (event as InputEvent).data, time: performance.now() }), true);
        g.mermaid.render = (...args: unknown[]) => { g.continuityRenderRequests.push(args[1]);
          g.continuityPreviewTimeline.push({ source: args[1], time: performance.now() }); return render(...args); };
      });
      await page.addScriptTag({ content: bundle });
      await page.evaluate(text => {
        const g = window as any, api = g.MermaidEditingHarness;
        api.applyBuiltInVisualBaseline('light');
        g.continuityEditor = api.createEditor({ parent: document.getElementById('app'), text, initialMode: 'live' });
      }, text);
      assert.equal(await page.evaluate(() => (window as any).continuityEditor.prepareLiveSyntax(() => true)), true);
      await page.waitForSelector('.meo-mermaid-block svg');
      await page.evaluate(({ text, layout }) => {
        const g = window as any, view = g.continuityEditor.view, anchor = text.indexOf('```');
        g.MermaidEditingHarness.focusMermaidEditingOffset(view, anchor, 0);
        view.dispatch({ effects: g.MermaidEditingHarness.setMermaidLayoutEffect.of({ anchor, layout }), selection: { anchor: text.indexOf('Alpha') + 5 } });
        view.focus();
      }, { text, layout });
      await page.waitForFunction(large => (window as any).MermaidEditingHarness.usesLargeDocumentDerivedWorkBudget((window as any).continuityEditor.view.state) === large, {}, large);
      await page.evaluate(() => (window as any).continuityEditor.whenVisiblePresentationReady(3000));
      if (large) await page.waitForFunction(() => (window as any).mermaidContinuityWorkers > 0);
      await page.evaluate(() => {
        const g = window as any;
        g.continuitySamples = []; g.continuityIds = new WeakMap(); let nextId = 0, frame = 0;
        const probe = document.createElement('div'); probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none'; document.body.append(probe);
        g.continuityObserver = new ResizeObserver(() => setTimeout(() => {
          const svg = document.querySelector<SVGElement>('.meo-mermaid-editing-preview .meo-mermaid-block svg');
          if (!svg) { g.continuitySamples.push({ frame, missing: true }); return; }
          if (!g.continuityIds.has(svg)) g.continuityIds.set(svg, ++nextId);
          const box = svg.getBoundingClientRect();
          g.continuitySamples.push({ frame, id: g.continuityIds.get(svg), label: svg.querySelector('.nodeLabel')?.textContent, width: box.width, height: box.height });
        }, 0));
        g.continuityObserver.observe(probe);
        function tick() { probe.style.width = `${1 + frame++ % 2}px`; g.continuityFrame = requestAnimationFrame(tick); }
        g.continuityFrame = requestAnimationFrame(tick);
      });
      await page.waitForFunction(() => { const samples = (window as any).continuitySamples; return samples.length >= 3 && samples.slice(-3).every((sample: any) => !sample.missing && sample.label === 'Alpha'); });
      const client = await page.createCDPSession(), painted: Buffer[] = [];
      client.on('Page.screencastFrame', event => { painted.push(Buffer.from(event.data, 'base64')); void client.send('Page.screencastFrameAck', { sessionId: event.sessionId }); });
      await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      await page.keyboard.type('7');
      await page.waitForFunction(() => { const samples = (window as any).continuitySamples; return samples.slice(-6).length === 6 && samples.slice(-6).every((sample: any) => !sample.missing && sample.label === 'Alpha7'); });
      await client.send('Page.stopScreencast'); await client.detach();
      await page.evaluate(() => { (window as any).continuityRenderRequests = []; (window as any).continuityPreviewTimeline = []; });
      await page.keyboard.type('abc', { delay: large ? 80 : 15 });
      await page.waitForFunction(() => { const samples = (window as any).continuitySamples; return samples.slice(-6).length === 6 && samples.slice(-6).every((sample: any) => !sample.missing && sample.label === 'Alpha7abc'); });
      const burstRenders = await page.evaluate(() => (window as any).continuityRenderRequests.length);
      assert.ok(burstRenders <= 2, `${layout}/${large}: native input must retain bounded rendering work (${burstRenders}): ${JSON.stringify(await page.evaluate(() => (window as any).continuityPreviewTimeline))}`);
      const samples = await page.evaluate(() => {
        const g = window as any; cancelAnimationFrame(g.continuityFrame); g.continuityObserver.disconnect(); return g.continuitySamples;
      }) as { missing?: boolean; id: number; width: number; height: number }[];
      assert.ok(samples.every(sample => !sample.missing), `${layout}/${large}: accepted diagram disappeared: ${JSON.stringify(samples)}`);
      for (const id of new Set(samples.map(sample => sample.id))) {
        const group = samples.filter(sample => sample.id === id);
        assert.ok(Math.max(...group.map(sample => sample.width)) - Math.min(...group.map(sample => sample.width)) <= 0.5);
        assert.ok(Math.max(...group.map(sample => sample.height)) - Math.min(...group.map(sample => sample.height)) <= 0.5);
      }
      assert.ok(painted.length >= 3);
      for (const png of painted) {
        const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        let pixels = 0;
        for (let index = 0; index < data.length; index += info.channels) if (data[index] === 252 && data[index + 1] === 2 && data[index + 2] === 220) pixels++;
        assert.ok(pixels > 1000, `${layout}/${large}: painted diagram was cleared`);
      }
      assert.equal(await page.evaluate(() => (window as any).continuityEditor.getText()), text.replace('Alpha', 'Alpha7abc'));
      // A new selection and removal must retire the retained panel immediately.
      await page.evaluate(() => {
        const view = (window as any).continuityEditor.view;
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('After.') } });
      });
      await page.waitForFunction(() => !document.querySelector('.meo-mermaid-inline-preview'));
      await page.evaluate(() => {
        const g = window as any, view = g.continuityEditor.view, source = view.state.doc.toString(), from = source.indexOf('```'), to = source.indexOf('```', from + 3) + 3;
        g.MermaidEditingHarness.focusMermaidEditingOffset(view, from, 0);
        view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from }, userEvent: 'input.delete' });
      });
      await page.waitForFunction(() => !document.querySelector('.meo-mermaid-inline-preview, .meo-mermaid-block'));
      assert.deepEqual(errors, []);
      console.log(`Mermaid continuity ${large ? 'optimized' : 'ordinary'}/${layout}: ${painted.length} compositor frames, ${burstRenders} burst renders, real Worker, selection and removal passed`);
    } finally {
      await page.evaluate(() => (window as any).continuityEditor?.destroy()); await page.close();
    }
  }
}

/** The source is already accepted here; only presentation scheduling remains. */
async function checkMermaidPreviewScheduling(browser: Browser, bundle: string, worker: string): Promise<void> {
  const results: Array<{ large: boolean; nextTurn: boolean; burstNextTurn: boolean; startLine: string | undefined; calls: string[] }> = [];
    for (const large of [false, true]) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1000, height: 800 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.evaluate(code => { document.body.dataset.meoMarkdownWorkerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); }, worker);
      await page.addScriptTag({ content: bundle });
      await page.evaluate(large => {
        const g = window as any, api = g.MermaidEditingHarness;
        g.scheduleCalls = [];
        g.mermaid = { initialize() {}, async render(_id: string, source: string) {
          g.scheduleCalls.push(source);
          return { svg: `<svg width="180" height="80" viewBox="0 0 180 80" aria-roledescription="flowchart-v2" data-schedule-source="${source}"><rect width="180" height="80"/></svg>` };
        } };
        g.scheduleEditor = api.createEditor({ parent: document.getElementById('app'), initialMode: 'live',
          text: 'Before.\n\nAfter.\n\n' + (large ? 'Background paragraph for actual document optimization.\n\n'.repeat(21000) : '') });
      }, large);
      await page.waitForFunction(large => (window as any).MermaidEditingHarness.usesLargeDocumentDerivedWorkBudget((window as any).scheduleEditor.view.state) === large, {}, large);
      await page.evaluate(() => {
        const g = window as any, api = g.MermaidEditingHarness;
        g.scheduleViewport = api.getMermaidBlockViewport(g.scheduleEditor.view.state, 0);
        g.makeScheduleWidget = (source: string, line = 1) => new api.MermaidSourcePreviewWidget(0, source, line, line + 2, 0, 'en', g.scheduleViewport);
        g.scheduleWidget = g.makeScheduleWidget('AcceptedOld');
        g.scheduleRoot = g.scheduleWidget.toDOM(g.scheduleEditor.view);
        g.scheduleRoot.style.cssText = 'position:absolute;top:0;left:0;width:500px;height:220px';
        g.scheduleEditor.view.scrollDOM.append(g.scheduleRoot);
      });
      await page.waitForFunction(() => document.querySelector('svg[data-schedule-source="AcceptedOld"]'));
      await page.evaluate(() => (window as any).scheduleEditor.whenVisiblePresentationReady(3000));
      const result = await page.evaluate(async large => {
        const g = window as any, view = g.scheduleEditor.view;
        g.scheduleCalls = [];
        g.makeScheduleWidget('AcceptedNew').updateDOM(g.scheduleRoot, view);
        await new Promise(resolve => setTimeout(resolve, 0));
        const nextTurn = g.scheduleCalls.includes('AcceptedNew');
        // A no-op selection/decoration refresh must not flush an ordinary burst.
        g.makeScheduleWidget('BurstFirst').updateDOM(g.scheduleRoot, view);
        g.makeScheduleWidget('BurstLast').updateDOM(g.scheduleRoot, view);
        g.makeScheduleWidget('BurstLast', 2).updateDOM(g.scheduleRoot, view);
        await new Promise(resolve => setTimeout(resolve, 0));
        const burstNextTurn = g.scheduleCalls.includes('BurstLast');
        return { large, nextTurn, burstNextTurn };
      }, large);
      await page.waitForFunction(() => document.querySelector('svg[data-schedule-source="BurstLast"]') && !(window as any).scheduleRoot.dataset.meoMermaidRendering);
      const calls = await page.evaluate(() => (window as any).scheduleCalls) as string[];
      const startLine = await page.$eval('.meo-mermaid-block', node => (node as HTMLElement).dataset.meoRenderedBlockStartLine);
      results.push({ ...result, calls, startLine });
    } finally {
      await page.evaluate(() => {
        const g = window as any;
        g.scheduleWidget?.destroy(g.scheduleRoot); g.scheduleRoot?.remove(); g.scheduleEditor?.destroy();
      });
      await page.close();
    }
  }
  console.log('Mermaid accepted-source scheduling: ' + JSON.stringify(results));
  for (const result of results) {
    assert.equal(result.nextTurn, result.large, 'Accepted large-document source must not wait through a second typing debounce');
    assert.equal(result.burstNextTurn, result.large, 'No-op refresh must not bypass an ordinary pending source batch');
    assert.equal(result.startLine, '2', 'A pending presentation must use its latest mapped source coordinates');
    assert.ok(!result.calls.includes('BurstFirst') && result.calls.filter(source => source === 'BurstLast').length === 1);
  }
}
