import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import {
  createLargeDocumentFixtures,
  describeLargeDocumentFixture,
  type LargeDocumentFixture
} from './large-document-fixtures';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-large-document-benchmark-'));
const outputDir = path.join(repoRoot, '.local', 'plans', 'phase-i-baseline');
const viewport = { width: 1100, height: 720, deviceScaleFactor: 1 } as const;

type StableSample = {
  readonly editorTextLength: number;
  readonly mode: 'live' | 'source' | 'unknown';
  readonly scrollHeight: number;
  readonly visibleLines: number;
  readonly tables: number;
  readonly mermaid: number;
  readonly images: number;
  readonly math: number;
};

type BrowserMemory = {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
} | null;

type ResourceSample = {
  readonly detachedResizeTargets: number;
  readonly resizeObservers: number;
  readonly mutationObservers: number;
  readonly intersectionObservers: number;
  readonly pendingFrames: number;
  readonly pendingIdleCallbacks: number;
  readonly pendingTimeouts: number;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

async function preparePage(page: Page): Promise<void> {
  await page.setViewport(viewport);
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
  await page.addStyleTag({
    content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
  });
  await page.evaluate(() => {
    const active = {
      resize: new Set<object>(),
      mutation: new Set<object>(),
      intersection: new Set<object>(),
      frames: new Set<number>(),
      idle: new Set<number>(),
      timeouts: new Set<number>()
    };
    const idleWaiters = new Set<() => void>();
    const resourcesAreIdle = () => active.resize.size === 0
      && active.mutation.size === 0
      && active.intersection.size === 0
      && active.frames.size === 0
      && active.idle.size === 0
      && active.timeouts.size === 0;
    const settleIdleWaiters = () => {
      if (!resourcesAreIdle()) return;
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    };
    const NativeResizeObserver = window.ResizeObserver;
    const NativeMutationObserver = window.MutationObserver;
    const NativeIntersectionObserver = window.IntersectionObserver;
    const NativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const NativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    const NativeRequestIdleCallback = window.requestIdleCallback?.bind(window);
    const NativeCancelIdleCallback = window.cancelIdleCallback?.bind(window);
    const NativeSetTimeout = window.setTimeout.bind(window);
    const NativeClearTimeout = window.clearTimeout.bind(window);

    class TrackedResizeObserver extends NativeResizeObserver {
      readonly targets = new Set<Element>();
      override observe(target: Element, options?: ResizeObserverOptions): void {
        this.targets.add(target);
        active.resize.add(this);
        super.observe(target, options);
      }
      override unobserve(target: Element): void {
        super.unobserve(target);
        this.targets.delete(target);
        if (this.targets.size === 0) active.resize.delete(this);
        settleIdleWaiters();
      }
      override disconnect(): void {
        super.disconnect();
        this.targets.clear();
        active.resize.delete(this);
        settleIdleWaiters();
      }
    }
    class TrackedMutationObserver extends NativeMutationObserver {
      override observe(target: Node, options?: MutationObserverInit): void {
        active.mutation.add(this);
        super.observe(target, options);
      }
      override disconnect(): void {
        super.disconnect();
        active.mutation.delete(this);
        settleIdleWaiters();
      }
    }
    class TrackedIntersectionObserver extends NativeIntersectionObserver {
      readonly targets = new Set<Element>();
      override observe(target: Element): void {
        this.targets.add(target);
        active.intersection.add(this);
        super.observe(target);
      }
      override unobserve(target: Element): void {
        super.unobserve(target);
        this.targets.delete(target);
        if (this.targets.size === 0) active.intersection.delete(this);
        settleIdleWaiters();
      }
      override disconnect(): void {
        super.disconnect();
        this.targets.clear();
        active.intersection.delete(this);
        settleIdleWaiters();
      }
    }

    window.ResizeObserver = TrackedResizeObserver;
    window.MutationObserver = TrackedMutationObserver;
    window.IntersectionObserver = TrackedIntersectionObserver;
    window.requestAnimationFrame = (callback) => {
      const id = NativeRequestAnimationFrame((time) => {
        active.frames.delete(id);
        try {
          callback(time);
        } finally {
          settleIdleWaiters();
        }
      });
      active.frames.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      active.frames.delete(id);
      NativeCancelAnimationFrame(id);
      settleIdleWaiters();
    };
    if (NativeRequestIdleCallback && NativeCancelIdleCallback) {
      window.requestIdleCallback = (callback, options) => {
        const id = NativeRequestIdleCallback((deadline) => {
          active.idle.delete(id);
          try {
            callback(deadline);
          } finally {
            settleIdleWaiters();
          }
        }, options);
        active.idle.add(id);
        return id;
      };
      window.cancelIdleCallback = (id) => {
        active.idle.delete(id);
        NativeCancelIdleCallback(id);
        settleIdleWaiters();
      };
    }
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof callback !== 'function') return NativeSetTimeout(callback, delay, ...args);
      const id = NativeSetTimeout(() => {
        active.timeouts.delete(id);
        try {
          callback(...args);
        } finally {
          settleIdleWaiters();
        }
      }, delay);
      active.timeouts.add(id);
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (typeof id === 'number') active.timeouts.delete(id);
      NativeClearTimeout(id);
      settleIdleWaiters();
    }) as typeof window.clearTimeout;
    (window as any).__largeDocumentResourceProbe = {
      snapshot: (): ResourceSample => ({
        detachedResizeTargets: [...active.resize].reduce((count, observer) => count
          + [...(observer as TrackedResizeObserver).targets].filter(target => !target.isConnected).length, 0),
        resizeObservers: active.resize.size,
        mutationObservers: active.mutation.size,
        intersectionObservers: active.intersection.size,
        pendingFrames: active.frames.size,
        pendingIdleCallbacks: active.idle.size,
        pendingTimeouts: active.timeouts.size
      }),
      whenIdle: () => resourcesAreIdle()
        ? Promise.resolve()
        : new Promise<void>((resolve) => idleWaiters.add(resolve))
    };
  });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
}

async function readResources(page: Page): Promise<ResourceSample> {
  return page.evaluate(() => (window as any).__largeDocumentResourceProbe.snapshot());
}

function assertLiveResourceBound(
  kind: LargeDocumentFixture['kind'],
  sample: StableSample,
  resources: ResourceSample
): void {
  assert.equal(resources.detachedResizeTargets, 0, `${kind} retained detached ResizeObserver targets`);
  // Live owns three editor-wide observers. Each connected table owns height,
  // column-width, and sticky-header observers; Mermaid and math own one each.
  // Image widgets do not own ResizeObservers.
  const connectedResizeOwners = 3 + sample.tables * 3 + sample.mermaid + sample.math;
  assert.ok(
    resources.resizeObservers <= connectedResizeOwners,
    `${kind} allocated ResizeObservers outside the connected rich surface: ${JSON.stringify({ sample, resources })}`
  );
  assert.ok(
    resources.mutationObservers <= 2 + sample.mermaid * 2,
    `${kind} allocated MutationObservers outside the connected Mermaid surface`
  );
  assert.ok(resources.intersectionObservers <= 2, `${kind} duplicated viewport observers`);
  assert.ok(resources.pendingFrames <= 1, `${kind} retained unbounded frame work`);
  assert.ok(resources.pendingIdleCallbacks <= 1, `${kind} retained unbounded idle work`);
  assert.ok(
    resources.pendingTimeouts <= 4,
    `${kind} retained unbounded timeout work: ${resources.pendingTimeouts}`
  );
}

function assertSourceResourceBound(kind: LargeDocumentFixture['kind'], resources: ResourceSample): void {
  assert.ok(resources.resizeObservers <= 3, `${kind} Source duplicated ResizeObservers`);
  assert.ok(resources.mutationObservers <= 1, `${kind} Source duplicated MutationObservers`);
  assert.ok(resources.intersectionObservers <= 2, `${kind} Source duplicated viewport observers`);
  assert.ok(resources.pendingFrames <= 1, `${kind} Source retained unbounded frame work`);
  assert.ok(resources.pendingIdleCallbacks <= 1, `${kind} Source retained unbounded idle work`);
  assert.ok(resources.pendingTimeouts <= 4, `${kind} Source retained unbounded timeout work`);
}

async function observeStableEditor(page: Page, expectedMode: 'live' | 'source'): Promise<{
  readonly elapsedMs: number;
  readonly sample: StableSample;
}> {
  return page.evaluate(async (mode) => {
    const startedAt = performance.now();
    const sample = (): StableSample => {
      const editor = (window as any).__largeDocumentBenchmarkEditor;
      const root = document.querySelector<HTMLElement>('#app > .cm-editor');
      const scroller = root?.querySelector<HTMLElement>('.cm-scroller');
      return {
        editorTextLength: editor?.getText().length ?? -1,
        mode: root?.classList.contains('meo-mode-live')
          ? 'live'
          : root?.classList.contains('meo-mode-source') ? 'source' : 'unknown',
        scrollHeight: scroller?.scrollHeight ?? -1,
        visibleLines: root?.querySelectorAll('.cm-line').length ?? 0,
        tables: root?.querySelectorAll('.meo-md-html-table-shell').length ?? 0,
        mermaid: root?.querySelectorAll('.meo-mermaid-block, .meo-mermaid-editing-block').length ?? 0,
        images: root?.querySelectorAll('.meo-md-image, .meo-image-editing-block').length ?? 0,
        math: root?.querySelectorAll('.meo-md-math, .meo-latex-math-editing-block').length ?? 0
      };
    };
    let previous = '';
    let stableFrames = 0;
    let latest = sample();
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      latest = sample();
      const serialized = JSON.stringify(latest);
      stableFrames = latest.mode === mode && serialized === previous ? stableFrames + 1 : 0;
      if (stableFrames >= 2) return { elapsedMs: performance.now() - startedAt, sample: latest };
      previous = serialized;
    }
    throw new Error(`Editor did not become semantically stable in ${mode}: ${JSON.stringify(latest)}`);
  }, expectedMode);
}

async function readMemory(page: Page): Promise<BrowserMemory> {
  return page.evaluate(() => {
    const memory = (performance as Performance & { memory?: BrowserMemory }).memory;
    return memory && Number.isFinite(memory.usedJSHeapSize)
      ? {
          usedJSHeapSize: memory.usedJSHeapSize,
          totalJSHeapSize: memory.totalJSHeapSize,
          jsHeapSizeLimit: memory.jsHeapSizeLimit
        }
      : null;
  });
}

async function createEditor(page: Page, fixture: LargeDocumentFixture, mode: 'live' | 'source') {
  const synchronousMs = await page.evaluate(({ text, initialMode }) => {
    const harness = (window as any).LargeDocumentBenchmarkHarness;
    const startedAt = performance.now();
    (window as any).__largeDocumentBenchmarkEditor = harness.createEditor({
      parent: document.getElementById('app'),
      text,
      initialMode,
      onApplyChanges() {}
    });
    return performance.now() - startedAt;
  }, { text: fixture.text, initialMode: mode });
  const stable = await observeStableEditor(page, mode);
  return { synchronousMs, stableMs: stable.elapsedMs, sample: stable.sample };
}

async function destroyEditor(page: Page): Promise<{
  readonly connectedEditors: number;
  readonly resources: ResourceSample;
}> {
  const connectedEditors = await page.evaluate(async () => {
    (window as any).__largeDocumentBenchmarkEditor?.destroy();
    (window as any).__largeDocumentBenchmarkEditor = null;
    document.getElementById('app')?.replaceChildren();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return document.querySelectorAll('#app .cm-editor').length;
  });
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      page.evaluate(() => (window as any).__largeDocumentResourceProbe.whenIdle()),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Browser resources did not settle after editor destroy')),
          page.getDefaultTimeout()
        );
      })
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
  return { connectedEditors, resources: await readResources(page) };
}

async function measureInput(page: Page, marker: string): Promise<number> {
  await page.evaluate(() => {
    const editor = (window as any).__largeDocumentBenchmarkEditor;
    const end = editor.getText().length;
    editor.revealSelection(end, end, { focusEditor: true, align: 'nearest' });
  });
  await page.waitForFunction(() => document.activeElement?.closest('.cm-editor') !== null);
  await page.evaluate((expectedMarker) => {
    const content = document.querySelector<HTMLElement>('#app .cm-content');
    if (!content) {
      throw new Error('Benchmark content is not connected');
    }
    (window as any).__largeDocumentInputReceipt = new Promise<number>((resolve, reject) => {
      content.addEventListener('beforeinput', () => {
        const startedAt = performance.now();
        let previousText = '';
        let stableFrames = 0;
        const observe = () => requestAnimationFrame(() => {
          const editor = (window as any).__largeDocumentBenchmarkEditor;
          const currentText = editor.getText();
          const visible = content.textContent?.includes(expectedMarker) === true;
          stableFrames = visible && currentText.endsWith(expectedMarker) && currentText === previousText
            ? stableFrames + 1
            : 0;
          if (stableFrames >= 2) {
            resolve(performance.now() - startedAt);
            return;
          }
          previousText = currentText;
          if (performance.now() - startedAt > 5_000) {
            reject(new Error(`Input was not visibly painted: ${expectedMarker}`));
            return;
          }
          observe();
        });
        observe();
      }, { capture: true, once: true });
    });
  }, marker);
  await page.keyboard.type(marker);
  return page.evaluate(() => (window as any).__largeDocumentInputReceipt);
}

async function measureScroll(page: Page, line: number): Promise<{
  readonly line: number;
  readonly elapsedMs: number;
  readonly sample: StableSample;
  readonly resources: ResourceSample;
}> {
  const startedAt = await page.evaluate(() => performance.now());
  await page.evaluate((targetLine) => {
    (window as any).__largeDocumentBenchmarkEditor.scrollToLine(targetLine, 'top');
  }, line);
  const stable = await observeStableEditor(page, 'live');
  const elapsedMs = await page.evaluate((started) => performance.now() - started, startedAt);
  return { line, elapsedMs, sample: stable.sample, resources: await readResources(page) };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const selected = args.length === 2 && args[0] === '--fixture' ? args[1] : undefined;
  if (args.length && !selected) throw new Error('Usage: benchmark-large-document-production.ts [--fixture <kind>]');
  const fixtures = createLargeDocumentFixtures().filter(fixture => !selected || fixture.kind === selected);
  if (!fixtures.length) throw new Error(`Unknown fixture: ${selected}`);
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'benchmark-large-document-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const browserVersion = await browser.version();
    const results = [];
    for (const fixture of fixtures) {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      try {
        await preparePage(page);
        console.log(`[benchmark] ${fixture.kind} initial Live`);
        const initialLive = await createEditor(page, fixture, 'live');
        const initialLiveMemory = await readMemory(page);
        const initialLiveResources = await readResources(page);
        assertLiveResourceBound(fixture.kind, initialLive.sample, initialLiveResources);
        const liveDestroy = await destroyEditor(page);
        assert.equal(liveDestroy.connectedEditors, 0);
        assert.deepEqual(liveDestroy.resources, {
          detachedResizeTargets: 0,
          resizeObservers: 0,
          mutationObservers: 0,
          intersectionObservers: 0,
          pendingFrames: 0,
          pendingIdleCallbacks: 0,
          pendingTimeouts: 0
        }, `${fixture.kind} Live destroy leaked browser resources`);

        console.log(`[benchmark] ${fixture.kind} initial Source`);
        const initialSource = await createEditor(page, fixture, 'source');
        const sourceMemory = await readMemory(page);
        const initialSourceResources = await readResources(page);
        assertSourceResourceBound(fixture.kind, initialSourceResources);
        const sourceToLiveStartedAt = await page.evaluate(() => performance.now());
        await page.evaluate(() => (window as any).__largeDocumentBenchmarkEditor.setMode('live'));
        await observeStableEditor(page, 'live');
        const sourceToLiveMs = await page.evaluate(
          (startedAt) => performance.now() - startedAt,
          sourceToLiveStartedAt
        );

        console.log(`[benchmark] ${fixture.kind} scroll`);
        const dimensions = describeLargeDocumentFixture(fixture.text);
        const scroll = [];
        for (const line of [
          Math.max(1, Math.floor(dimensions.lines / 4)),
          Math.max(1, Math.floor(dimensions.lines / 2)),
          dimensions.lines
        ]) {
          scroll.push(await measureScroll(page, line));
        }
        for (const observation of scroll) {
          assertLiveResourceBound(fixture.kind, observation.sample, observation.resources);
        }

        console.log(`[benchmark] ${fixture.kind} input`);
        const inputSamples: number[] = [];
        for (const marker of ['x', 'y', 'z']) {
          inputSamples.push(await measureInput(page, marker));
        }
        const inputSample = (await observeStableEditor(page, 'live')).sample;
        const inputResources = await readResources(page);
        assertLiveResourceBound(fixture.kind, inputSample, inputResources);

        console.log(`[benchmark] ${fixture.kind} return Source`);
        const liveToSourceStartedAt = await page.evaluate(() => performance.now());
        await page.evaluate(() => (window as any).__largeDocumentBenchmarkEditor.setMode('source'));
        await observeStableEditor(page, 'source');
        const liveToSourceMs = await page.evaluate(
          (startedAt) => performance.now() - startedAt,
          liveToSourceStartedAt
        );
        const finalState = await page.evaluate(() => {
          const editor = (window as any).__largeDocumentBenchmarkEditor;
          const selection = window.getSelection();
          const content = document.querySelector<HTMLElement>('#app .cm-content');
          return {
            textSuffix: editor.getText().slice(-6),
            focused: editor.hasFocus(),
            selectionCollapsed: selection?.isCollapsed ?? false,
            selectionInsideContent: Boolean(
              selection?.anchorNode && content?.contains(selection.anchorNode)
            ),
            history: editor.getHistoryDepth()
          };
        });
        const finalDestroy = await destroyEditor(page);
        assert.equal(finalDestroy.connectedEditors, 0);
        assert.deepEqual(finalDestroy.resources, {
          detachedResizeTargets: 0,
          resizeObservers: 0,
          mutationObservers: 0,
          intersectionObservers: 0,
          pendingFrames: 0,
          pendingIdleCallbacks: 0,
          pendingTimeouts: 0
        }, `${fixture.kind} final destroy leaked browser resources`);
        assert.deepEqual(pageErrors, [], `${fixture.kind} emitted browser page errors`);
        assert.equal(finalState.textSuffix.endsWith('xyz'), true);
        assert.equal(finalState.selectionCollapsed, true);
        assert.equal(finalState.selectionInsideContent, true);

        results.push({
          kind: fixture.kind,
          sha256: createHash('sha256').update(fixture.text).digest('hex'),
          dimensions,
          initialLive,
          initialLiveMemory,
          initialLiveResources,
          initialSource,
          sourceMemory,
          initialSourceResources,
          sourceToLiveMs,
          scroll,
          inputToPaintMs: {
            samples: inputSamples,
            median: median(inputSamples)
          },
          inputResources,
          liveToSourceMs,
          finalState
        });
        console.log(`[benchmark] ${fixture.kind} complete`);
      } finally {
        await page.close();
      }
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const reportPath = path.join(outputDir, `large-document-${Date.now()}.json`);
    const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.toString().trim();
    fs.writeFileSync(reportPath, `${JSON.stringify({
      schemaVersion: 2,
      head,
      createdAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        arch: process.arch,
        logicalCpuCount: os.cpus().length,
        bunVersion: Bun.version,
        browserVersion,
        viewport
      },
      results
    }, null, 2)}\n`);
    console.log(JSON.stringify({ reportPath, fixtureCount: results.length }));
  } finally {
    await browser.close();
  }
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
