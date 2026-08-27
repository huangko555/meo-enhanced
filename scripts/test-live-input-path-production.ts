import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-live-input-path-'));

type FrameSample = {
  text: string;
  domText: string;
  applyCount: number;
  selectionText: string;
  tableCount: number;
  caretVisible: boolean;
  derivedAdditions: number;
  tableProjectionEvents: number;
  searchEvents: number;
  gitOverviewRenders: number;
  searchOverviewRenders: number;
  derivedMutationKinds: string[];
};

async function waitForFrames(page: import('puppeteer-core').Page, count: number): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function armFirstFrame(
  page: import('puppeteer-core').Page,
  eventName: 'beforeinput' | 'paste' | 'compositionend',
  settleDelayMs = 0
): Promise<void> {
  await page.evaluate(({ inputEventName, delayMs }) => {
    const content = document.querySelector<HTMLElement>('.cm-content');
    if (!content) throw new Error('CodeMirror content was not mounted');
    const editorRoot = content.closest<HTMLElement>('.cm-editor');
    if (!editorRoot) throw new Error('CodeMirror root was not mounted');
    (window as any).__liveInputFirstFrame = new Promise<FrameSample>((resolve) => {
      content.addEventListener(inputEventName, () => {
        let derivedAdditions = 0;
        let tableProjectionEvents = 0;
        let searchEvents = 0;
        let gitOverviewRenders = 0;
        let searchOverviewRenders = 0;
        const derivedMutationKinds: string[] = [];
        const textContentDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
        if (!textContentDescriptor?.get || !textContentDescriptor.set) {
          throw new Error('Node.textContent is not observable');
        }
        Object.defineProperty(Node.prototype, 'textContent', {
          ...textContentDescriptor,
          set(value: string | null) {
            if (this instanceof HTMLElement) {
              if (this.classList.contains('meo-git-overview-ruler')) gitOverviewRenders += 1;
              if (this.classList.contains('meo-search-overview-ruler')) searchOverviewRenders += 1;
            }
            textContentDescriptor.set!.call(this, value);
          }
        });
        const derivedSelector = '.meo-md-marker, .meo-md-html-table-shell, .meo-md-list-marker, .meo-md-long-code-placeholder, .meo-md-long-code-footer';
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!(node instanceof Element)) continue;
              if (node.matches(derivedSelector)) {
                derivedAdditions += 1;
                derivedMutationKinds.push(node.className);
              }
              const descendants = node.querySelectorAll<HTMLElement>(derivedSelector);
              derivedAdditions += descendants.length;
              derivedMutationKinds.push(...Array.from(descendants, (element) => element.className));
            }
          }
        });
        const onProjection = () => { tableProjectionEvents += 1; };
        const onSearch = () => { searchEvents += 1; };
        observer.observe(content, { childList: true, subtree: true });
        editorRoot.addEventListener('meo-table-column-width-projected', onProjection, { capture: true });
        editorRoot.addEventListener('meo-search-state-change', onSearch, { capture: true });
        const snapshot = (): FrameSample => {
          const editor = (window as any).__liveInputEditor;
          const selection = document.getSelection();
          const caret = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
          const viewport = content.closest<HTMLElement>('.cm-scroller')?.getBoundingClientRect() ?? null;
          return {
            text: editor.getText(),
            domText: content.textContent ?? '',
            applyCount: (window as any).__liveInputApplies.length,
            selectionText: selection?.toString() ?? '',
            tableCount: document.querySelectorAll('#primary .meo-md-html-table-shell').length,
            caretVisible: Boolean(caret && viewport && caret.bottom >= viewport.top && caret.top <= viewport.bottom),
            derivedAdditions,
            tableProjectionEvents,
            searchEvents,
            gitOverviewRenders,
            searchOverviewRenders,
            derivedMutationKinds: [...derivedMutationKinds]
          };
        };
        (window as any).__liveInputSettledFrame = new Promise<FrameSample>((resolveSettled) => {
          requestAnimationFrame(() => {
            setTimeout(() => resolve(snapshot()), 0);
            let remainingFrames = 3;
            const settleAfterPaint = () => requestAnimationFrame(() => {
              remainingFrames -= 1;
              if (remainingFrames > 0) {
                settleAfterPaint();
                return;
              }
              setTimeout(() => {
                const sample = snapshot();
                observer.disconnect();
                Object.defineProperty(Node.prototype, 'textContent', textContentDescriptor);
                editorRoot.removeEventListener('meo-table-column-width-projected', onProjection, { capture: true });
                editorRoot.removeEventListener('meo-search-state-change', onSearch, { capture: true });
                resolveSettled(sample);
              }, 0);
            });
            if (delayMs > 0) {
              setTimeout(settleAfterPaint, delayMs);
            } else {
              settleAfterPaint();
            }
          });
        });
      }, { capture: true, once: true });
    });
  }, { inputEventName: eventName, delayMs: settleDelayMs });
}

async function readFirstFrame(page: import('puppeteer-core').Page): Promise<FrameSample> {
  return page.evaluate(() => (window as any).__liveInputFirstFrame);
}

async function readSettledFrame(page: import('puppeteer-core').Page): Promise<FrameSample> {
  return page.evaluate(() => (window as any).__liveInputSettledFrame);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-input-cursor-navigation-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 640, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html>
      <style>html,body,#app{height:100%;margin:0}#app{display:flex}.editor{min-width:0;flex:1}</style>
      <div id="app"><div id="primary" class="editor"></div><div id="secondary" class="editor"></div></div>`);
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const longCode = Array.from({ length: 19 }, (_, index) => `const liveLine${index + 1} = ${index + 1};`);
    const coreOriginal = 'plain line\n**marked text**\n\n| A | B |\n| --- | --- |\n| cell | value |\nlast line';
    const original = [
      'plain line',
      '**marked text**',
      '',
      '| A | B |',
      '| --- | --- |',
      '| cell | value |',
      '',
      '<details open>',
      '<summary>Details</summary>',
      'Body',
      '</details>',
      '',
      '```js',
      ...longCode,
      '```',
      'last line'
    ].join('\n');
    await page.evaluate((text) => {
      const create = (window as any).__createInputCursorEditor;
      (window as any).__liveInputApplies = [];
      (window as any).__secondaryApplies = [];
      (window as any).__liveInputEditor = create({
        parent: document.getElementById('primary'),
        text,
        initialMode: 'live',
        onApplyChanges(nextText: string) {
          (window as any).__liveInputApplies.push(nextText);
        }
      });
      (window as any).__secondaryEditor = create({
        parent: document.getElementById('secondary'),
        text: 'second editor',
        initialMode: 'live',
        onApplyChanges(nextText: string) {
          (window as any).__secondaryApplies.push(nextText);
        }
      });
    }, original);
    await waitForFrames(page, 6);

    const busyIdleDeadlineFacts = await page.evaluate(async () => {
      const nativeRequestIdleCallback = window.requestIdleCallback;
      const nativeCancelIdleCallback = window.cancelIdleCallback;
      const active = new Set<number>();
      let nextIdleId = 1;
      let requestedDeadline: number | undefined;
      window.requestIdleCallback = ((callback: IdleRequestCallback, options?: IdleRequestOptions) => {
        const id = nextIdleId++;
        active.add(id);
        requestedDeadline = options?.timeout;
        queueMicrotask(() => {
          if (!active.delete(id)) return;
          callback({ didTimeout: true, timeRemaining: () => 0 });
        });
        return id;
      }) as typeof window.requestIdleCallback;
      window.cancelIdleCallback = ((id: number) => { active.delete(id); }) as typeof window.cancelIdleCallback;

      const host = document.createElement('div');
      document.body.append(host);
      const editor = (window as any).__createInputCursorEditor({
        parent: host,
        text: Array.from({ length: 8_001 }, (_, index) => `busy-line-${index}`).join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      try {
        editor.setSearchQuery('deadline-needle');
        const observed = new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => {
            if (!host.querySelector('.meo-search-match')) return;
            observer.disconnect();
            resolve();
          });
          observer.observe(host, { childList: true, subtree: true });
        });
        (window as any).__dispatchProductionInput(editor, 0, 'deadline-needle ');
        await observed;
        return {
          requestedDeadline,
          textCommitted: editor.getText().startsWith('deadline-needle '),
          publicMatch: host.querySelector('.meo-search-match')?.textContent ?? ''
        };
      } finally {
        editor.destroy();
        host.remove();
        window.requestIdleCallback = nativeRequestIdleCallback;
        window.cancelIdleCallback = nativeCancelIdleCallback;
      }
    });
    if (
      !busyIdleDeadlineFacts.textCommitted
      || busyIdleDeadlineFacts.publicMatch !== 'deadline-needle'
      || typeof busyIdleDeadlineFacts.requestedDeadline !== 'number'
      || !Number.isFinite(busyIdleDeadlineFacts.requestedDeadline)
      || busyIdleDeadlineFacts.requestedDeadline <= 0
    ) {
      throw new Error(`Busy large-document derived work missed its public deadline: ${JSON.stringify(busyIdleDeadlineFacts)}`);
    }

    const failedGenerationConsumerFacts = await page.evaluate(async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const probe = (window as any).__createLiveInputConsumerProbe(host);
      const staleTableKey = {};
      const currentKey = {};
      const facts = { stale: 0, current: 0 };
      probe.failNextRefresh();
      probe.input('a');
      probe.request(staleTableKey, () => { facts.stale += 1; });
      await new Promise<void>((resolve) => {
        let frames = 4;
        const next = () => requestAnimationFrame(() => {
          frames -= 1;
          if (frames === 0) resolve();
          else next();
        });
        next();
      });
      probe.input('b');
      probe.request(currentKey, () => { facts.current += 1; });
      await new Promise<void>((resolve) => {
        let frames = 4;
        const next = () => requestAnimationFrame(() => {
          frames -= 1;
          if (frames === 0) resolve();
          else next();
        });
        next();
      });
      probe.destroy();
      host.remove();
      return facts;
    });
    if (failedGenerationConsumerFacts.stale !== 0 || failedGenerationConsumerFacts.current !== 1) {
      throw new Error(`Failed refresh replayed an old consumer generation: ${JSON.stringify(failedGenerationConsumerFacts)}`);
    }

    const failedSettleConsumerFacts = await page.evaluate(async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const probe = (window as any).__createLiveInputConsumerProbe(host);
      const keyA = {};
      const keyB = {};
      const facts = { a: 0, afterFailureB: 0, currentB: 0, reports: 0, primaryError: '' };
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        if (args[0] === '[MEO live input] derived refresh failed') {
          facts.reports += 1;
          facts.primaryError = args[1] instanceof Error ? args[1].message : String(args[1]);
        }
      };
      try {
        probe.failNextSettle();
        probe.input('a');
        probe.request(keyA, () => { facts.a += 1; });
        for (let index = 0; index < 6; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        probe.request(keyB, () => { facts.afterFailureB += 1; });
        probe.input('b');
        probe.request(keyB, () => { facts.currentB += 1; });
        for (let index = 0; index < 6; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      } finally {
        console.error = originalConsoleError;
        probe.destroy();
        host.remove();
      }
      return facts;
    });
    if (
      failedSettleConsumerFacts.a !== 1 || failedSettleConsumerFacts.afterFailureB !== 1 ||
      failedSettleConsumerFacts.currentB !== 1 || failedSettleConsumerFacts.reports !== 1 ||
      failedSettleConsumerFacts.primaryError !== 'controlled live-input settle failure'
    ) {
      throw new Error(`Failed settle did not atomically recover consumer currentness: ${JSON.stringify(failedSettleConsumerFacts)}`);
    }

    const reentrantConsumerFacts = await page.evaluate(async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const probe = (window as any).__createLiveInputConsumerProbe(host);
      const keyA = {};
      const keyB = {};
      const keyThrow = {};
      const keyAfterThrow = {};
      const facts = { a: 0, self: 0, b: 0, threw: 0, afterThrow: 0 };
      probe.input('a');
      probe.request(keyA, () => {
        facts.a += 1;
        probe.request(keyA, () => { facts.self += 1; });
        probe.request(keyB, () => { facts.b += 1; });
      });
      probe.request(keyThrow, () => {
        facts.threw += 1;
        throw new Error('controlled consumer failure');
      });
      probe.request(keyAfterThrow, () => { facts.afterThrow += 1; });
      await new Promise<void>((resolve) => {
        let frames = 4;
        const next = () => requestAnimationFrame(() => {
          frames -= 1;
          if (frames === 0) resolve();
          else next();
        });
        next();
      });
      probe.input('b');
      await new Promise<void>((resolve) => {
        let frames = 4;
        const next = () => requestAnimationFrame(() => {
          frames -= 1;
          if (frames === 0) resolve();
          else next();
        });
        next();
      });
      probe.destroy();
      host.remove();
      return facts;
    });
    if (
      reentrantConsumerFacts.a !== 1 || reentrantConsumerFacts.self !== 0 ||
      reentrantConsumerFacts.b !== 1 || reentrantConsumerFacts.threw !== 1 ||
      reentrantConsumerFacts.afterThrow !== 1
    ) {
      throw new Error(`Reentrant consumer generation was not drained exactly once: ${JSON.stringify(reentrantConsumerFacts)}`);
    }

    const observerQuiescenceFacts = await page.evaluate(async () => {
      const host = document.createElement('div');
      const target = document.createElement('div');
      host.append(target);
      document.body.append(host);
      const probe = (window as any).__createLiveInputConsumerProbe(host);
      const keyA = {};
      const keyB = {};
      const keyC = {};
      const facts = { a: 0, b: 0, c: 0, echoB: 0, echoC: 0, immediateEscapes: 0 };
      let inObserver = false;
      const observer = new MutationObserver((records) => {
        inObserver = true;
        try {
          for (const record of records) {
            if (record.attributeName === 'data-a') {
              probe.request(keyB, () => {
                facts.b += 1;
                if (inObserver) facts.immediateEscapes += 1;
                target.dataset.b = String(facts.b);
              });
            }
            if (record.attributeName === 'data-b') {
              probe.request(keyB, () => {
                facts.echoB += 1;
                if (inObserver) facts.immediateEscapes += 1;
              });
              probe.request(keyC, () => {
                facts.c += 1;
                if (inObserver) facts.immediateEscapes += 1;
                target.dataset.c = String(facts.c);
              });
            }
            if (record.attributeName === 'data-c') {
              probe.request(keyC, () => {
                facts.echoC += 1;
                if (inObserver) facts.immediateEscapes += 1;
              });
            }
          }
        } finally {
          inObserver = false;
        }
      });
      observer.observe(target, { attributes: true });
      probe.input('q');
      probe.request(keyA, () => {
        facts.a += 1;
        target.dataset.a = String(facts.a);
      });
      const frames = async (count: number) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      await frames(6);
      const settled = { ...facts };
      probe.input('r');
      await frames(4);
      const afterNextGeneration = { ...facts };
      observer.disconnect();
      probe.destroy();
      host.remove();
      return { settled, afterNextGeneration };
    });
    const expectedObserverQuiescence = {
      a: 1,
      b: 1,
      c: 1,
      echoB: 0,
      echoC: 0,
      immediateEscapes: 0
    };
    if (
      JSON.stringify(observerQuiescenceFacts.settled) !== JSON.stringify(expectedObserverQuiescence) ||
      JSON.stringify(observerQuiescenceFacts.afterNextGeneration) !== JSON.stringify(expectedObserverQuiescence)
    ) {
      throw new Error(`Observer chain escaped its live-input generation: ${JSON.stringify(observerQuiescenceFacts)}`);
    }

    const compositionDesiredModuleFacts = await page.evaluate(async () => {
      const frames = async (count: number) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const createProbe = () => {
        const host = document.createElement('div');
        document.body.append(host);
        return { host, probe: (window as any).__createLiveInputConsumerProbe(host) };
      };

      const empty = createProbe();
      empty.probe.beginComposition();
      empty.probe.completeComposition();
      await frames(4);
      const emptyRefreshes = empty.probe.refreshes();
      empty.probe.destroy();
      empty.host.remove();

      const latest = createProbe();
      const latestKey = {};
      const latestRuns = { a: 0, b: 0 };
      latest.probe.beginComposition();
      latest.probe.requestOnFrame(latestKey, () => { latestRuns.a += 1; });
      latest.probe.requestOnFrame(latestKey, () => { latestRuns.b += 1; });
      latest.probe.completeComposition();
      await frames(6);
      const latestRefreshes = latest.probe.refreshes();
      latest.probe.destroy();
      latest.host.remove();

      const cancelled = createProbe();
      let cancelRuns = 0;
      cancelled.probe.beginComposition();
      cancelled.probe.requestOnFrame({}, () => { cancelRuns += 1; });
      cancelled.probe.completeComposition();
      await frames(6);
      const cancelRefreshes = cancelled.probe.refreshes();
      cancelled.probe.destroy();
      cancelled.host.remove();

      const preExisting = createProbe();
      let preExistingRuns = 0;
      preExisting.probe.requestOnFrame({}, () => { preExistingRuns += 1; });
      preExisting.probe.beginComposition();
      preExisting.probe.completeComposition();
      await frames(6);
      const preExistingRefreshes = preExisting.probe.refreshes();
      preExisting.probe.destroy();
      preExisting.host.remove();

      const committed = createProbe();
      const committedKey = {};
      const committedRuns = { a: 0, b: 0 };
      committed.probe.input('i');
      committed.probe.request({}, () => {
        committed.probe.requestOnFrame(committedKey, () => { committedRuns.b += 1; });
      });
      committed.probe.requestOnFrame(committedKey, () => { committedRuns.a += 1; });
      await frames(6);
      const committedRefreshes = committed.probe.refreshes();
      committed.probe.destroy();
      committed.host.remove();

      const failed = createProbe();
      let failedRuns = 0;
      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        failed.probe.failNextRefresh();
        failed.probe.beginComposition();
        failed.probe.requestOnFrame({}, () => { failedRuns += 1; });
        failed.probe.completeComposition();
        await frames(6);
        failed.probe.input('n');
        await frames(6);
      } finally {
        console.error = originalConsoleError;
      }
      const failedRefreshes = failed.probe.refreshes();
      failed.probe.destroy();
      failed.host.remove();

      const first = createProbe();
      const second = createProbe();
      let firstRuns = 0;
      let secondRuns = 0;
      first.probe.beginComposition();
      second.probe.beginComposition();
      first.probe.requestOnFrame({}, () => { firstRuns += 1; });
      second.probe.requestOnFrame({}, () => { secondRuns += 1; });
      first.probe.completeComposition();
      await frames(6);
      const afterFirst = { firstRuns, secondRuns };
      second.probe.completeComposition();
      await frames(6);
      const afterSecond = { firstRuns, secondRuns };
      first.probe.destroy();
      second.probe.destroy();
      first.host.remove();
      second.host.remove();

      return {
        emptyRefreshes,
        latestRuns,
        latestRefreshes,
        cancelRuns,
        cancelRefreshes,
        preExistingRuns,
        preExistingRefreshes,
        committedRuns,
        committedRefreshes,
        failedRuns,
        failedRefreshes,
        afterFirst,
        afterSecond
      };
    });
    if (
      compositionDesiredModuleFacts.emptyRefreshes !== 0 ||
      JSON.stringify(compositionDesiredModuleFacts.latestRuns) !== JSON.stringify({ a: 0, b: 1 }) ||
      compositionDesiredModuleFacts.latestRefreshes !== 1 ||
      compositionDesiredModuleFacts.cancelRuns !== 1 || compositionDesiredModuleFacts.cancelRefreshes !== 1 ||
      compositionDesiredModuleFacts.preExistingRuns !== 1 || compositionDesiredModuleFacts.preExistingRefreshes !== 1 ||
      JSON.stringify(compositionDesiredModuleFacts.committedRuns) !== JSON.stringify({ a: 0, b: 1 }) ||
      compositionDesiredModuleFacts.committedRefreshes !== 1 ||
      compositionDesiredModuleFacts.failedRuns !== 0 || compositionDesiredModuleFacts.failedRefreshes !== 2 ||
      JSON.stringify(compositionDesiredModuleFacts.afterFirst) !== JSON.stringify({ firstRuns: 1, secondRuns: 0 }) ||
      JSON.stringify(compositionDesiredModuleFacts.afterSecond) !== JSON.stringify({ firstRuns: 1, secondRuns: 1 })
    ) {
      throw new Error(`Composition desired Module matrix failed: ${JSON.stringify(compositionDesiredModuleFacts)}`);
    }

    const liveSearchPendingFacts = await page.evaluate(async () => {
      const editor = (window as any).__liveInputEditor;
      const probe = (window as any).__observeLiveSearchRefresh(editor);
      editor.setSearchQuery('cell');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      probe.reset();
      (window as any).__dispatchProductionInput(editor, editor.getText().length, 's');
      editor.setSearchQuery('value');
      editor.setSearchQuery('marked');
      const firstFrame = await new Promise<number>((resolve) => {
        requestAnimationFrame(() => setTimeout(() => resolve(probe.count()), 0));
      });
      for (let index = 0; index < 5; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const settled = probe.count();
      probe.destroy();
      return { firstFrame, settled };
    });
    if (liveSearchPendingFacts.firstFrame !== 0 || liveSearchPendingFacts.settled !== 1) {
      throw new Error(`Live search did not submit one current leaf after the barrier: ${JSON.stringify(liveSearchPendingFacts)}`);
    }

    const liveSearchCrossFrameFacts = await page.evaluate(async () => {
      const editor = (window as any).__liveInputEditor;
      const probe = (window as any).__observeLiveSearchRefresh(editor);
      probe.reset();
      (window as any).__dispatchProductionInput(editor, editor.getText().length, 'x');
      editor.setSearchQuery('value');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      editor.setSearchQuery('marked');
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const effects = probe.count();
      probe.destroy();
      return { effects };
    });
    if (liveSearchCrossFrameFacts.effects !== 1) {
      throw new Error(`Live search cross-frame replacement did not execute latest once: ${JSON.stringify(liveSearchCrossFrameFacts)}`);
    }

    const liveSearchFrameLifecycleFacts = await page.evaluate(async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const editor = (window as any).__createInputCursorEditor({
        parent: host,
        text: 'alpha beta gamma delta epsilon',
        initialMode: 'live',
        onApplyChanges() {}
      });
      const probe = (window as any).__observeLiveSearchRefresh(editor);
      const frames = async (count: number) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      editor.setSearchQuery('alpha');
      editor.setSearchQuery('beta');
      await frames(2);
      const idleLatest = probe.count();

      probe.reset();
      editor.setSearchQuery('gamma');
      (window as any).__dispatchProductionInput(editor, editor.getText().length, '!');
      editor.setSearchQuery('delta');
      await frames(1);
      const adoptedFirstFrame = probe.count();
      await frames(5);
      const adoptedSettled = probe.count();

      probe.reset();
      editor.setSearchQuery('alpha');
      (window as any).__dispatchProductionInput(editor, editor.getText().length, '1');
      (window as any).__dispatchProductionInput(editor, editor.getText().length, '2');
      await frames(1);
      const replacedInputFirstFrame = probe.count();
      await frames(5);
      const replacedInputSettled = probe.count();

      probe.reset();
      editor.setSearchQuery('epsilon');
      editor.setText('external document', true);
      await frames(3);
      const superseded = probe.count();
      editor.setSearchQuery('document');
      await frames(2);
      const currentAfterSupersede = probe.count();

      probe.destroy();
      editor.destroy();
      host.remove();
      return {
        idleLatest,
        adoptedFirstFrame,
        adoptedSettled,
        replacedInputFirstFrame,
        replacedInputSettled,
        superseded,
        currentAfterSupersede
      };
    });
    if (
      liveSearchFrameLifecycleFacts.idleLatest !== 1 ||
      liveSearchFrameLifecycleFacts.adoptedFirstFrame !== 0 ||
      liveSearchFrameLifecycleFacts.adoptedSettled !== 1 ||
      liveSearchFrameLifecycleFacts.replacedInputFirstFrame !== 0 ||
      liveSearchFrameLifecycleFacts.replacedInputSettled !== 1 ||
      liveSearchFrameLifecycleFacts.superseded !== 0 ||
      liveSearchFrameLifecycleFacts.currentAfterSupersede !== 1
    ) {
      throw new Error(`Live search frame lifecycle escaped Module currentness: ${JSON.stringify(liveSearchFrameLifecycleFacts)}`);
    }

    const emptyCompositionSearchFacts = await page.evaluate(async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const editor = (window as any).__createInputCursorEditor({
        parent: host,
        text: 'empty composition search target',
        initialMode: 'live',
        onApplyChanges() {}
      });
      const probe = (window as any).__observeLiveSearchRefresh(editor);
      const content = editor.view.contentDOM;
      content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      content.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
      editor.setSearchQuery('search');
      const found = editor.findNext('target', { focusEditor: false }).found;
      // The production composition owner completes on a 20ms timer. Await that
      // boundary before advancing the Module's frame and observer checkpoints.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const afterComplete = probe.count();
      editor.setSearchQuery('composition');
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const afterNewQuery = probe.count();
      (window as any).__dispatchProductionInput(editor, editor.getText().length, '!');
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const afterNextInput = probe.count();
      probe.destroy();
      editor.destroy();
      host.remove();
      return { found, afterComplete, afterNewQuery, afterNextInput };
    });
    if (
      emptyCompositionSearchFacts.found !== true || emptyCompositionSearchFacts.afterComplete !== 1 ||
      emptyCompositionSearchFacts.afterNewQuery !== 2 || emptyCompositionSearchFacts.afterNextInput !== 2
    ) {
      throw new Error(`Empty composition did not settle its current search desired once: ${JSON.stringify(emptyCompositionSearchFacts)}`);
    }

    const compositionSearchCancellationFacts = await page.evaluate(async () => {
      const frames = async (count: number) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const create = () => {
        const host = document.createElement('div');
        document.body.append(host);
        const editor = (window as any).__createInputCursorEditor({
          parent: host,
          text: 'composition cancellation target',
          initialMode: 'live',
          onApplyChanges() {}
        });
        return { host, editor, probe: (window as any).__observeLiveSearchRefresh(editor) };
      };

      const external = create();
      external.editor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      external.editor.setSearchQuery('target');
      external.editor.setText('external wins', true);
      external.editor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
      await frames(6);
      const externalEffects = external.probe.count();
      external.probe.destroy();
      external.editor.destroy();
      external.host.remove();

      const mode = create();
      mode.editor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      mode.editor.setSearchQuery('target');
      mode.editor.setMode('source');
      mode.editor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
      await frames(6);
      const modeEffects = mode.probe.count();
      mode.probe.destroy();
      mode.editor.destroy();
      mode.host.remove();

      const destroyed = create();
      destroyed.editor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      destroyed.editor.setSearchQuery('target');
      destroyed.editor.destroy();
      await frames(6);
      const destroyEffects = destroyed.probe.count();
      destroyed.host.remove();

      return { externalEffects, modeEffects, destroyEffects };
    });
    if (
      compositionSearchCancellationFacts.externalEffects !== 0 ||
      compositionSearchCancellationFacts.modeEffects !== 0 ||
      compositionSearchCancellationFacts.destroyEffects !== 0
    ) {
      throw new Error(`Composition search desired survived explicit cancellation: ${JSON.stringify(compositionSearchCancellationFacts)}`);
    }

    const longCompositionSearchFacts = await page.evaluate(async () => {
      const frames = async (count: number) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const run = async (cancel: boolean) => {
        const host = document.createElement('div');
        document.body.append(host);
        const editor = (window as any).__createInputCursorEditor({
          parent: host,
          text: 'long composition target',
          initialMode: 'live',
          onApplyChanges() {}
        });
        const probe = (window as any).__observeLiveSearchRefresh(editor);
        const content = editor.view.contentDOM;
        content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        const insertion = editor.getText().length;
        (window as any).__dispatchProductionInput(editor, insertion, 'preedit');
        editor.setSearchQuery('target');
        await frames(4);
        const during = probe.count();
        if (cancel) {
          (window as any).__dispatchProductionInput(editor, insertion, '', insertion + 'preedit'.length);
        }
        content.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
        await frames(6);
        const after = probe.count();
        probe.destroy();
        editor.destroy();
        host.remove();
        return { during, after };
      };
      return { commit: await run(false), cancel: await run(true) };
    });
    if (
      longCompositionSearchFacts.commit.during !== 0 || longCompositionSearchFacts.commit.after !== 1 ||
      longCompositionSearchFacts.cancel.during !== 0 || longCompositionSearchFacts.cancel.after !== 1
    ) {
      throw new Error(`Long composition search desired escaped preedit/commit ownership: ${JSON.stringify(longCompositionSearchFacts)}`);
    }

    const destroyedLiveSearchFacts = await page.evaluate(async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const editor = (window as any).__createInputCursorEditor({
        parent: host,
        text: 'destroyed search target',
        initialMode: 'live',
        onApplyChanges() {}
      });
      const probe = (window as any).__observeLiveSearchRefresh(editor);
      editor.setSearchQuery('target');
      editor.destroy();
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const refreshes = probe.count();
      host.remove();
      return refreshes;
    });
    if (destroyedLiveSearchFacts !== 0) {
      throw new Error(`Destroyed Live search applied a stale refresh effect: ${destroyedLiveSearchFacts}`);
    }

    const initialTableCount = await page.evaluate(() => (
      document.querySelectorAll('#primary .meo-md-html-table-shell').length
    ));
    if (initialTableCount !== 1) {
      throw new Error(`Live table fixture did not render: ${initialTableCount}`);
    }
    const initialOneShotFixture = await page.evaluate(() => ({
      detailsOpen: document.querySelector<HTMLDetailsElement>('#primary .meo-md-html-content details')?.open,
      longCodePlaceholders: document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
    }));
    if (initialOneShotFixture.detailsOpen !== true || initialOneShotFixture.longCodePlaceholders !== 1) {
      throw new Error(`Live one-shot fixture did not render: ${JSON.stringify(initialOneShotFixture)}`);
    }

    const detailsProbeImmediate = await page.evaluate(() => {
      const host = document.createElement('div');
      document.body.append(host);
      const probe = (window as any).__createDetailsOperationProbe(
        host,
        '<details>\n<summary>Probe</summary>\nBody\n</details>'
      );
      (window as any).__detailsOperationProbe = probe;
      probe.reset();
      probe.input(0, 'x');
      const toggled = probe.toggle();
      (window as any).__detailsProbeFirstFrame = new Promise((resolve) => {
        requestAnimationFrame(() => setTimeout(() => resolve(probe.iterations()), 0));
      });
      return { toggled, iterations: probe.iterations() };
    });
    if (!detailsProbeImmediate.toggled || detailsProbeImmediate.iterations !== 0) {
      throw new Error(`Deferred details input synchronously scanned syntax: ${JSON.stringify(detailsProbeImmediate)}`);
    }
    const detailsProbeFirstFrame = await page.evaluate(() => (
      (window as any).__detailsProbeFirstFrame
    ));
    if (detailsProbeFirstFrame !== 0) {
      throw new Error(`Deferred details input scanned before the barrier: ${detailsProbeFirstFrame}`);
    }
    await waitForFrames(page, 4);
    const detailsProbeSettled = await page.evaluate(() => {
      const probe = (window as any).__detailsOperationProbe;
      const iterations = probe.iterations();
      const collapsed = getComputedStyle(probe.view.dom).display !== 'none';
      probe.destroy();
      probe.view.dom.parentElement?.remove();
      return { iterations, collapsed };
    });
    if (detailsProbeSettled.iterations !== 1) {
      throw new Error(`Details refresh did not perform exactly one current scan: ${JSON.stringify(detailsProbeSettled)}`);
    }

    const pendingDetails = await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      (window as any).__dispatchProductionInput(editor, 'plain'.length, 'D');
      const toggled = (window as any).__toggleFirstDetails(editor);
      return {
        toggled,
        detailsOpen: document.querySelector<HTMLDetailsElement>('#primary .meo-md-html-content details')?.open,
        placeholders: document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
      };
    });
    await waitForFrames(page, 5);
    const settledDetails = await page.evaluate(() => ({
      detailsOpen: document.querySelector<HTMLDetailsElement>('#primary .meo-md-html-content details')?.open,
      placeholders: document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
    }));
    if (
      !pendingDetails.toggled || pendingDetails.detailsOpen !== false ||
      pendingDetails.placeholders !== 1 || settledDetails.detailsOpen !== false ||
      settledDetails.placeholders !== 1
    ) {
      throw new Error(`Pending input swallowed details or long-code session state: ${JSON.stringify({ pendingDetails, settledDetails })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      (window as any).__toggleFirstDetails(editor);
      editor.setSearchQuery('');
      editor.setText(text, true);
    }, original);
    await waitForFrames(page, 5);
    const pendingSearchReveal = await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      const refreshProbe = (window as any).__observeLiveSearchRefresh(editor);
      refreshProbe.reset();
      (window as any).__pendingSearchRevealRefreshProbe = refreshProbe;
      (window as any).__dispatchProductionInput(editor, 'plain'.length, 'S');
      const result = editor.findNext('const liveLine19 = 19;', { focusEditor: false });
      return {
        found: result?.found,
        placeholders: document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
      };
    });
    await waitForFrames(page, 5);
    const settledSearchReveal = await page.evaluate(() => {
      const refreshProbe = (window as any).__pendingSearchRevealRefreshProbe;
      const result = {
        placeholders: document.querySelectorAll('#primary .meo-md-long-code-placeholder').length,
        refreshEffects: refreshProbe.count()
      };
      refreshProbe.destroy();
      delete (window as any).__pendingSearchRevealRefreshProbe;
      return result;
    });
    if (
      pendingSearchReveal.found !== true || pendingSearchReveal.placeholders !== 0 ||
      settledSearchReveal.placeholders !== 0 || settledSearchReveal.refreshEffects !== 1
    ) {
      throw new Error(`Pending input swallowed or replayed search reveal: ${JSON.stringify({ pendingSearchReveal, settledSearchReveal })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setSearchQuery('');
      editor.setText(text, true);
    }, original);
    await waitForFrames(page, 5);
    const pendingToggle = await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      (window as any).__dispatchProductionInput(editor, 'plain'.length, 'T');
      document.querySelector<HTMLButtonElement>('#primary .meo-md-long-code-placeholder .meo-long-code-action')?.click();
      return document.querySelectorAll('#primary .meo-md-long-code-placeholder').length;
    });
    await waitForFrames(page, 5);
    const settledToggle = await page.evaluate(() => (
      document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
    ));
    if (pendingToggle !== 0 || settledToggle !== 0) {
      throw new Error(`Pending input swallowed or replayed long-code toggle: ${JSON.stringify({ pendingToggle, settledToggle })}`);
    }

    const collisionBlock = (label: string) => [
      '```js',
      ...Array.from({ length: 24 }, (_, index) => `const ${label}${index + 1} = ${index + 1};`),
      '```'
    ].join('\n');
    const firstCollisionBlock = collisionBlock('collisionFirst');
    const collisionText = `${firstCollisionBlock}\n\n${collisionBlock('collisionSecond')}`;
    const oldSecondAnchor = firstCollisionBlock.length + 2;
    await page.evaluate((text) => {
      (window as any).__liveInputEditor.setText(text, true);
    }, collisionText);
    await waitForFrames(page, 5);
    const collisionToggle = await page.evaluate((anchorShift) => {
      const editor = (window as any).__liveInputEditor;
      (window as any).__dispatchProductionInput(editor, 0, `${'x'.repeat(anchorShift - 1)}\n`);
      const actions = document.querySelectorAll<HTMLButtonElement>(
        '#primary .meo-md-long-code-placeholder .meo-long-code-action'
      );
      if (actions.length !== 2) throw new Error(`Expected two pending long-code actions, got ${actions.length}`);
      actions[1].click();
      const visibleText = document.querySelector('#primary .cm-content')?.textContent ?? '';
      return {
        placeholders: document.querySelectorAll('#primary .meo-md-long-code-placeholder').length,
        firstHidden: !visibleText.includes('collisionFirst24'),
        secondVisible: visibleText.includes('collisionSecond24')
      };
    }, oldSecondAnchor);
    await waitForFrames(page, 5);
    const settledCollisionToggle = await page.evaluate(() => {
      const visibleText = document.querySelector('#primary .cm-content')?.textContent ?? '';
      return {
        placeholders: document.querySelectorAll('#primary .meo-md-long-code-placeholder').length,
        firstHidden: !visibleText.includes('collisionFirst24'),
        secondVisible: visibleText.includes('collisionSecond24')
      };
    });
    if (
      collisionToggle.placeholders !== 1 || !collisionToggle.firstHidden || !collisionToggle.secondVisible ||
      settledCollisionToggle.placeholders !== 1 || !settledCollisionToggle.firstHidden ||
      !settledCollisionToggle.secondVisible
    ) {
      throw new Error(`Pending input targeted the wrong colliding long-code anchor: ${JSON.stringify({ collisionToggle, settledCollisionToggle })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
    }, original);
    await waitForFrames(page, 5);
    const pendingPointer = await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      (window as any).__dispatchProductionInput(editor, 'plain'.length, 'P');
      const line = Array.from(document.querySelectorAll<HTMLElement>('#primary .meo-md-code-line-numbered'))
        .find((candidate) => candidate.textContent?.includes('const liveLine1 = 1;'));
      const rect = line?.getBoundingClientRect();
      if (!line || !rect) throw new Error('Missing visible long-code line for pointer command');
      line.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        pointerId: 19,
        clientX: rect.left + 8,
        clientY: rect.top + rect.height / 2
      }));
      return document.querySelectorAll('#primary .meo-md-long-code-placeholder').length;
    });
    await waitForFrames(page, 5);
    const settledPointer = await page.evaluate(() => (
      document.querySelectorAll('#primary .meo-md-long-code-placeholder').length
    ));
    if (pendingPointer !== 0 || settledPointer !== 0) {
      throw new Error(`Pending input swallowed or replayed long-code pointer command: ${JSON.stringify({ pendingPointer, settledPointer })}`);
    }

    await page.evaluate((text) => {
      (window as any).__liveInputEditor.setText(text, true);
      document.querySelector<HTMLButtonElement>('#primary .meo-md-long-code-footer .meo-long-code-action')?.click();
    }, original);
    await waitForFrames(page, 5);

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'fixed',
        baseText: text
      });
      editor.setSearchQuery('cell');
    }, original);
    await waitForFrames(page, 5);

    await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      editor.revealSelection('plain '.length, 'plain '.length, { focusEditor: true, align: 'nearest' });
    });
    await waitForFrames(page, 2);
    await armFirstFrame(page, 'beforeinput');
    await page.keyboard.type('X');
    const plainImmediate = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      applies: [...(window as any).__liveInputApplies]
    }));
    const plainFrame = await readFirstFrame(page);
    const plainSettled = await readSettledFrame(page);
    if (
      !plainImmediate.text.startsWith('plain Xline') ||
      plainImmediate.applies.at(-1) !== plainImmediate.text ||
      plainFrame.text !== plainImmediate.text ||
      !plainFrame.domText.includes('plain Xline') ||
      plainFrame.selectionText !== '' ||
      !plainFrame.caretVisible ||
      plainFrame.tableCount !== 1 ||
      plainFrame.derivedAdditions !== 0 ||
      plainFrame.tableProjectionEvents !== 0 ||
      plainFrame.searchEvents !== 0 ||
      plainFrame.gitOverviewRenders !== 0 ||
      plainFrame.searchOverviewRenders !== 0 ||
      plainSettled.gitOverviewRenders !== 1 ||
      plainSettled.searchOverviewRenders !== 1
    ) {
      throw new Error(`Plain input/overview render ordering failed: ${JSON.stringify({ plainImmediate, plainFrame, plainSettled })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      const markerStart = text.indexOf('marked');
      editor.revealSelection(markerStart, markerStart + 'marked'.length, {
        focusEditor: true,
        align: 'nearest'
      });
    }, original);
    await waitForFrames(page, 3);
    await armFirstFrame(page, 'beforeinput');
    await page.keyboard.type('Q');
    const markerFrame = await readFirstFrame(page);
    if (!markerFrame.text.includes('**Q text**') || !markerFrame.domText.includes('Q text') || !markerFrame.caretVisible) {
      throw new Error(`Markdown-adjacent replacement was hidden or reverted: ${JSON.stringify(markerFrame)}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      const blankLine = text.indexOf('\n\n|') + 1;
      editor.revealSelection(blankLine, blankLine, { focusEditor: true, align: 'nearest' });
    }, original);
    await waitForFrames(page, 3);
    await armFirstFrame(page, 'beforeinput');
    await page.keyboard.type('Z');
    const boundaryFrame = await readFirstFrame(page);
    const boundarySettled = await readSettledFrame(page);
    if (
      !boundaryFrame.text.includes('**marked text**\nZ\n| A | B |') ||
      !boundaryFrame.domText.includes('Z') ||
      boundaryFrame.tableCount !== 0 ||
      boundaryFrame.derivedAdditions !== 0 ||
      boundaryFrame.tableProjectionEvents !== 0 ||
      boundaryFrame.searchEvents !== 0 ||
      boundarySettled.tableCount !== 1 ||
      boundarySettled.derivedAdditions === 0 ||
      boundarySettled.tableProjectionEvents === 0 ||
      boundarySettled.searchEvents === 0 ||
      boundarySettled.text !== boundaryFrame.text
    ) {
      throw new Error(`Rendered-block boundary did not preserve primary text and the unaffected block: ${JSON.stringify({ boundaryFrame, boundarySettled })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection('plain'.length, 'plain'.length, { focusEditor: true, align: 'nearest' });
    }, original);
    await waitForFrames(page, 2);
    await armFirstFrame(page, 'paste');
    const pasteHandled = await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', ' PASTE');
      return !document.querySelector<HTMLElement>('#primary .cm-content')!.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data
      }));
    });
    const pasteFrame = await readFirstFrame(page);
    if (!pasteHandled || !pasteFrame.text.startsWith('plain PASTE line') || !pasteFrame.domText.includes('plain PASTE line') || !pasteFrame.caretVisible) {
      throw new Error(`Paste was not committed and visible on its first frame: ${JSON.stringify({ pasteHandled, pasteFrame })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection('plain line'.length, 'plain line'.length, { focusEditor: true, align: 'nearest' });
    }, coreOriginal);
    await waitForFrames(page, 2);
    const emptyImePendingStart = await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      const root = document.querySelector<HTMLElement>('#primary .cm-editor')!;
      const content = document.querySelector<HTMLElement>('#primary .cm-content')!;
      const facts = { searches: 0, projections: 0, derivedAdds: 0 };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches('.meo-md-marker, .meo-md-html-table-shell, .meo-md-list-marker')) {
              facts.derivedAdds += 1;
            }
            facts.derivedAdds += node.querySelectorAll(
              '.meo-md-marker, .meo-md-html-table-shell, .meo-md-list-marker'
            ).length;
          }
        }
      });
      const onSearch = () => { facts.searches += 1; };
      const onProjection = () => { facts.projections += 1; };
      observer.observe(content, { childList: true, subtree: true });
      root.addEventListener('meo-search-state-change', onSearch, true);
      root.addEventListener('meo-table-column-width-projected', onProjection, true);
      (window as any).__emptyImePendingFacts = facts;
      (window as any).__emptyImePendingCleanup = () => {
        observer.disconnect();
        root.removeEventListener('meo-search-state-change', onSearch, true);
        root.removeEventListener('meo-table-column-width-projected', onProjection, true);
      };
      (window as any).__dispatchProductionInput(editor, 'plain'.length, 'E');
      content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      return { text: editor.getText(), applies: (window as any).__liveInputApplies.length };
    });
    await waitForFrames(page, 4);
    const emptyImePendingHeld = await page.evaluate(() => ({
      ...(window as any).__emptyImePendingFacts,
      text: (window as any).__liveInputEditor.getText()
    }));
    if (
      !emptyImePendingStart.text.startsWith('plainE line') ||
      emptyImePendingHeld.searches !== 0 ||
      emptyImePendingHeld.projections !== 0 ||
      emptyImePendingHeld.derivedAdds !== 0
    ) {
      throw new Error(`Empty IME start lost the pending barrier: ${JSON.stringify({ emptyImePendingStart, emptyImePendingHeld })}`);
    }
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#primary .cm-content')!.dispatchEvent(
        new CompositionEvent('compositionend', { data: '', bubbles: true })
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    await waitForFrames(page, 5);
    const emptyImePendingSettled = await page.evaluate(() => {
      (window as any).__emptyImePendingCleanup();
      return { ...(window as any).__emptyImePendingFacts };
    });
    if (emptyImePendingSettled.searches !== 1) {
      throw new Error(`Empty IME completion did not resume latest derived work once: ${JSON.stringify(emptyImePendingSettled)}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      const root = document.querySelector<HTMLElement>('#primary .cm-editor')!;
      const content = document.querySelector<HTMLElement>('#primary .cm-content')!;
      (window as any).__emptyImeNoPendingSearches = 0;
      const onSearch = () => { (window as any).__emptyImeNoPendingSearches += 1; };
      root.addEventListener('meo-search-state-change', onSearch, true);
      content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      content.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
      (window as any).__emptyImeNoPendingCleanup = () => (
        root.removeEventListener('meo-search-state-change', onSearch, true)
      );
    }, coreOriginal);
    await new Promise((resolve) => setTimeout(resolve, 35));
    await waitForFrames(page, 4);
    const emptyImeNoPendingSearches = await page.evaluate(() => {
      (window as any).__emptyImeNoPendingCleanup();
      return (window as any).__emptyImeNoPendingSearches;
    });
    if (emptyImeNoPendingSearches !== 0) {
      throw new Error(`Empty IME without pending input ran derived work: ${emptyImeNoPendingSearches}`);
    }

    const beforeImeApplyCount = await page.evaluate(() => (window as any).__liveInputApplies.length);
    const session = await page.createCDPSession();
    await armFirstFrame(page, 'beforeinput');
    await session.send('Input.imeSetComposition', { text: 'long-preedit', selectionStart: 12, selectionEnd: 12 });
    const preeditFirstFrame = await readFirstFrame(page);
    const preeditFourthFrame = await readSettledFrame(page);
    if (
      !preeditFirstFrame.text.startsWith('plain linelong-preedit') ||
      !preeditFourthFrame.domText.includes('long-preedit') ||
      preeditFourthFrame.applyCount !== beforeImeApplyCount ||
      preeditFourthFrame.derivedAdditions !== 0 ||
      preeditFourthFrame.tableProjectionEvents !== 0 ||
      preeditFourthFrame.searchEvents !== 0
    ) {
      throw new Error(`Long IME preedit triggered derived work: ${JSON.stringify({ preeditFirstFrame, preeditFourthFrame })}`);
    }

    await armFirstFrame(page, 'beforeinput', 25);
    await session.send('Input.imeSetComposition', { text: '拼', selectionStart: 1, selectionEnd: 1 });
    await session.send('Input.insertText', { text: '拼' });
    const imeFrame = await readFirstFrame(page);
    const imeSettled = await readSettledFrame(page);
    if (
      !imeFrame.text.startsWith('plain line拼') ||
      !imeFrame.domText.includes('plain line拼') ||
      !imeFrame.caretVisible ||
      imeFrame.derivedAdditions !== 0 ||
      imeFrame.tableProjectionEvents !== 0 ||
      imeFrame.searchEvents !== 0 ||
      imeSettled.applyCount !== beforeImeApplyCount + 1 ||
      imeSettled.derivedAdditions === 0
    ) {
      throw new Error(`IME commit did not preserve preedit/commit ownership: ${JSON.stringify({ imeFrame, imeSettled })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection('plain line'.length, 'plain line'.length, { focusEditor: true, align: 'nearest' });
    }, coreOriginal);
    await waitForFrames(page, 2);
    const beforeImeCancelApplyCount = await page.evaluate(() => (window as any).__liveInputApplies.length);
    await armFirstFrame(page, 'beforeinput');
    await session.send('Input.imeSetComposition', { text: 'cancel-preedit', selectionStart: 14, selectionEnd: 14 });
    const cancelPreeditFirst = await readFirstFrame(page);
    const cancelPreeditSettled = await readSettledFrame(page);
    if (
      !cancelPreeditFirst.text.startsWith('plain linecancel-preedit') ||
      cancelPreeditSettled.applyCount !== beforeImeCancelApplyCount ||
      cancelPreeditSettled.derivedAdditions !== 0 ||
      cancelPreeditSettled.tableProjectionEvents !== 0 ||
      cancelPreeditSettled.searchEvents !== 0
    ) {
      throw new Error(`IME cancel preedit triggered derived work: ${JSON.stringify({ cancelPreeditFirst, cancelPreeditSettled })}`);
    }
    await armFirstFrame(page, 'compositionend', 25);
    await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      const cancelFrom = 'plain line'.length;
      (window as any).__dispatchProductionInput(editor, cancelFrom, '', cancelFrom + 'cancel-preedit'.length);
      document.querySelector<HTMLElement>('#primary .cm-content')?.dispatchEvent(new CompositionEvent('compositionend', {
        data: '',
        bubbles: true
      }));
    });
    const imeCancelFrame = await readFirstFrame(page);
    const imeCancelSettled = await readSettledFrame(page);
    if (
      imeCancelFrame.text !== coreOriginal ||
      imeCancelFrame.derivedAdditions !== 0 ||
      imeCancelFrame.tableProjectionEvents !== 0 ||
      imeCancelFrame.searchEvents !== 0 ||
      imeCancelSettled.applyCount !== beforeImeCancelApplyCount + 1 ||
      imeCancelSettled.derivedAdditions === 0
    ) {
      throw new Error(`IME cancel did not restore and refresh the committed document once: ${JSON.stringify({ imeCancelFrame, imeCancelSettled })}`);
    }

    const orderedList = '1. alpha\n1. beta';
    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection(text.length, text.length, { focusEditor: true, align: 'nearest' });
    }, orderedList);
    await waitForFrames(page, 3);
    await armFirstFrame(page, 'beforeinput');
    await page.keyboard.type('!');
    const orderedFrame = await readFirstFrame(page);
    const orderedSettled = await readSettledFrame(page);
    const orderedLatestApply = await page.evaluate(() => (window as any).__liveInputApplies.at(-1));
    if (
      orderedFrame.text !== '1. alpha\n2. beta!' ||
      orderedLatestApply !== orderedFrame.text ||
      !orderedFrame.domText.includes('beta!') ||
      orderedFrame.derivedAdditions !== 0 ||
      orderedFrame.searchEvents !== 0 ||
      orderedSettled.text !== orderedFrame.text ||
      !orderedSettled.derivedMutationKinds.some((kind) => kind.includes('meo-md-list-marker'))
    ) {
      throw new Error(`Ordered-list input follow-up escaped the input phase: ${JSON.stringify({ orderedFrame, orderedSettled, orderedLatestApply })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection('plain'.length, 'plain'.length, { focusEditor: true, align: 'nearest' });
    }, original);
    await waitForFrames(page, 2);
    await page.keyboard.type('abcdef');
    const burst = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      latestApply: (window as any).__liveInputApplies.at(-1)
    }));
    await page.evaluate(() => (window as any).__liveInputEditor.setText('external reload wins', true));
    await waitForFrames(page, 4);
    const currentness = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      domText: document.querySelector<HTMLElement>('#primary .cm-content')?.textContent ?? ''
    }));
    if (!burst.text.startsWith('plainabcdef line') || burst.latestApply !== burst.text || currentness.text !== 'external reload wins' || !currentness.domText.includes('external reload wins')) {
      throw new Error(`Burst/reload currentness failed: ${JSON.stringify({ burst, currentness })}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__secondaryEditor;
      editor.revealSelection(editor.getText().length, editor.getText().length, { focusEditor: true, align: 'nearest' });
    });
    await page.keyboard.type(' remains');
    await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      (window as any).__dispatchProductionInput(editor, editor.getText().length, 'M');
      editor.setMode('source');
    });
    await waitForFrames(page, 4);
    const modeSupersede = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      domText: document.querySelector<HTMLElement>('#primary .cm-content')?.textContent ?? '',
      sourceMode: document.querySelector('#primary .cm-editor')?.classList.contains('meo-mode-source')
    }));
    if (
      modeSupersede.text !== 'external reload winsM' ||
      !modeSupersede.domText.includes('external reload winsM') ||
      modeSupersede.sourceMode !== true
    ) {
      throw new Error(`Mode supersede did not preserve the latest primary document: ${JSON.stringify(modeSupersede)}`);
    }
    await page.evaluate(() => (window as any).__liveInputEditor.destroy());
    const isolation = await page.evaluate(() => ({
      secondaryText: (window as any).__secondaryEditor.getText(),
      secondaryApply: (window as any).__secondaryApplies.at(-1),
      secondaryDom: document.querySelector<HTMLElement>('#secondary .cm-content')?.textContent ?? '',
      primaryConnected: Boolean(document.querySelector('#primary .cm-editor'))
    }));
    if (
      isolation.secondaryText !== 'second editor remains' ||
      isolation.secondaryApply !== isolation.secondaryText ||
      !isolation.secondaryDom.includes('second editor remains') ||
      isolation.primaryConnected
    ) {
      throw new Error(`Destroy/multi-editor isolation failed: ${JSON.stringify(isolation)}`);
    }

    console.log('Live input production frame trace passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
