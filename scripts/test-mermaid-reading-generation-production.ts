import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const viewModes = ['live', 'preview', 'source'] as const;
const reportDirectory = '.local/test-artifacts/mermaid-reading-generation';
const sourceOnly = process.argv.includes('--source-only');
const requestedMode = process.argv.find(argument => argument.startsWith('--case-mode='))?.slice(12);
const selectedMode = viewModes.find(mode => mode === requestedMode);
if (requestedMode !== undefined && !selectedMode) throw new Error('Unknown Mermaid reading mode');
if (!selectedMode && !sourceOnly) {
  // Keep a previous view's test server and renderer allocations out of the
  // next view's cold admission measurement. Each child retains the full budget.
  const reports: unknown[] = [];
  for (const mode of viewModes) {
    const child = Bun.spawn([process.execPath, import.meta.path, `--case-mode=${mode}`], {
      stdin: 'inherit', stdout: 'inherit', stderr: 'inherit'
    });
    const code = await child.exited;
    if (code !== 0) process.exit(code);
    reports.push(...await Bun.file(`${reportDirectory}/latest-${mode}.json`).json());
  }
  fs.writeFileSync(`${reportDirectory}/latest.json`, JSON.stringify(reports, null, 2));
  console.log('Cold complex Mermaid: generation/display during native scrolling and ordinary/windowed documents passed');
  process.exit(0);
}

process.env.MEO_TEST_NATIVE_SMOOTH_SCROLLING = '1';
const { browser: initialBrowser, server, open } = await import('./input-presentation-test-helpers');
let browser: typeof initialBrowser | undefined = initialBrowser;

const graph = ['flowchart LR', ...Array.from({ length: 5 }, (_, lane) => [
  `subgraph lane${lane}[Processing lane ${lane}]`, 'direction LR',
  ...Array.from({ length: 8 }, (_, step) => `N${lane}_${step}[Stage ${lane}.${step} validation]${step < 7 ? ` --> N${lane}_${step + 1}` : ''}`), 'end'
].join('\n')), ...Array.from({ length: 4 }, (_, lane) => `N${lane}_3 --> N${lane + 1}_4`)].join('\n');
const graphs = [
  { shape: 'tall', source: ['flowchart TD', ...Array.from({ length: 16 }, (_, index) =>
    `N${index}[Processing stage ${index}]${index < 15 ? ` --> N${index + 1}` : ''}`)].join('\n') },
  { shape: 'wide', source: graph }
];
const opening = Array.from({ length: 24 }, (_, i) => `Reading ${i}. ${'A stable paragraph of reading text. '.repeat(6)}\n\n`).join('');
const reports: unknown[] = [];
const modes = [selectedMode ?? 'source'] as const;
const reportPath = `${reportDirectory}/latest${selectedMode ? '-' + selectedMode : ''}.json`;
let failure: unknown;
try {
  for (const { shape, source } of graphs) for (const mode of modes) for (const large of [false, true]) {
    // Measure each cold admission with a fresh renderer and worker process.
    // A new page can reuse the previous renderer while its workers retire.
    browser ??= await launchTestBrowser();
    const text = opening + `\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nAFTER_GRAPH stable reading witness.\n\n`
      + 'Distant paragraph.\n\n'.repeat(large ? 9_000 : 80);
    const page = await browser.newPage();
    // For tall graphs, hold the real engine entry until the reading box is visible.
    // A fast offscreen completion legitimately changes following geometry and
    // would otherwise miss the held-box transition this contract must exercise.
    const controlledEntry = shape === 'tall';
    let engineReleased = !controlledEntry, heldRequests = 0;
    let releaseEngine!: () => void;
    const engineGate = new Promise<void>(resolve => { releaseEngine = resolve; });
    const host = await open(page, text, false, mode, controlledEntry
      ? { beforeMermaidLoad: async () => { heldRequests++; await engineGate; } } : {});
    try {
      if (mode === 'source') {
        await page.click('.source-preview-button');
        await page.waitForFunction(() => {
          const host = document.querySelector<HTMLElement>('.preview-host');
          return document.querySelector('.editor-surface')?.hasAttribute('data-source-preview') && host && !host.hidden && !host.inert
            && getComputedStyle(host).visibility !== 'hidden'
            && !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc');
        });
      }
      const point = await page.evaluate(({ mode, position, after }) => {
        const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
        const doc = mode === 'live' ? document : frame.contentDocument!;
        const view = mode === 'live' ? (document.querySelector<any>('.editor-host .cm-content').cmTile.root.view) : null;
        const scroll = view?.scrollDOM ?? doc.scrollingElement!;
        const probe = { active: true, scrolling: true, samples: [] as any[], writes: [] as number[], wheels: 0,
          firstWheel: 0, tasks: [] as number[] };
        new PerformanceObserver(list => {
          if (probe.scrolling) for (const task of list.getEntries()) {
            if (probe.firstWheel > 0 && task.startTime >= probe.firstWheel) probe.tasks.push(task.duration);
          }
        }).observe({ entryTypes: ['longtask'] });
        (window as any).__mermaidReading = probe;
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
        Object.defineProperty(scroll, 'scrollTop', { configurable: true, get() { return descriptor.get!.call(this); },
          set(value) { if (probe.scrolling && probe.wheels > 0) probe.writes.push(value); descriptor.set!.call(this, value); } });
        doc.addEventListener('wheel', event => { if (event.isTrusted && !event.defaultPrevented) {
          probe.wheels++; probe.firstWheel ||= performance.now();
        } }, { passive: true });
        const sample = () => {
          if (!probe.active) return;
          const bounds = view?.scrollDOM.getBoundingClientRect();
          const height = bounds?.height ?? doc.defaultView!.innerHeight;
          const block = doc.querySelector(mode === 'live' ? '.meo-mermaid-block' : '.meo-export-mermaid');
          const box = block?.getBoundingClientRect();
          const top = mode === 'live' ? view.documentTop + view.lineBlockAt(position).top - bounds.top : box?.top;
          const blockHeight = mode === 'live' ? view.lineBlockAt(position).height : box?.height;
          const svg = doc.querySelector<SVGSVGElement>(mode === 'live' ? '.meo-mermaid-svg-wrapper svg' : '.meo-export-mermaid-svg svg');
          const projection = svg?.getScreenCTM();
          const viewportTop = bounds?.top ?? 0, viewportBottom = bounds?.bottom ?? height;
          const ready = !!svg && [...svg.querySelectorAll('.node')].some(node => {
            const rect = node.getBoundingClientRect();
            return rect.width > .5 && rect.height > .5 && rect.top < viewportBottom - 8 && rect.bottom > viewportTop + 8;
          });
          const witness = mode === 'live' ? view.documentTop + view.lineBlockAt(after).top + scroll.scrollTop
            : [...doc.querySelectorAll('p')].find(node => node.textContent?.includes('AFTER_GRAPH'))?.getBoundingClientRect().top! + scroll.scrollTop;
          probe.samples.push({ time: performance.now(), visible: top !== undefined && top < height - 8 && top + (blockHeight ?? 0) > 8,
            ready, top: scroll.scrollTop, witness, scrolling: probe.scrolling, boxHeight: box?.height,
            held: block?.classList.contains('meo-reading-size-held'), scaleX: projection?.a, scaleY: projection?.d,
            svgHeight: svg?.getBoundingClientRect().height,
            overflow: block ? doc.defaultView!.getComputedStyle(block).overflowY : undefined });
          requestAnimationFrame(sample);
        };
        sample();
        const bounds = mode === 'live' ? view.scrollDOM.getBoundingClientRect() : frame.getBoundingClientRect();
        return { x: bounds.left + bounds.width * .65, y: bounds.top + 180 };
      }, { mode, position: text.indexOf('```mermaid'), after: text.indexOf('AFTER_GRAPH') });
      await page.mouse.move(point.x, point.y);
      // Deliberately no idle/readiness wait before the first trusted wheel.
      // The browser can deliver fewer wheel events than dispatched. Keep the
      // observed-wheel minimum and bound additional attempts.
      for (let i = 0; i < 54; i++) {
        const packet = await page.evaluate(({ mode, position }) => {
          const wheels: number = (window as any).__mermaidReading.wheels;
          if (mode === 'live') {
            const view = document.querySelector<any>('.editor-host .cm-content').cmTile.root.view, bounds = view.scrollDOM.getBoundingClientRect();
            const top = view.documentTop + view.lineBlockAt(position).top - bounds.top;
            return { x: bounds.left + bounds.width * .65, y: bounds.top + 180,
              delta: top > bounds.height * .6 ? 140 : top < 100 ? -60 : 18, admitEngine: top < bounds.height - 32, wheels };
          }
          const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!, doc = frame.contentDocument!, bounds = frame.getBoundingClientRect();
          const top = doc.querySelector('.meo-export-mermaid')?.getBoundingClientRect().top ?? 1000;
          return { x: bounds.left + bounds.width * .65, y: bounds.top + 180,
            delta: top > doc.defaultView!.innerHeight * .6 ? 140 : top < 100 ? -60 : 18,
            admitEngine: top < doc.defaultView!.innerHeight - 32, wheels };
        }, { mode, position: text.indexOf('```mermaid') });
        if (i >= 50 && packet.wheels >= 48) break;
        if (packet.admitEngine && !engineReleased) {
          engineReleased = true;
          releaseEngine();
        }
        await page.mouse.move(packet.x, packet.y);
        await page.mouse.wheel({ deltaY: packet.delta });
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const result = await page.evaluate(() => {
        const probe = (window as any).__mermaidReading; probe.scrolling = false; return probe;
      });
      fs.mkdirSync('.local/test-artifacts/mermaid-reading-generation', { recursive: true });
      await page.screenshot({ path: `.local/test-artifacts/mermaid-reading-generation/${shape}-${mode}-${large}-motion.png` });
      await new Promise(resolve => setTimeout(resolve, 700));
      const settled = await page.evaluate(mode => {
        const probe = (window as any).__mermaidReading; probe.active = false;
        const doc = mode === 'live' ? document : document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
        const block = doc?.querySelector(mode === 'live' ? '.meo-mermaid-block' : '.meo-export-mermaid');
        const svg = block?.querySelector<SVGSVGElement>(mode === 'live' ? '.meo-mermaid-svg-wrapper svg' : '.meo-export-mermaid-svg svg');
        return { held: !!doc?.querySelector('.meo-reading-size-held'), samples: probe.samples,
          blockHeight: block?.getBoundingClientRect().height, svgHeight: svg?.getBoundingClientRect().height };
      }, mode);
      const visible = result.samples.filter((sample: any) => sample.scrolling && sample.visible);
      const ready = visible.filter((sample: any) => sample.ready);
      const firstVisible = visible[0]?.time, firstReady = ready[0]?.time;
      const delay = firstReady === undefined ? null : firstReady - firstVisible;
      const projections = settled.samples.filter((sample: any) => sample.scaleX > 0 && sample.scaleY > 0);
      const scaleRatio = (key: 'scaleX' | 'scaleY') => Math.max(...projections.map((sample: any) => sample[key]))
        / Math.min(...projections.map((sample: any) => sample[key]));
      const scaleChange = { x: scaleRatio('scaleX'), y: scaleRatio('scaleY') };
      const report = { shape, mode, large, wheels: result.wheels, visible: visible.length, ready: ready.length, delay, scaleChange,
        writes: result.writes, tasks: result.tasks, samples: settled.samples };
      reports.push(report);
      fs.mkdirSync('.local/test-artifacts/mermaid-reading-generation', { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2));
      console.log(JSON.stringify({ shape, mode, large, wheels: result.wheels, visible: visible.length, ready: ready.length, delay, scaleChange, writes: result.writes.length,
        maxLongTask: Math.max(0, ...result.tasks) }));
      assert.deepEqual(host.errors, []); assert.equal(host.readHost(), text);
      if (controlledEntry) assert.ok(engineReleased && heldRequests > 0, 'Load the real cold engine only after entering the reading viewport');
      assert.ok(result.wheels >= 48 && visible.length >= 8, 'Exercise continuous trusted scrolling through the real graph');
      assert.ok(ready.length >= 8 && delay !== null && delay <= 500, 'Cold graph must finish and display during motion, within 500ms of entry');
      assert.deepEqual(result.writes, [], 'Generation and display must not compensate scrollTop during native motion');
      const firstReadyIndex = result.samples.findIndex((sample: any) => sample.ready);
      if (firstReadyIndex > 0) {
        const before = result.samples[firstReadyIndex - 1], after = result.samples[firstReadyIndex];
        assert.ok(Math.abs(after.witness - before.witness) <= 2, 'Publishing the completed SVG must retain following reading geometry');
      }
      assert.equal(settled.held, false, 'The existing reading owner releases temporary geometry after motion');
      assert.ok(projections.length >= 8 && projections.some((sample: any) => !sample.held), 'Observe the actual diagram through geometry release');
      assert.ok(scaleChange.x <= 1.01 && scaleChange.y <= 1.01, 'The first diagram projection must retain its final scale through geometry release');
      if (shape === 'tall') {
        const held = projections.filter((sample: any) => sample.held);
        assert.ok(held.length >= 8, 'Exercise cold publication into the smaller reading box');
        assert.ok(held.some((sample: any) => sample.svgHeight > sample.boxHeight + 100 && sample.overflow === 'hidden'),
          'Keep the tall diagram at its final scale while its smaller reading box clips it');
        assert.ok(settled.blockHeight! >= settled.svgHeight!, 'The complete tall diagram is exposed after geometry release');
      }
      await page.screenshot({ path: `.local/test-artifacts/mermaid-reading-generation/${shape}-${mode}-${large}.png` });
    } finally { releaseEngine(); host.dispose(); await page.close(); }
    const completed = browser;
    browser = undefined;
    await closeTestBrowser(completed);
  }
  if (selectedMode === 'preview') {
    browser ??= await launchTestBrowser();
    const text = opening.repeat(5) + '\n```mermaid\nsequenceDiagram\nA->>B: DistantEngineResume\n```\n\n'
      + 'Distant paragraph.\n\n'.repeat(9_000);
    const page = await browser.newPage(), host = await open(page, text, false, 'preview');
    try {
      const point = await page.$eval('.preview-frame', frame => {
        const bounds = frame.getBoundingClientRect(); return { x: bounds.left + bounds.width * .65, y: bounds.top + 180 };
      });
      await page.mouse.move(point.x, point.y);
      for (let index = 0; index < 50; index++) {
        const delta = await page.evaluate(() => {
          const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!, block = doc.querySelector('.meo-export-mermaid');
          // The target is windowed out. Approach within half a viewport so the
          // reading window can mount it before another wheel passes it.
          if (!block) return Math.floor(doc.defaultView!.innerHeight * 0.44);
          const top = block.getBoundingClientRect().top;
          return top > doc.defaultView!.innerHeight * .6 ? 140 : top < 100 ? -60 : 18;
        });
        await page.mouse.wheel({ deltaY: delta });
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const before = await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!, block = doc.querySelector('.meo-export-mermaid');
        const bounds = block?.getBoundingClientRect();
        return { visible: !!bounds && bounds.top < doc.defaultView!.innerHeight && bounds.bottom > 0,
          rendered: !!block?.querySelector('.meo-export-mermaid-svg svg') };
      });
      assert.equal(before.visible, true, 'The unsupported cold engine must enter the actual viewport');
      assert.equal(before.rendered, false, 'An indivisible cold engine retains native gesture protection');
      await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
        ?.querySelector('.meo-export-mermaid-svg svg')?.textContent?.includes('DistantEngineResume'));
      assert.deepEqual(host.errors, []); assert.equal(host.readHost(), text);
      console.log('Indivisible engine: deferred during wheels and resumed by the reading owner after motion');
    } finally { host.dispose(); await page.close(); }
  }
  console.log(`${modes[0]} cold complex Mermaid reading passed`);
} catch (error) { failure = error; throw error; }
finally {
  server.stop(true);
  if (browser) {
    if (failure === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, failure);
  }
}
