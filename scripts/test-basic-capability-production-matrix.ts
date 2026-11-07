import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Frame, Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import type { SourceLineNumberMode } from '../src/protocol/readyInit';
import { captureHistoryInteraction, assertHistoryRoundTrip, assertHistoryCoverage } from './history-interaction-contract';
import { historyFormatCases, formattedHistoryRange } from './history-format-cases';

const root = path.resolve(import.meta.dir, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-basic-capability-index-'));
const target = 'format target';
const actions = historyFormatCases(target);

const init = (pageId: string, text: string, mode: 'live' | 'source' | 'preview', sourceLineNumbers: SourceLineNumberMode = 'on') => ({ type: 'init', pageId, documentId: `file:///basic-${mode}.md`, text, version: 1, savedRevision: { version: 1, text }, diagnostics: [], mode, uiLanguage: 'en', sourceLineNumbers, previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'light', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false, largeDocumentOptimizationEnabled: true, findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null });

async function open(browser: Browser, text: string, mode: 'live' | 'source' | 'preview', sourceLineNumbers: SourceLineNumberMode = 'on', observeStartup = false, persistedMode?: 'live' | 'source' | 'preview', stallPreviewPaint = false): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style><div id="app"><div class="mode-toolbar meo-preload-toolbar"></div><div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div></div>');
  await page.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
  await page.evaluate((mode) => (window as any).__initialUiState = mode ? { mode, lastEditableMode: 'live' } : undefined, persistedMode ?? null);
  if (stallPreviewPaint) await page.evaluate(() => {
    (window as any).__stalledFrames = 0;
    (window as any).__resumePreviewFrames = window.requestAnimationFrame.bind(window);
    (window as any).__pausedPreviewFrames = [];
    window.requestAnimationFrame = callback => {
      (window as any).__pausedPreviewFrames.push(callback);
      // Simulate a restored webview whose compositor has not resumed frame callbacks.
      (window as any).__stalledFrames += 1;
      return (window as any).__stalledFrames;
    };
  });
  await page.addScriptTag({ content: `
    window.__hostMessages=[];
    window.acquireVsCodeApi=()=>({
      postMessage(m) {
        window.__hostMessages.push(m);
        if (m.type === 'ready') window.__hostPageId = m.pageId;
        if(m.type !== 'requestPreviewRender') return;
        const html='<p>'+String(m.text).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</p>';
        queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{
          type:'previewRenderResult',requestId:m.requestId,
          result:{ok:true,value:{html,hasMermaid:false,styles:{light:'',dark:''}}}
        }})));
      },
      getState(){return window.__initialUiState},setState(state){window.__initialUiState=state}
    });
  ` });
  await page.addScriptTag({ path: path.join(temp, 'bundle.js') });
  await page.waitForFunction(() => typeof (window as any).__hostPageId === 'string');
  const pageId = await page.evaluate(() => (window as any).__hostPageId as string);
  if (observeStartup) {
    await page.evaluate(() => {
      (window as any).__startupFrames = [];
      const sample = () => {
        const wrapper = document.querySelector<HTMLElement>('.editor-wrapper');
        const editor = document.querySelector<HTMLElement>('.cm-editor');
        const preview = document.querySelector<HTMLElement>('.preview-host');
        (window as any).__startupFrames.push({
          revealed: wrapper ? getComputedStyle(wrapper).opacity !== '0' : false,
          rootMode: document.querySelector<HTMLElement>('#app')?.dataset.mode ?? null,
          editorMode: editor?.classList.contains('meo-mode-live') ? 'live'
            : editor?.classList.contains('meo-mode-source') ? 'source' : null,
          previewVisible: preview ? !preview.hidden : false
        });
        if (wrapper?.classList.contains('meo-preload-editor-shell')) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  }
  await page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), init(pageId, text, mode, sourceLineNumbers));
  await page.waitForSelector('.editor-host > .cm-editor');
  await page.waitForSelector('.editor-wrapper:not(.meo-preload-editor-shell)');
  if (mode !== 'preview') {
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.editor-host')!.inert
      && document.querySelector<HTMLElement>('.editor-loading')?.hidden !== false);
  } else if (!stallPreviewPaint) {
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-loading')?.hidden === true);
  }

  return page;
}

async function select(page: Page, text = target): Promise<void> {
  const points = await page.evaluate((needle) => {
    const line = [...document.querySelectorAll<HTMLElement>('.cm-line')].find((x) => x.textContent?.includes(needle));
    const walker = line ? document.createTreeWalker(line, NodeFilter.SHOW_TEXT) : null;
    let candidate: Node | null = walker?.nextNode() ?? null, node: Text | null = null;
    while (candidate) { if (candidate instanceof Text && candidate.textContent?.includes(needle)) { node = candidate; break; } candidate = walker?.nextNode() ?? null; }
    const value = node?.textContent ?? '', start = value.indexOf(needle);
    if (!node || start < 0) return null;
    const a = document.createRange(), b = document.createRange(); a.setStart(node, start); a.setEnd(node, start + 1); b.setStart(node, start + needle.length - 1); b.setEnd(node, start + needle.length);
    const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect(); return { a: [ar.left + 1, ar.top + ar.height / 2], b: [br.right - 1, br.top + br.height / 2] };
  }, text);
  assert.ok(points, `missing ${text}`); await page.mouse.move(...points.a); await page.mouse.down(); await page.mouse.move(...points.b, { steps: 4 }); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.selection-inline-menu')?.classList.contains('is-visible') === true);
}

const drafts = (page: Page) => page.evaluate(() => (window as any).__hostMessages.filter((m: any) => m.type === 'draftChanged').map((m: any) => m.text));

async function resolveMergeConflicts(browser: Browser): Promise<void> {
  for (const mode of ['source', 'live'] as const) for (const withBase of [false, true]) {
    const original = ['before', '<<<<<<< current', 'current value',
      ...(withBase ? ['||||||| base', 'base value'] : []),
      '=======', 'incoming value', '>>>>>>> incoming', 'after'].join('\n');
    for (const [action, replacement] of [
      ['current', 'current value'], ['incoming', 'incoming value'],
      ['both', 'current value\nincoming value']
    ]) {
      const page = await open(browser, original, mode);
      try {
        await page.waitForSelector('.meo-merge-actions');
        await page.click(`.meo-merge-action-btn[data-action="${action}"]`);
        const expected = `before\n${replacement}\nafter`;
        await page.waitForFunction(text => (window as any).__hostMessages
          .filter((message: any) => message.type === 'draftChanged').at(-1)?.text === text, {}, expected);
        assert.equal(await page.$('.meo-merge-actions'), null, 'Resolved conflict retained its controls');
        await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
        await page.waitForFunction(text => (window as any).__hostMessages
          .filter((message: any) => message.type === 'draftChanged').at(-1)?.text === text, {}, original);
        await page.waitForSelector('.meo-merge-actions');
        await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
        await page.waitForFunction(text => (window as any).__hostMessages
          .filter((message: any) => message.type === 'draftChanged').at(-1)?.text === text, {}, expected);
      } finally { await page.close(); }
    }
  }
}

async function matrix(browser: Browser): Promise<void> {
  const prefix = '# History witness\n\n';
  const receipts = ['source', 'live'].flatMap(mode => actions.map(([action]) => `inline ${mode}/${action}`));
  for (const mode of ['source', 'live'] as const) for (const [action, expected] of actions) {
    const original = prefix + target, formatted = prefix + expected;
    const label = `inline ${mode}/${action}`, surface = { witness: 'History witness' };
    const page = await open(browser, original, mode); try {
      await select(page);
      const before = await captureHistoryInteraction(page, surface);
      assert.deepEqual(before.ranges, [{ anchor: prefix.length, head: original.length }], label + ': select complete body');
      await page.click(`.selection-inline-button[data-action="${action}"]`);
      await page.waitForFunction((x) => (window as any).__hostMessages.some((m: any) => m.type === 'draftChanged' && m.text === x), {}, formatted); assert.deepEqual(await drafts(page), [formatted]);
      const after = await captureHistoryInteraction(page, surface);
      const range = formattedHistoryRange(action, expected, target, prefix.length);
      assert.deepEqual(after.ranges, [range], label + ': format selection');
      await assertHistoryRoundTrip(page, { ...surface, label, before, after });
      assert.deepEqual(await drafts(page), [formatted, original, formatted]);
    } finally { await page.close(); }
  }
  assertHistoryCoverage(receipts);
}

async function preview(browser: Browser): Promise<void> {
  const page = await open(browser, target, 'source'); try {
    await select(page); // Source baseline: the permanent page controller exposes its real menu.
    await page.click('[data-mode="live"]'); await page.waitForSelector('.editor-host .cm-editor.meo-mode-live'); const old = await page.$('.selection-inline-button[data-action="underline"]'); const oldRect = await old?.boundingBox(); const before = await drafts(page);
    await page.click('[data-mode="preview"]'); await page.waitForSelector('.preview-host:not([hidden]) .preview-frame'); await page.waitForFunction((needle) => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes(needle) === true, {}, target);
    const state = await page.evaluate(() => { const menu = document.querySelector<HTMLElement>('.selection-inline-menu')!, doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!, range = doc.createRange(); range.selectNodeContents(doc.body); const selection = doc.defaultView?.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); return { visible: menu.classList.contains('is-visible'), pointer: getComputedStyle(menu).pointerEvents, frameMenu: Boolean(doc.querySelector('.selection-inline-menu')), frameFormat: Boolean(doc.querySelector('[data-action],button')), copy: selection?.toString() ?? '', copied: doc.execCommand('copy') }; });
    assert.deepEqual({ ...state, copy: state.copy.includes(target) }, { visible: false, pointer: 'none', frameMenu: false, frameFormat: false, copy: true, copied: true });
    if (oldRect) await page.mouse.click(oldRect.x + oldRect.width / 2, oldRect.y + oldRect.height / 2); assert.deepEqual(await drafts(page), before);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload'))); assert.deepEqual(await drafts(page), before);
  } finally { await page.close(); }
}

async function alerts(browser: Browser): Promise<void> {
  const page = await open(browser, '> [!NOTE]\n> note body\n\n> [!UNKNOWN]\n> unknown body', 'live'); try {
    const point = await page.evaluate(() => { const line = [...document.querySelectorAll<HTMLElement>('.cm-line')].find((x) => x.textContent === '> unknown body'); const rect = line?.getBoundingClientRect(); return rect ? { x: rect.left + 8, y: rect.top + rect.height / 2 } : null; }); assert.ok(point, 'unknown alert body did not render'); await page.mouse.click(point.x, point.y); await page.waitForFunction(() => document.querySelectorAll('.meo-md-alert-icon').length === 1);
    const state = await page.evaluate(() => { const lines = [...document.querySelectorAll<HTMLElement>('.cm-line')]; const read = (text: string) => { const x = lines.find((line) => line.textContent === text)!; return { quote: x.classList.contains('meo-md-quote'), alert: x.classList.contains('meo-md-alert'), icon: Boolean(x.querySelector('.meo-md-alert-icon,.meo-md-alert-label')) }; }; return { directive: read('> [!UNKNOWN]'), body: read('> unknown body'), known: Boolean(document.querySelector('.meo-md-alert-note .meo-md-alert-icon')) }; });
    assert.deepEqual(state, { directive: { quote: true, alert: false, icon: false }, body: { quote: true, alert: false, icon: false }, known: true });
  } finally { await page.close(); }
}

async function blockquotePressLayout(browser: Browser): Promise<void> {
  const quoteText = '目标：在 Live 模式中像普通正文一样显示安全 HTML，不出现代码块式背景；Source 模式始终保留原始源码；Preview 与导出结果应保持一致。11111111111145544244224242424';
  const page = await open(browser, `# HTML 内容渲染与交互测试区\n\n> ${quoteText}\n\nHTML 测试区下方固定参照行`, 'live');
  const measure = () => page.evaluate((needle) => {
    const line = [...document.querySelectorAll<HTMLElement>('.cm-line')]
      .find((candidate) => candidate.textContent?.includes(needle));
    if (!line) return null;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const offset = node.data.indexOf(needle);
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      return {
        left: rect.left,
        x: rect.left + 3,
        y: rect.top + rect.height / 2,
        lineText: line.textContent ?? '',
        lineClass: line.className,
        paddingLeft: getComputedStyle(line).paddingLeft,
        textIndent: getComputedStyle(line).textIndent,
        editorPaddingLeft: getComputedStyle(document.querySelector<HTMLElement>('.cm-content')!).paddingLeft,
        childSignature: Array.from(line.childNodes).map((child) => (
          child instanceof HTMLElement ? `${child.tagName}.${child.className}` : '#text'
        ))
      };
    }
    return null;
  }, quoteText);
  try {
    await page.waitForFunction((needle) => {
      const line = [...document.querySelectorAll<HTMLElement>('.cm-line')]
        .find((candidate) => candidate.textContent?.includes(needle));
      return line?.classList.contains('meo-md-quote') === true &&
        line.firstElementChild?.classList.contains('meo-md-marker') === true;
    }, {}, quoteText);
    const before = await measure();
    assert.ok(before, 'Rendered blockquote content was not measurable before pointerdown');
    await page.mouse.move(before.x, before.y);
    await page.mouse.down();
    const pressedFrames = [];
    for (let frame = 0; frame < 4; frame += 1) {
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      pressedFrames.push(await measure());
    }
    await page.mouse.up();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const released = await measure();
    assert.ok(released, 'Rendered blockquote content was not measurable after pointerup');
    assert.ok(
      pressedFrames.every((frame) => frame && Math.abs(frame.left - before.left) <= 1) &&
      Math.abs(released.left - before.left) <= 1,
      `Pressing rendered blockquote text changed its content inset: ${JSON.stringify({ before, pressedFrames, released })}`
    );
  } finally {
    await page.mouse.up().catch(() => {});
    await page.close();
  }
}

async function alertPressLayout(browser: Browser): Promise<void> {
  const types = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
  const text = [
    'neutral anchor',
    '',
    ...types.flatMap((type) => [`> [!${type}]`, `> ${type.toLowerCase()} body`, ''])
  ].join('\n');
  const page = await open(browser, text, 'live');
  const measure = (needle: string) => page.evaluate((target) => {
    const line = [...document.querySelectorAll<HTMLElement>('.cm-line')]
      .find((candidate) => candidate.textContent?.includes(target));
    if (!line) return null;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const offset = node.data.indexOf(target);
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, x: rect.left + 3, y: rect.top + rect.height / 2 };
    }
    return null;
  }, needle);
  const measureLeadingMarker = (needle: string) => page.evaluate((target) => {
    const line = [...document.querySelectorAll<HTMLElement>('.cm-line')]
      .find((candidate) => candidate.textContent?.includes(target));
    if (!line) return null;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const offset = node.data.indexOf('>');
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      return range.getBoundingClientRect().left;
    }
    return null;
  }, needle);
  try {
    await page.waitForFunction((count) => document.querySelectorAll('.meo-md-alert-icon').length === count, {}, types.length);
    for (const type of types) {
      const activeMarkerLeft: number[] = [];
      for (const needle of [type, `${type.toLowerCase()} body`]) {
        const neutral = await measure('neutral anchor');
        assert.ok(neutral);
        await page.mouse.click(neutral.x, neutral.y);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        const before = await measure(needle);
        assert.ok(before, `Alert ${type} ${needle} was not measurable before pointerdown`);
        await page.mouse.move(before.x, before.y);
        await page.mouse.down();
        const pressedFrames = [];
        for (let frame = 0; frame < 4; frame += 1) {
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
          pressedFrames.push(await measure(needle));
        }
        await page.mouse.up();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        const released = await measure(needle);
        assert.ok(released);
        const activeLeft = pressedFrames[0]?.left;
        assert.equal(typeof activeLeft, 'number');
        assert.ok(
          pressedFrames.every((frame) => frame && Math.abs(frame.left - activeLeft) <= 1)
            && Math.abs(released.left - activeLeft) <= 1,
          `Pressing alert ${type} ${needle} produced intermediate layout movement: ${JSON.stringify({ before, pressedFrames, released })}`
        );
        if (needle !== type) {
          assert.ok(
            Math.abs(activeLeft - before.left) <= 1,
            `Pressing alert ${type} body changed its content inset: ${JSON.stringify({ before, pressedFrames, released })}`
          );
        }
        const markerLeft = await measureLeadingMarker(needle);
        assert.ok(markerLeft !== null, `Alert ${type} ${needle} did not expose its leading marker`);
        activeMarkerLeft.push(markerLeft);
      }
      assert.ok(
        Math.abs(activeMarkerLeft[0] - activeMarkerLeft[1]) <= 1,
        `Alert ${type} title and body markers were not aligned: ${JSON.stringify(activeMarkerLeft)}`
      );
    }
  } finally {
    await page.mouse.up().catch(() => {});
    await page.close();
  }
}

async function blockquoteEnterFirstFrame(browser: Browser): Promise<void> {
  const cases = [
    {
      name: 'blockquote',
      text: '> ordinary quote remains visually stable',
      target: 'visually',
      expectedClass: 'meo-md-quote'
    },
    {
      name: 'GitHub alert',
      text: '> [!TIP]\n> alert body remains visually stable',
      target: 'visually',
      expectedClass: 'meo-md-alert-tip'
    }
  ] as const;

  for (const testCase of cases) {
    const page = await open(browser, testCase.text, 'live');
    try {
      await page.waitForFunction((expectedClass) => (
        [...document.querySelectorAll<HTMLElement>('.cm-line')]
          .some((line) => line.textContent?.includes('visually') && line.classList.contains(expectedClass))
      ), {}, testCase.expectedClass);
      const point = await page.evaluate((target) => {
        const line = [...document.querySelectorAll<HTMLElement>('.cm-line')]
          .find((candidate) => candidate.textContent?.includes(target));
        const walker = line ? document.createTreeWalker(line, NodeFilter.SHOW_TEXT) : null;
        while (walker?.nextNode()) {
          const node = walker.currentNode as Text;
          const offset = node.data.indexOf(target);
          if (offset < 0) continue;
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + 1, y: rect.top + rect.height / 2 };
        }
        return null;
      }, testCase.target);
      assert.ok(point, `${testCase.name} split point was not measurable`);
      await page.mouse.click(point.x, point.y);
      const baselineLeft = await page.evaluate(() => {
        const line = [...document.querySelectorAll<HTMLElement>('.cm-line')]
          .find((candidate) => /remains|visually/.test(candidate.textContent ?? ''));
        if (!line) return null;
        const text = line.textContent ?? '';
        const contentOffset = text.search(/[A-Za-z]/);
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let traversed = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          if (contentOffset < traversed + node.length) {
            const range = document.createRange();
            range.setStart(node, contentOffset - traversed);
            range.setEnd(node, contentOffset - traversed + 1);
            return range.getBoundingClientRect().left;
          }
          traversed += node.length;
        }
        return null;
      });
      assert.equal(typeof baselineLeft, 'number', `${testCase.name} baseline was not measurable`);
      await page.evaluate(() => {
        (window as any).__blockquoteEnterFrames = [];
        const sample = () => {
          const lines = [...document.querySelectorAll<HTMLElement>('.cm-line')]
            .filter((candidate) => /remains|visually/.test(candidate.textContent ?? ''));
          const measurements = lines.map((line) => {
            const text = line.textContent ?? '';
            const contentOffset = text.search(/[A-Za-z]/);
            const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
            let traversed = 0;
            let contentLeft: number | null = null;
            while (walker.nextNode()) {
              const node = walker.currentNode as Text;
              if (contentOffset < traversed + node.length) {
                const range = document.createRange();
                range.setStart(node, contentOffset - traversed);
                range.setEnd(node, contentOffset - traversed + 1);
                contentLeft = range.getBoundingClientRect().left;
                break;
              }
              traversed += node.length;
            }
            return {
              text,
              classes: [...line.classList],
              contentLeft,
              markerClasses: [...line.querySelectorAll<HTMLElement>(':scope > span')]
                .map((element) => element.className)
            };
          });
          if (measurements.length > 0) (window as any).__blockquoteEnterFrames.push(measurements);
        };
        (window as any).__blockquoteEnterObserver = new MutationObserver(sample);
        (window as any).__blockquoteEnterObserver.observe(
          document.querySelector('.cm-content')!,
          { attributes: true, characterData: true, childList: true, subtree: true }
        );
      });
      await page.keyboard.press('Enter');
      await page.evaluate(async () => {
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      });
      const frames = await page.evaluate(() => {
        (window as any).__blockquoteEnterObserver.disconnect();
        return (window as any).__blockquoteEnterFrames as Array<Array<{
          text: string;
          classes: string[];
          contentLeft: number | null;
          markerClasses: string[];
        }>>;
      });
      const quotedFrames = frames.flat().filter((frame) => frame.text.trimStart().startsWith('>'));
      assert.ok(quotedFrames.length > 0, `${testCase.name} did not expose its continued line`);
      assert.ok(
        quotedFrames.every((frame) => frame.classes.includes(testCase.expectedClass)),
        `${testCase.name} exposed an unstyled first frame: ${JSON.stringify(frames)}`
      );
      assert.ok(
        quotedFrames.every((frame) => (
          frame.contentLeft !== null && Math.abs(frame.contentLeft - baselineLeft) <= 1
        )),
        `${testCase.name} changed indentation while Enter settled: ${JSON.stringify({ baselineLeft, frames })}`
      );
    } finally {
      await page.close();
    }
  }
}

async function sourceLineNumberPreference(browser: Browser): Promise<void> {
  const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
  const page = await open(browser, text, 'source', 'off');
  try {
    assert.equal(await page.$('.cm-lineNumbers'), null, 'Source must respect the native line-number setting');
    await page.click('[data-mode="live"]');
    await page.waitForFunction(() => document.querySelector('.editor-host .cm-editor')?.classList.contains('meo-mode-live') === true
      && document.querySelector('.cm-lineNumbers') === null);
    await page.click('[data-mode="source"]');
    await page.waitForFunction(() => document.querySelector('.editor-host .cm-editor')?.classList.contains('meo-mode-source') === true
      && document.querySelector('.cm-lineNumbers') === null);
  } finally {
    await page.close();
  }

  const expectedVisibleNumbers: Record<Exclude<SourceLineNumberMode, 'off'>, string[]> = {
    on: Array.from({ length: 12 }, (_, index) => String(index + 1)),
    relative: ['4', '3', '2', '1', '5', '1', '2', '3', '4', '5', '6', '7'],
    interval: ['1', '10']
  };
  for (const mode of ['on', 'relative', 'interval'] as const) {
    const modePage = await open(browser, text, 'source', mode);
    try {
      if (mode === 'relative') {
        const line = await modePage.$$('.cm-line').then((lines) => lines[4]);
        const rect = await line?.boundingBox();
        assert.ok(rect, 'relative line-number target was not visible');
        await modePage.mouse.click(rect.x + 12, rect.y + rect.height / 2);
      }
      const visible = await modePage.evaluate(() => Array.from(
        document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')
      ).map((element) => element.textContent ?? '').filter(Boolean).slice(-12));
      assert.deepEqual(visible, expectedVisibleNumbers[mode], `Source did not preserve ${mode} line-number semantics`);
    } finally {
      await modePage.close();
    }
  }
}

async function headingWeightPreference(browser: Browser): Promise<void> {
  const page = await open(browser, '# Heading\n\nBody', 'live');
  try {
    const selector = '.cm-line.meo-md-h1';
    await page.waitForSelector(selector);
    assert.equal(await page.$eval(selector, element => getComputedStyle(element).fontWeight), '700');
    await page.click('[data-action="settings"]');
    await page.click('.more-tools-settings-button');
    await page.waitForSelector('.settings-window[open]');
    await page.click('.settings-tab[data-tab="general"]');
    const option = '[data-setting="boldHeadings"] .settings-switch';
    assert.equal(await page.$eval(option, element => element.getAttribute('aria-label')), 'Bold headings');
    assert.equal(await page.$eval(option, element => element.getAttribute('aria-checked')), 'true');
    await page.click(option);
    await page.waitForFunction(() => getComputedStyle(document.querySelector<HTMLElement>('.cm-line.meo-md-h1')!).fontWeight === '400');
    assert.equal(await page.$eval(option, element => element.getAttribute('aria-checked')), 'false');
    await page.click(option);
    await page.waitForFunction(() => getComputedStyle(document.querySelector<HTMLElement>('.cm-line.meo-md-h1')!).fontWeight === '700');
    assert.deepEqual(await page.evaluate(() => (window as any).__hostMessages
      .filter((message: any) => message.type === 'setBoldHeadings')
      .map((message: any) => message.enabled)), [false, true]);
  } finally {
    await page.close();
  }
}

async function largeDocumentStartupPreference(browser: Browser): Promise<void> {
  const page = await open(browser, 'settings fixture', 'live');
  const option = '[data-setting="largeDocument"]';
  const toggle = option + ' [role="switch"]';
  const openPreferences = async () => {
    await page.click('[data-action="settings"]');
    await page.click('.more-tools-settings-button');
    await page.waitForSelector('.settings-window');
  };
  try {
    await openPreferences();
    assert.equal(await page.$eval(option + ' .settings-item-title', element => element.textContent),
      'Large document opening: prefer Source');
    assert.equal(await page.$eval(toggle, element => element.getAttribute('aria-checked')), 'true');
    const description = option + ' .settings-description';
    await page.$eval(description, element => element.scrollIntoView({ block: 'center' }));
    const descriptionState = await page.$eval(description, element => {
      const rect = element.getBoundingClientRect();
      return { text: element.textContent ?? '', top: rect.top, right: rect.right,
        bottom: rect.bottom, left: rect.left, visible: getComputedStyle(element).visibility };
    });
    assert.match(descriptionState.text, /Source mode/);
    assert.match(descriptionState.text, /last mode/);
    assert.match(descriptionState.text, /automatic performance optimizations remain active/);
    assert.equal(descriptionState.visible, 'visible');
    assert.ok(descriptionState.top >= 8 && descriptionState.right <= 992
      && descriptionState.bottom <= 692 && descriptionState.left >= 8,
      `Large-document description was clipped by the viewport: ${JSON.stringify(descriptionState)}`);
    if (process.env.MEO_TEST_SCREENSHOT) await page.screenshot({ path: process.env.MEO_TEST_SCREENSHOT });
    await page.click(toggle);
    assert.equal(await page.$eval(toggle, element => element.getAttribute('aria-checked')), 'false');
    const posted = await page.evaluate(() => (window as any).__hostMessages.filter(
      (message: any) => message.type === 'setLargeDocumentOptimization'
    ));
    assert.deepEqual(posted, [{ type: 'setLargeDocumentOptimization', enabled: false }]);
    await page.click('.settings-close');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'largeDocumentOptimizationChanged', enabled: true }
    })));
    await openPreferences();
    assert.equal(await page.$eval(toggle, element => element.getAttribute('aria-checked')), 'true');
  } finally {
    await page.close();
  }
}

async function startupModeVisibility(browser: Browser): Promise<void> {
  for (const mode of ['live', 'source', 'preview'] as const) {
    const page = await open(browser, `# ${mode} startup\n\nbody`, mode, 'on', true);
    try {
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const frames = await page.evaluate(() => (window as any).__startupFrames as Array<{
        revealed: boolean;
        rootMode: string | null;
        editorMode: string | null;
        previewVisible: boolean;
      }>);
      const revealed = frames.filter((frame) => frame.revealed);
      assert.ok(revealed.length > 0, `${mode} startup never revealed a frame`);
      assert.ok(revealed.every((frame) => frame.rootMode === mode), `${mode} exposed another mode: ${JSON.stringify(frames)}`);
      if (mode === 'preview') {
        assert.ok(revealed.every((frame) => frame.previewVisible), `Preview exposed its editor surface: ${JSON.stringify(frames)}`);
      } else {
        assert.ok(revealed.every((frame) => frame.editorMode === mode), `${mode} exposed another editor mode: ${JSON.stringify(frames)}`);
      }
    } finally {
      await page.close();
    }
  }
}

async function reopenedPreviewMode(browser: Browser): Promise<void> {
  const page = await open(browser, '# Reopened preview\n\nBody', 'preview', 'on', false, 'preview', true);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('.editor-surface')!;
      const rect = surface.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        selected: document.querySelector('button[data-mode="preview"]')?.getAttribute('aria-selected'),
        rootMode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
        editorHidden: document.querySelector<HTMLElement>('.editor-host')?.hidden,
        editorInert: document.querySelector<HTMLElement>('.editor-host')?.inert,
        editorCover: document.querySelector<HTMLElement>('.editor-host')?.hasAttribute('data-preview-cover'),
        previewHidden: document.querySelector<HTMLElement>('.preview-host')?.hidden,
        hitPreview: hit?.matches('.preview-frame') ?? false,
        loadingVisible: !document.querySelector<HTMLElement>('.preview-loading')?.hidden,
        previewText: document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes('Reopened preview') ?? false,
        stalledFrames: (window as any).__stalledFrames
      };
    });
    const { stalledFrames, ...presentation } = state;
    assert.ok(stalledFrames > 0, 'Preview paint frames were not stalled');
    assert.deepEqual(presentation, {
      selected: 'true', rootMode: 'preview', editorHidden: true,
      editorInert: true, editorCover: false, previewHidden: false,
      hitPreview: false, loadingVisible: true, previewText: true
    }, `Reopened Preview selected a noninteractive Live surface: ${JSON.stringify(state)}`);
    // With the compositor deliberately paused, the visible fallback is a Preview
    // loading surface. Resume real frames and require the completed surface to
    // become interactive without revealing its hidden editable carrier.
    await page.evaluate(() => { window.requestAnimationFrame = (window as any).__resumePreviewFrames;
      for (const callback of (window as any).__pausedPreviewFrames) window.requestAnimationFrame(callback);
      (window as any).__pausedPreviewFrames = []; });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-loading')?.hidden === true);
    assert.equal(await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('.editor-surface')!, rect = surface.getBoundingClientRect();
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.matches('.preview-frame')
        && document.querySelector<HTMLElement>('.editor-host')?.inert;
    }), true, 'Resumed Preview must expose its reading surface while keeping the editable carrier inert');
  } finally {
    await page.close();
  }
}

type EmbeddedWebview = {
  readonly host: Page;
  readonly webview: Frame;
};

async function openEmbeddedWebview(
  browser: Browser,
  text: string,
  mode: 'live' | 'source' | 'preview' = 'live'
): Promise<EmbeddedWebview> {
  const host = await browser.newPage();
  await host.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
  await host.setContent('<!doctype html><style>html,body,iframe{height:100%;width:100%;margin:0;border:0}</style><iframe></iframe>');
  await host.evaluate(() => {
    (window as any).__webviewHostMessages = [];
    (window as any).__webviewLifecycleEvents = [];
    window.addEventListener('message', event => {
      const data = event.data as { type?: string; message?: unknown; eventType?: string; persisted?: boolean } | null;
      if (data?.type === '__webviewHostMessage') (window as any).__webviewHostMessages.push(data.message);
      if (data?.type === '__webviewLifecycleEvent') {
        (window as any).__webviewLifecycleEvents.push({ type: data.eventType, persisted: data.persisted === true });
      }
    });
  });
  const webview = host.frames().find(frame => frame !== host.mainFrame());
  assert.ok(webview, 'Embedded webview iframe was not created');
  await webview.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style><div id="app"><div class="mode-toolbar meo-preload-toolbar"></div><div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div></div>');
  await webview.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
  await webview.evaluate(() => {
    for (const type of ['beforeunload', 'pagehide', 'unload']) {
      window.addEventListener(type, event => parent.postMessage({
        type: '__webviewLifecycleEvent', eventType: type,
        persisted: event instanceof PageTransitionEvent && event.persisted
      }, '*'));
    }
    (window as any).acquireVsCodeApi = () => ({
      postMessage(message: any) {
        // Mirrors the native close boundary: the Webview may still execute its
        // terminal owner after the Host can no longer receive Webview IPC.
        // Lifecycle probes deliberately use a different browser-only channel.
        if ((window as any).__dropWebviewHostMessages === true) return;
        parent.postMessage({ type: '__webviewHostMessage', message }, '*');
        if (message.type === 'workspaceDocumentsRequest') queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'workspaceDocumentsResult', requestId: message.requestId,
          result: { ok: true, value: { kind: 'catalog', current: 'file:///basic-live.md', complete: true, workspace: false, documents: [] } }
        } })));
        if (message.type === 'requestDocumentContent') queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'documentContentResult', requestId: message.requestId, result: { ok: true, value: { html: '<p>retained content</p>' } }
        } })));
        if (message.type === 'requestPreviewRender') queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'previewRenderResult', requestId: message.requestId,
          result: { ok: true, value: { html: '<p>retained preview</p>', hasMermaid: false, styles: { light: '', dark: '' } } }
        } })));
      },
      getState() { return undefined; }, setState() {}
    });
  });
  await webview.addScriptTag({ path: path.join(temp, 'bundle.js') });
  await host.waitForFunction(() => (window as any).__webviewHostMessages.some((message: any) => message.type === 'ready'));
  const pageId = await host.evaluate(() => (window as any).__webviewHostMessages
    .find((message: any) => message.type === 'ready').pageId as string);
  await webview.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), init(pageId, text, mode));
  await webview.waitForSelector('.editor-host > .cm-editor');
  await webview.waitForFunction(() => !document.querySelector<HTMLElement>('.editor-host')!.inert
    && document.querySelector<HTMLElement>('.editor-loading')?.hidden !== false
    && !document.querySelector('.meo-preload-toolbar'));
  return { host, webview };
}

const embeddedDrafts = (host: Page) => host.evaluate(() => (window as any).__webviewHostMessages
  .filter((message: any) => message.type === 'draftChanged'));

type EmbeddedDraft = {
  readonly type: 'draftChanged';
  readonly text: string | null;
  readonly baseVersion?: number;
  readonly conflictBaseText?: string;
  readonly terminal?: true;
  readonly receiptVersion: number;
};

const recoveryFingerprint = (message: EmbeddedDraft) => ({
  text: message.text,
  baseVersion: message.baseVersion,
  conflictBaseText: message.conflictBaseText,
  terminal: message.terminal === true,
  receiptVersion: message.receiptVersion
});

// Recovery receipts are not a last-value cache: an explicit null is a real
// clear and a terminal receipt is a separately classified close handoff. Keep
// those distinctions visible in every iframe production assertion.
function assertRecoveryReceiptShapes(recovery: readonly EmbeddedDraft[], label: string): void {
  for (let index = 0; index < recovery.length; index += 1) {
    const message = recovery[index]!;
    assert.equal(Number.isInteger(message.receiptVersion) && message.receiptVersion >= 0, true,
      `${label}: recovery receipt ${index} has no valid receipt version`);
    if (message.text === null) {
      assert.equal(message.terminal, undefined, `${label}: a clear receipt must never masquerade as terminal recovery`);
    } else {
      assert.equal(typeof message.baseVersion, 'number', `${label}: text recovery ${index} must name its Host base`);
      assert.equal(message.terminal === undefined || message.terminal === true, true,
        `${label}: recovery ${index} has an invalid terminal discriminator`);
    }
    if (index > 0) {
      assert.ok(message.receiptVersion >= recovery[index - 1]!.receiptVersion,
        `${label}: recovery receipt versions must not go backwards`);
    }
  }
}

function assertLatestRecoveryCandidate(
  recovery: readonly EmbeddedDraft[], expectedText: string, label: string, options: {
    readonly terminal?: boolean;
    readonly baseVersion?: number;
    readonly conflictBaseText?: string;
  } = {}
): EmbeddedDraft {
  assertRecoveryReceiptShapes(recovery, label);
  const message = recovery.at(-1);
  assert.ok(message, `${label}: expected a recovery receipt`);
  assert.equal(message.text, expectedText, `${label}: the latest receipt must retain the complete candidate`);
  assert.equal(message.terminal === true, options.terminal === true,
    `${label}: recovery terminal classification changed`);
  if (options.baseVersion !== undefined) assert.equal(message.baseVersion, options.baseVersion,
    `${label}: recovery must be based on the current Host revision`);
  if (options.conflictBaseText !== undefined) assert.equal(message.conflictBaseText, options.conflictBaseText,
    `${label}: recovery must retain the original conflict base`);
  return message;
}

async function retainedPageFunctionality(browser: Browser): Promise<void> {
  for (const large of [false, true]) {
    const text = '# Retained page\n\n```lifecycle\nblock content\n```\n' + (large ? '\nPadding.\n'.repeat(8100) : '');
    const { host, webview } = await openEmbeddedWebview(browser, text);
    try {
      const contributionErrors: string[] = [];
      host.on('console', message => { if (message.type() === 'error') contributionErrors.push(message.text()); });
      const entryUri = await webview.evaluate(() => URL.createObjectURL(new Blob([`
        export const apiVersion = 1;
        const note = (owner, action) => parent.postMessage({ type: '__webviewHostMessage', message: { type: 'fixtureContributionLifecycle', owner, action } }, '*');
        export function mount(container, context) {
          const witness = document.createElement('span'); witness.className = 'lifecycle-view-witness'; container.append(witness);
          const readWorkspace = async () => { await context.workspace.list('current'); witness.textContent = 'workspace available'; note('view', 'read'); };
          note('view', 'mount');
          return { update: readWorkspace, actions: [{ id: 'probe-workspace', label: 'Probe workspace', iconPaths: ['M0 0L1 1'], run: readWorkspace }], dispose() { note('view', 'dispose'); witness.remove(); } };
        }
        export function mountBlock(container, context) {
          const witness = document.createElement('span'); witness.className = 'lifecycle-block-witness'; container.append(witness); note('block', 'mount');
          return { async update(snapshot) { await context.renderContent(snapshot); witness.textContent = snapshot.text; note('block', 'update'); }, dispose() { note('block', 'dispose'); witness.remove(); } };
        }
      `], { type: 'text/javascript' })));
      await webview.evaluate(entryUri => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'documentViewsChanged', views: [{ id: 'fixture/lifecycle', label: 'Lifecycle', workspace: true,
          entryUri, codeBlockLanguages: ['lifecycle'] }]
      } })), entryUri);
      await webview.waitForFunction(() => document.querySelector('.meo-contributed-block')?.shadowRoot
        ?.querySelector('.lifecycle-block-witness')?.textContent?.trim() === 'block content', { timeout: 5000 });
      await webview.focus('.mm-view-entry[data-view-id="fixture/lifecycle"]');
      await host.keyboard.press('Enter');
      try {
        await webview.waitForFunction(() => document.querySelector('.lifecycle-view-witness')?.textContent === 'workspace available', { timeout: 3000 });
      } catch (error) {
        const state = await host.evaluate(() => (window as any).__webviewHostMessages);
        throw new Error(`Contributed view positive control failed: ${JSON.stringify({ contributionErrors, messages: state })}`, { cause: error });
      }
      const read = async (requestId: string) => {
        await webview.evaluate(requestId => window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'documentOperationRequest', requestId, operation: { kind: 'read' }
        } })), requestId);
        await host.waitForFunction(requestId => (window as any).__webviewHostMessages.some((message: any) =>
          message.type === 'documentOperationResult' && message.requestId === requestId), { timeout: 1500 }, requestId);
        const response = await host.evaluate(requestId => (window as any).__webviewHostMessages.find((message: any) =>
          message.type === 'documentOperationResult' && message.requestId === requestId), requestId);
        assert.deepEqual(response.result, { ok: true, value: { text } });
      };
      await read('before-persisted-pagehide');
      await webview.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await read('after-persisted-pagehide');
      assert.equal(await webview.$eval('.mm-view-panel', panel => (panel as HTMLElement).hidden), false);
      await webview.click('[data-view-action="probe-workspace"]');
      await host.waitForFunction(() => (window as any).__webviewHostMessages.filter((message: any) =>
        message.type === 'fixtureContributionLifecycle' && message.owner === 'view' && message.action === 'read').length === 2);
      await webview.evaluate(() => document.documentElement.style.setProperty('--meo-user-editor-font-size', '23px'));
      await webview.waitForFunction(() => (document.querySelector('.meo-contributed-block') as HTMLElement)
        ?.style.getPropertyValue('--meo-view-font-size') === '23px');
      const before = await host.evaluate(() => (window as any).__webviewHostMessages);
      assert.equal(before.filter((message: any) => message.type === 'workspaceDocumentsClose').length, 0);
      assert.equal(before.filter((message: any) => message.type === 'fixtureContributionLifecycle' && message.action === 'dispose').length, 0);
      await webview.evaluate(() => {
        window.dispatchEvent(new Event('beforeunload'));
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
        window.dispatchEvent(new Event('unload'));
      });
      await host.waitForFunction(() => (window as any).__webviewHostMessages.some((message: any) => message.type === 'workspaceDocumentsClose'));
      const after = await host.evaluate(() => (window as any).__webviewHostMessages);
      assert.equal(after.filter((message: any) => message.type === 'workspaceDocumentsClose').length, 1, 'terminal owner closes one workspace scope once');
      assert.equal(after.filter((message: any) => message.type === 'fixtureContributionLifecycle'
        && message.owner === 'view' && message.action === 'dispose').length, 1, 'terminal owner disposes the active view once');
      assert.equal(await webview.$('.mm-view-panel'), null, 'terminal owner removes contributed view resources');
      await webview.evaluate(uri => URL.revokeObjectURL(uri), entryUri);
    } finally { await host.close(); }
  }
}

async function pendingTableUnload(browser: Browser): Promise<void> {
  await retainedPageFunctionality(browser);
  for (const terminalEvent of ['beforeunload', 'iframe-removal'] as const)
    for (const large of [false, true]) for (const edited of [false, true]) {
    const text = '# Unload fixture\n\n| Name | Value |\n| --- | --- |\n| Alpha | base |\n' + (large ? '\nPadding.\n'.repeat(8100) : '');
    const { host, webview } = await openEmbeddedWebview(browser, text);
    try {
      const selector = 'tbody textarea[data-table-row="1"][data-table-col="1"]';
      if (edited) {
        await webview.click(selector);
        await host.keyboard.down('Control'); await host.keyboard.press('a'); await host.keyboard.up('Control');
        await host.keyboard.sendCharacter('pending-cell-value');
        assert.equal(await webview.$eval(selector, input => (input as HTMLTextAreaElement).value), 'pending-cell-value');
        const expected = text.replace('| Alpha | base |', '| Alpha | pending-cell-value |');
        // The recovery owner must acknowledge native input while CodeMirror and
        // the Host still own the old document; never turn this into a 250ms
        // early commit just to make close reliable.
        await webview.waitForFunction(({ expected, value }) => {
          const input = document.querySelector<HTMLTextAreaElement>('tbody textarea[data-table-row="1"][data-table-col="1"]');
          const content = document.querySelector('.editor-host .cm-content') as any;
          const currentText = content?.cmTile?.root?.view?.state.doc.toString();
          const messages = (parent as any).__webviewHostMessages as any[];
          if (!input || input.value !== value) throw new Error('Pending textarea changed before recovery delivery');
          if (typeof currentText !== 'string') throw new Error('Production CodeMirror document is unavailable');
          if (currentText.includes(value)) throw new Error('The 250ms native-table commit ran before recovery delivery');
          if (messages.some(message => message.type === 'applyChanges')) {
            throw new Error('Pending table recovery was incorrectly presented as a Host document edit');
          }
          const candidate = messages.some(message => message.type === 'draftChanged'
            && message.text === expected && message.terminal !== true);
          if (!candidate) return false;
          // Check each boundary again in the very task that observes the
          // candidate; otherwise a slow timer could make this test green.
          if (input.value !== value || currentText.includes(value)
            || messages.some(message => message.type === 'applyChanges')) {
            throw new Error('Pending table recovery changed ownership while admitting its receipt');
          }
          return true;
        }, { timeout: 1500 }, { expected, value: 'pending-cell-value' });
      }
      const beforeTermination = await embeddedDrafts(host) as EmbeddedDraft[];
      if (edited) {
        const expected = text.replace('| Alpha | base |', '| Alpha | pending-cell-value |');
        assertLatestRecoveryCandidate(beforeTermination, expected, `${terminalEvent}: proactive native recovery`, { terminal: false, baseVersion: 1 });
      } else {
        assert.deepEqual(beforeTermination, [], 'An unedited fixture must not create recovery state');
      }
      if (terminalEvent === 'beforeunload') {
        await webview.evaluate(() => {
          window.dispatchEvent(new Event('beforeunload'));
          window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
          window.dispatchEvent(new Event('unload'));
        });
      } else {
        await host.evaluate(() => document.querySelector('iframe')!.remove());
      }
      await host.evaluate(() => new Promise(resolve => setTimeout(resolve, 25)));
      const recovery = await embeddedDrafts(host) as EmbeddedDraft[];
      if (edited) {
        const expected = text.replace('| Alpha | base |', '| Alpha | pending-cell-value |');
        assert.ok(recovery.some(message => message.text === expected && message.terminal !== true),
          `${terminalEvent} must retain the nonterminal recovery owner`);
        assertLatestRecoveryCandidate(recovery, expected, `${terminalEvent}: terminal native recovery`, { terminal: true, baseVersion: 1 });
      } else {
        assert.deepEqual(recovery, [], `${terminalEvent} must leave an unedited document clean`);
      }
      const lifecycle = await host.evaluate(() => (window as any).__webviewLifecycleEvents);
      if (terminalEvent === 'iframe-removal') {
        assert.deepEqual(lifecycle.map((event: any) => event.type), ['pagehide', 'unload'],
          `Removing the iframe did not expose the expected terminal events: ${JSON.stringify(lifecycle)}`);
      }
      assert.deepEqual((await embeddedDrafts(host) as EmbeddedDraft[]).map(recoveryFingerprint), recovery.map(recoveryFingerprint),
        'Repeated terminal events must not publish another recovery receipt');
    } finally { await host.close(); }
  }

  // Native close can dispose the Host message listener before the Webview's
  // terminal owner runs. A confirmed textarea value must therefore reach the
  // Host recovery owner before that terminal IPC becomes unavailable. Keep the
  // table edit uncommitted: it is recovery traffic, not an early document edit.
  for (const large of [false, true]) {
    const text = '# Close delivery fixture\n\n| Name | Value |\n| --- | --- |\n| Alpha | base |\n'
      + (large ? '\nPadding.\n'.repeat(8100) : '');
    const expected = text.replace('| Alpha | base |', '| Alpha | pending-close-before-dispose |');
    const { host, webview } = await openEmbeddedWebview(browser, text);
    try {
      const selector = 'tbody textarea[data-table-row="1"][data-table-col="1"]';
      await webview.click(selector);
      await host.keyboard.down('Control'); await host.keyboard.press('a'); await host.keyboard.up('Control');
      await host.keyboard.sendCharacter('pending-close-before-dispose');
      assert.equal(await webview.$eval(selector, input => (input as HTMLTextAreaElement).value), 'pending-close-before-dispose');
      assert.equal(await webview.evaluate(() => {
        const content = document.querySelector('.editor-host .cm-content') as any;
        return content?.cmTile?.root?.view?.state.doc.toString().includes('pending-close-before-dispose');
      }), false, 'The recovery candidate must precede the 250ms native-table commit');
      assert.equal(await host.evaluate(() => (window as any).__webviewHostMessages.some((message: any) => message.type === 'applyChanges')), false,
        'The recovery candidate must not be presented as a Host document edit');
      await webview.waitForFunction(({ expected, value }) => {
        const input = document.querySelector<HTMLTextAreaElement>('tbody textarea[data-table-row="1"][data-table-col="1"]');
        const content = document.querySelector('.editor-host .cm-content') as any;
        const currentText = content?.cmTile?.root?.view?.state.doc.toString();
        const messages = (parent as any).__webviewHostMessages as any[];
        if (!input || input.value !== value) throw new Error('Pending textarea changed before recovery delivery');
        if (typeof currentText !== 'string') throw new Error('Production CodeMirror document is unavailable');
        if (currentText.includes(value)) throw new Error('The 250ms native-table commit ran before recovery delivery');
        if (messages.some(message => message.type === 'applyChanges')) {
          throw new Error('Pending table recovery was incorrectly presented as a Host document edit');
        }
        const candidate = messages.some(message => message.type === 'draftChanged'
          && message.text === expected && message.terminal !== true);
        if (!candidate) return false;
        // Recheck all user-visible ownership boundaries in the very task that
        // admits the recovery receipt, then close the IPC path before unload.
        if (input.value !== value || currentText.includes(value)
          || messages.some(message => message.type === 'applyChanges')) {
          throw new Error('Pending table recovery changed ownership while admitting its receipt');
        }
        (window as any).__dropWebviewHostMessages = true;
        return true;
      }, { timeout: 1500 }, { expected, value: 'pending-close-before-dispose' });
      const beforeTermination = await embeddedDrafts(host) as EmbeddedDraft[];
      assert.deepEqual(beforeTermination.map(recoveryFingerprint), [
        { text: expected, baseVersion: 1, conflictBaseText: undefined, terminal: false, receiptVersion: 1 }
      ], 'Exactly one current pending-cell recovery candidate must reach the Host before closing');
      await host.evaluate(() => document.querySelector('iframe')!.remove());
      await host.evaluate(() => new Promise(resolve => setTimeout(resolve, 25)));
      assert.deepEqual(await embeddedDrafts(host), beforeTermination,
        'No terminal Webview IPC may be required after the Host delivery boundary closes');
      const lifecycle = await host.evaluate(() => (window as any).__webviewLifecycleEvents);
      assert.deepEqual(lifecycle.map((event: any) => event.type), ['pagehide', 'unload'],
        `Removing the iframe did not expose the terminal close boundary: ${JSON.stringify(lifecycle)}`);
    } finally { await host.close(); }
  }

  const text = '# bfcache fixture\n\n| Name | Value |\n| --- | --- |\n| Alpha | base |\n';
  const { host, webview } = await openEmbeddedWebview(browser, text);
  try {
    const selector = 'tbody textarea[data-table-row="1"][data-table-col="1"]';
    await webview.click(selector);
    await host.keyboard.down('Control'); await host.keyboard.press('a'); await host.keyboard.up('Control');
    await host.keyboard.sendCharacter('pending-bfcache-value');
    const expected = text.replace('| Alpha | base |', '| Alpha | pending-bfcache-value |');
    await webview.waitForFunction(({ expected, value }) => {
      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea[data-table-row="1"][data-table-col="1"]');
      const content = document.querySelector('.editor-host .cm-content') as any;
      const currentText = content?.cmTile?.root?.view?.state.doc.toString();
      const messages = (parent as any).__webviewHostMessages as any[];
      if (!input || input.value !== value) throw new Error('Persisted-page textarea changed before recovery delivery');
      if (typeof currentText !== 'string') throw new Error('Production CodeMirror document is unavailable');
      if (currentText.includes(value)) throw new Error('Persisted pagehide allowed the 250ms table commit to run first');
      if (messages.some(message => message.type === 'applyChanges')) {
        throw new Error('Persisted-page recovery was incorrectly presented as a Host document edit');
      }
      const candidate = messages.some(message => message.type === 'draftChanged'
        && message.text === expected && message.terminal !== true);
      if (!candidate) return false;
      if (input.value !== value || currentText.includes(value)
        || messages.some(message => message.type === 'applyChanges')) {
        throw new Error('Persisted-page recovery changed ownership while admitting its receipt');
      }
      return true;
    }, { timeout: 1500 }, { expected, value: 'pending-bfcache-value' });
    const beforePersistedPagehide = await embeddedDrafts(host) as EmbeddedDraft[];
    assertLatestRecoveryCandidate(beforePersistedPagehide, expected, 'persisted pagehide: pre-event candidate', {
      terminal: false, baseVersion: 1
    });
    await webview.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    const afterPersistedPagehide = await embeddedDrafts(host) as EmbeddedDraft[];
    assert.deepEqual(afterPersistedPagehide.map(recoveryFingerprint), beforePersistedPagehide.map(recoveryFingerprint),
      'Persisted pagehide must preserve the current candidate and publish neither a clear nor a terminal receipt');
    assert.equal(await webview.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea[data-table-row="1"][data-table-col="1"]');
      const content = document.querySelector('.editor-host .cm-content') as any;
      return input?.value === 'pending-bfcache-value'
        && !content?.cmTile?.root?.view?.state.doc.toString().includes('pending-bfcache-value');
    }), true, 'Persisted pagehide must not transfer native input to CodeMirror');
    await webview.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    const recovery = await embeddedDrafts(host) as EmbeddedDraft[];
    assert.ok(recovery.some(message => message.text === expected && message.terminal !== true),
      'Persisted pagehide must retain the original nonterminal recovery candidate');
    assertLatestRecoveryCandidate(recovery, expected, 'later terminal after persisted pagehide', { terminal: true, baseVersion: 1 });
  } finally { await host.close(); }

  // An external Host revision can land between a browser-confirmed textarea
  // input and its 250ms CodeMirror commit. Exercise the real documentSession
  // message seam for both normal and 8100-line documents: the old native DOM
  // is replaced, so only the recovery owner can retain the pending local cell.
  for (const large of [false, true]) for (const overlap of [false, true]) {
    const text = '# Native external fixture\n\n| Name | Value |\n| --- | --- |\n| Alpha | base |\n'
      + (large ? '\nPadding.\n'.repeat(8100) : '');
    const localValue = overlap ? 'pending-overlap-local' : 'pending-disjoint-local';
    const localText = text.replace('| Alpha | base |', `| Alpha | ${localValue} |`);
    const remoteText = overlap
      ? text.replace('| Alpha | base |', '| Alpha | remote-overlap-host |')
      : text.replace('# Native external fixture', '# Native external fixture remote-title');
    const mergedText = overlap
      ? localText
      : remoteText.replace('| Alpha | base |', `| Alpha | ${localValue} |`);
    const { host, webview } = await openEmbeddedWebview(browser, text);
    try {
      const selector = 'tbody textarea[data-table-row="1"][data-table-col="1"]';
      await webview.click(selector);
      await host.keyboard.down('Control'); await host.keyboard.press('a'); await host.keyboard.up('Control');
      if (!large && !overlap) {
        // Real successive input callbacks must rebase the whole native word,
        // while each recovery message still carries only its latest delta.
        await host.keyboard.type(localValue, { delay: 5 });
      } else {
        await host.keyboard.sendCharacter(localValue);
      }
      await webview.waitForFunction(({ localText, localValue }) => {
        const input = document.querySelector<HTMLTextAreaElement>('tbody textarea[data-table-row="1"][data-table-col="1"]');
        const content = document.querySelector('.editor-host .cm-content') as any;
        const currentText = content?.cmTile?.root?.view?.state.doc.toString();
        const messages = (parent as any).__webviewHostMessages as any[];
        if (!input || input.value !== localValue) throw new Error('Pending textarea changed before external-revision recovery delivery');
        if (typeof currentText !== 'string') throw new Error('Production CodeMirror document is unavailable');
        if (currentText.includes(localValue)) throw new Error('The 250ms native-table commit ran before external-revision recovery delivery');
        if (messages.some(message => message.type === 'applyChanges')) {
          throw new Error('Pending native recovery was incorrectly submitted before the external revision');
        }
        const candidate = messages.some(message => message.type === 'draftChanged'
          && message.text === localText && message.terminal !== true);
        if (!candidate) return false;
        if (input.value !== localValue || currentText.includes(localValue)
          || messages.some(message => message.type === 'applyChanges')) {
          throw new Error('Pending native recovery changed ownership while admitting its receipt');
        }
        (window as any).__nativeInputBeforeExternalRevision = input;
        return true;
      }, { timeout: 1500 }, { localText, localValue });
      const beforeExternal = await embeddedDrafts(host) as EmbeddedDraft[];
      const firstCandidate = assertLatestRecoveryCandidate(beforeExternal, localText,
        `${large ? 'large' : 'ordinary'} ${overlap ? 'overlap' : 'disjoint'}: pre-external candidate`, {
          terminal: false, baseVersion: 1
        });
      await webview.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'docChanged', text: remoteText, version: 2
      });

      // A conflict keeps P as the current Document Session Draft. The Webview
      // must present that model, while R remains the newer Host/disk revision
      // protected by conflict metadata rather than being written back.
      const expectedEditorText = overlap ? localText : mergedText;
      await webview.waitForFunction(expectedEditorText => {
        const content = document.querySelector('.editor-host .cm-content') as any;
        return content?.cmTile?.root?.view?.state.doc.toString() === expectedEditorText;
      }, { timeout: 1500 }, expectedEditorText);
      assert.equal(await webview.$eval(selector, (input, value) => input.isConnected
        && (input as HTMLTextAreaElement).value === value, localValue), true,
        'The current rendered cell must retain its local value across external presentation or DOM reuse');
      assert.equal(await host.evaluate(() => (window as any).__webviewHostMessages.some((message: any) => message.type === 'applyChanges')), false,
        'External revision rebase must never submit a pending native table cell as a Host document edit');

      await host.waitForFunction(({ expectedText, overlap }) => {
        const messages = (window as any).__webviewHostMessages as any[];
        const latest = messages.filter(message => message.type === 'draftChanged').at(-1);
        return latest?.text === expectedText && latest?.baseVersion === 2
          && latest?.terminal !== true
          && (overlap ? latest?.conflictBaseText !== undefined : latest?.conflictBaseText === undefined);
      }, { timeout: 1500 }, { expectedText: mergedText, overlap });
      const afterExternal = await embeddedDrafts(host) as EmbeddedDraft[];
      assert.ok(afterExternal.length > beforeExternal.length,
        'The external revision must publish a newer recovery receipt rather than silently retaining an old base');
      const latest = assertLatestRecoveryCandidate(afterExternal, mergedText,
        `${large ? 'large' : 'ordinary'} ${overlap ? 'overlap' : 'disjoint'}: post-external candidate`, {
          terminal: false,
          baseVersion: 2,
          ...(overlap ? { conflictBaseText: text } : {})
        });
      assert.ok(latest.receiptVersion > firstCandidate.receiptVersion,
        'The post-external recovery candidate must supersede the pre-external receipt');
      if (overlap) {
        await webview.waitForFunction(() => {
          const notice = document.querySelector<HTMLElement>('.editor-notice');
          return notice?.hidden === false && notice.textContent?.includes('External change detected') === true;
        }, { timeout: 1500 });
        assert.equal(await webview.evaluate(() => {
          const content = document.querySelector('.editor-host .cm-content') as any;
          const current = content?.cmTile?.root?.view?.state.doc.toString();
          return current?.includes('pending-overlap-local')
            && !current?.includes('remote-overlap-host');
        }), true, 'An overlapping external revision must present the current conflicting Draft, not a stale Host mirror');

        // One ordinary-document continuation is sufficient to prove that the
        // replacement did not leave a one-shot conflict projection behind.
        // Its next projection and a return to P must both keep A and R; neither
        // may write R back through applyChanges before conflict resolution.
        if (!large) {
          const nextLocalValue = 'pending-overlap-next';
          const nextLocalText = text.replace('| Alpha | base |', `| Alpha | ${nextLocalValue} |`);
          await webview.click(selector);
          await host.keyboard.down('Control'); await host.keyboard.press('a'); await host.keyboard.up('Control');
          await host.keyboard.sendCharacter(nextLocalValue);
          await webview.waitForFunction(({ expectedText, baseText, value, selector }) => {
            const input = document.querySelector<HTMLTextAreaElement>(selector);
            const content = document.querySelector('.editor-host .cm-content') as any;
            const currentText = content?.cmTile?.root?.view?.state.doc.toString();
            const messages = (parent as any).__webviewHostMessages as any[];
            if (!input || input.value !== value) throw new Error('Same-cell conflict textarea changed before recovery delivery');
            if (typeof currentText !== 'string') throw new Error('Production CodeMirror document is unavailable');
            if (currentText.includes(value)) throw new Error('Same-cell conflict input committed before protected recovery delivery');
            const latest = messages.filter(message => message.type === 'draftChanged').at(-1);
            const accepted = latest?.text === expectedText && latest?.baseVersion === 2
              && latest?.conflictBaseText === baseText && latest?.terminal !== true
              && !messages.some(message => message.type === 'applyChanges');
            if (!accepted) return false;
            if (input.value !== value || currentText.includes(value)
              || messages.some(message => message.type === 'applyChanges')) {
              throw new Error('Same-cell conflict recovery changed ownership while admitting its receipt');
            }
            return true;
          }, { timeout: 1500 }, { expectedText: nextLocalText, baseText: text, value: nextLocalValue, selector }).catch(async error => {
            const snapshot = await webview.evaluate(selector => {
              const content = document.querySelector('.editor-host .cm-content') as any;
              return { text: content?.cmTile?.root?.view?.state.doc.toString(),
                value: document.querySelector<HTMLTextAreaElement>(selector)?.value,
                messages: ((parent as any).__webviewHostMessages as any[])
                  .filter(message => ['draftChanged', 'draftPatched', 'applyChanges'].includes(message.type)).slice(-6) };
            }, selector);
            throw new Error(`Conflict continuation did not preserve recovery: ${JSON.stringify(snapshot)}`, { cause: error });
          });
          const afterNextNativeInput = await embeddedDrafts(host) as EmbeddedDraft[];
          assertLatestRecoveryCandidate(afterNextNativeInput, nextLocalText, 'overlap: same-cell follow-up candidate', {
            terminal: false, baseVersion: 2, conflictBaseText: text
          });

          await webview.click(selector);
          await host.keyboard.down('Control'); await host.keyboard.press('a'); await host.keyboard.up('Control');
          await host.keyboard.sendCharacter(localValue);
          await webview.waitForFunction(({ expectedText, baseText, value, selector }) => {
            const input = document.querySelector<HTMLTextAreaElement>(selector);
            const content = document.querySelector('.editor-host .cm-content') as any;
            const currentText = content?.cmTile?.root?.view?.state.doc.toString();
            const messages = (parent as any).__webviewHostMessages as any[];
            if (!input || input.value !== value) throw new Error('Returned same-cell conflict textarea changed before recovery delivery');
            if (typeof currentText !== 'string') throw new Error('Production CodeMirror document is unavailable');
            if (currentText !== expectedText) throw new Error('Returned same-cell conflict input diverged from the current conflicting Draft');
            const latest = messages.filter(message => message.type === 'draftChanged').at(-1);
            const accepted = latest?.text === expectedText && latest?.baseVersion === 2
              && latest?.conflictBaseText === baseText && latest?.terminal !== true
              && !messages.some(message => message.type === 'applyChanges');
            if (!accepted) return false;
            if (input.value !== value || currentText !== expectedText
              || messages.some(message => message.type === 'applyChanges')) {
              throw new Error('Returned same-cell conflict recovery changed ownership while admitting its receipt');
            }
            return true;
          }, { timeout: 1500 }, { expectedText: localText, baseText: text, value: localValue, selector });
          const afterReturningToOriginal = await embeddedDrafts(host) as EmbeddedDraft[];
          assertLatestRecoveryCandidate(afterReturningToOriginal, localText, 'overlap: same-cell return candidate', {
            terminal: false, baseVersion: 2, conflictBaseText: text
          });
        }
      } else {
        assert.equal(await webview.evaluate(() => {
          const content = document.querySelector('.editor-host .cm-content') as any;
          const current = content?.cmTile?.root?.view?.state.doc.toString();
          return current?.includes('pending-disjoint-local') && current?.includes('remote-title');
        }), true, 'A disjoint external revision must present both the Host change and pending native cell');

        // The rebase presentation itself must be one real history entry. Do
        // not dispatch a synthetic CodeMirror change: exercise the same native
        // cell and keyboard path users use after the external replacement.
        if (!large) {
          const applyChangesBeforeHistory = await host.evaluate(() => (window as any).__webviewHostMessages
            .filter((message: any) => message.type === 'applyChanges').length);
          await webview.click(selector);
          await host.keyboard.down('Control'); await host.keyboard.press('z'); await host.keyboard.up('Control');
          await webview.waitForFunction(({ expectedText, expectedValue, selector }) => {
            const content = document.querySelector('.editor-host .cm-content') as any;
            const input = document.querySelector<HTMLTextAreaElement>(selector);
            return content?.cmTile?.root?.view?.state.doc.toString() === expectedText
              && document.activeElement === input && input?.value === expectedValue
              && input.selectionStart !== null && input.selectionEnd !== null;
          }, { timeout: 1500 }, { expectedText: remoteText, expectedValue: 'base', selector });
          await host.keyboard.down('Control'); await host.keyboard.press('y'); await host.keyboard.up('Control');
          await webview.waitForFunction(({ expectedText, expectedValue, selector }) => {
            const content = document.querySelector('.editor-host .cm-content') as any;
            const input = document.querySelector<HTMLTextAreaElement>(selector);
            return content?.cmTile?.root?.view?.state.doc.toString() === expectedText
              && document.activeElement === input && input?.value === expectedValue
              && input.selectionStart !== null && input.selectionEnd !== null;
          }, { timeout: 1500 }, { expectedText: mergedText, expectedValue: localValue, selector });
          await host.waitForFunction(start => (window as any).__webviewHostMessages
            .filter((message: any) => message.type === 'applyChanges').length > start,
          { timeout: 1500 }, applyChangesBeforeHistory);
          const historyApplies = await host.evaluate(start => (window as any).__webviewHostMessages
            .filter((message: any) => message.type === 'applyChanges').slice(start), applyChangesBeforeHistory);
          // This fixture deliberately has no Host applied acknowledgement. A
          // user-requested redo is therefore allowed to commit one current-base
          // change; it must transform R into R+P, never replay old source A.
          assert.equal(historyApplies.length, 1, 'Redo must submit exactly one current-base change without a Host acknowledgement');
          assert.equal(historyApplies[0]?.baseVersion, 2, 'Redo must target the external Host revision R, not old source A');
          const replayedHostText = [...historyApplies[0]!.changes].sort((left: any, right: any) => right.from - left.from)
            .reduce((current: string, change: any) => current.slice(0, change.from) + change.insert + current.slice(change.to), remoteText);
          assert.equal(replayedHostText, mergedText,
            'Redo changes must preserve the external prefix and reconstruct exactly R+P');
          const afterHistoryReplay = await embeddedDrafts(host) as EmbeddedDraft[];
          assertLatestRecoveryCandidate(afterHistoryReplay, mergedText, 'disjoint rebase redo recovery', {
            terminal: false, baseVersion: 2
          });
        }
      }
    } finally { await host.close(); }
  }
}

async function pendingTablePresentationBoundaries(browser: Browser): Promise<void> {
  for (const large of [false, true]) for (const failed of [false, true]) {
    const text = '# Native presentation boundary\n\n| Name | Value |\n| --- | --- |\n| Alpha | base |\n'
      + (large ? '\nPadding.\n'.repeat(8100) : '');
    const value = 'confirmed-presentation-input';
    const localText = text.replace('| Alpha | base |', `| Alpha | ${value} |`);
    const remoteText = failed ? text.replace('| Alpha | base |', '| Alpha | remote-conflict |') : localText;
    const { host, webview } = await openEmbeddedWebview(browser, text);
    const selector = 'tbody textarea[data-table-row="1"][data-table-col="1"]';
    try {
      await webview.click(selector);
      await host.keyboard.down('Control'); await host.keyboard.press('a'); await host.keyboard.up('Control');
      await host.keyboard.sendCharacter(value);
      await webview.waitForFunction(({ value, selector, localText }) => {
        const view = (document.querySelector('.editor-host .cm-content') as any)?.cmTile?.root?.view;
        const messages = (parent as any).__webviewHostMessages;
        if (view?.state.doc.toString() === localText) throw new Error('Native boundary committed before the external presentation');
        return document.querySelector<HTMLTextAreaElement>(selector)?.value === value
          && messages.some((message: any) => message.type === 'draftChanged' && message.text === localText);
      }, { timeout: 1500 }, { value, selector, localText });
      if (failed) await webview.evaluate(localText => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        const dispatch = view.dispatch.bind(view);
        let failPresentation = false;
        (window as any).__nativeHistoryCommits = 0;
        document.addEventListener('meo-table-selection-external-presentation', () => { failPresentation = true; }, { once: true });
        view.dispatch = (...args: any[]) => {
          if (failPresentation) throw new Error('forced presentation failure after confirmed native history');
          const before = view.state.doc;
          const result = dispatch(...args);
          if (before !== view.state.doc && view.state.doc.toString() === localText) {
            (window as any).__nativeHistoryCommits++;
          }
          return result;
        };
        (window as any).__restoreNativePresentation = () => { view.dispatch = dispatch; };
      }, localText);
      await webview.evaluate(remoteText => window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'docChanged', version: 2, text: remoteText }
      })), remoteText);
      if (failed) {
        await webview.waitForSelector('.editor-notice-action[data-action="retry-document-update"]', { timeout: 2000 });
        await host.waitForFunction(localText => (window as any).__webviewHostMessages
          .filter((message: any) => message.type === 'draftChanged').at(-1)?.text === localText,
        { timeout: 1500 }, localText);
        assert.equal(await webview.evaluate(() => (window as any).__nativeHistoryCommits), 1,
          'Automatic failed presentations must commit the confirmed native history once');
        await webview.evaluate(() => (window as any).__restoreNativePresentation());
        await webview.click('.editor-notice-action[data-action="retry-document-update"]');
        await webview.waitForFunction(() => document.querySelector<HTMLElement>('.editor-notice')?.hidden === true,
          { timeout: 2000 });
      } else {
        await host.waitForFunction(() => (window as any).__webviewHostMessages
          .filter((message: any) => message.type === 'draftChanged').at(-1)?.text === null, { timeout: 1500 });
      }
      await webview.waitForFunction(localText => (document.querySelector('.editor-host .cm-content') as any)
        ?.cmTile?.root?.view?.state.doc.toString() === localText, { timeout: 1500 }, localText);
      assert.equal(await host.evaluate(() => (window as any).__webviewHostMessages
        .some((message: any) => message.type === 'applyChanges')), false,
      'Host convergence or presentation retry must not submit the old native source');
      await webview.click('.editor-host .cm-content');
      await host.keyboard.down('Control'); await host.keyboard.press('z'); await host.keyboard.up('Control');
      await webview.waitForFunction(text => (document.querySelector('.editor-host .cm-content') as any)
        ?.cmTile?.root?.view?.state.doc.toString() === text, { timeout: 1500 }, text);
      await host.keyboard.down('Control'); await host.keyboard.press('y'); await host.keyboard.up('Control');
      await webview.waitForFunction(localText => (document.querySelector('.editor-host .cm-content') as any)
        ?.cmTile?.root?.view?.state.doc.toString() === localText, { timeout: 1500 }, localText);
    } finally { await host.close(); }
  }
}

async function main() { const build = await Bun.build({ entrypoints: [path.join(root, 'scripts', 'test-basic-capability-index-entry.ts')], outdir: temp, target: 'browser', format: 'iife', naming: 'bundle.js' }); if (!build.success) throw new Error(build.logs.map(String).join('\n')); const browser = await launchTestBrowser(); try { if (process.argv.includes('--unload-only')) { await pendingTableUnload(browser); await pendingTablePresentationBoundaries(browser); } else if (process.argv.includes('--history-only')) { await matrix(browser); } else { await pendingTableUnload(browser); await pendingTablePresentationBoundaries(browser); await startupModeVisibility(browser); await reopenedPreviewMode(browser); await blockquotePressLayout(browser); await alertPressLayout(browser); await blockquoteEnterFirstFrame(browser); await matrix(browser); await resolveMergeConflicts(browser); await preview(browser); await alerts(browser); await sourceLineNumberPreference(browser); await headingWeightPreference(browser); await largeDocumentStartupPreference(browser); } } finally { await browser.close(); } console.log('Basic capability production matrix passed'); }
main().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
