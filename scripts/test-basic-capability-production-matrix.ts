import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import type { SourceLineNumberMode } from '../src/protocol/readyInit';

const root = path.resolve(import.meta.dir, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-basic-capability-index-'));
const target = 'format target';
const actions = [['bold', `**${target}**`], ['italic', `*${target}*`], ['lineover', `~~${target}~~`], ['highlight', `==${target}==`], ['inlineCode', `\`${target}\``], ['link', `[${target}]()`], ['wikiLink', `[[${target}]]`], ['kbd', `<kbd>${target}</kbd>`], ['underline', `<u>${target}</u>`]] as const;

const init = (text: string, mode: 'live' | 'source' | 'preview', sourceLineNumbers: SourceLineNumberMode = 'on') => ({ type: 'init', documentId: `file:///basic-${mode}.md`, text, version: 1, savedRevision: { version: 1, text }, diagnostics: [], mode, uiLanguage: 'en', sourceLineNumbers, previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'light', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false, largeDocumentOptimizationEnabled: true, findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null });

async function open(browser: Browser, text: string, mode: 'live' | 'source' | 'preview', sourceLineNumbers: SourceLineNumberMode = 'on', observeStartup = false, persistedMode?: 'live' | 'source' | 'preview', stallPreviewPaint = false): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style><div id="app"><div class="mode-toolbar meo-preload-toolbar"></div><div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div></div>');
  await page.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
  await page.evaluate((mode) => (window as any).__initialUiState = mode ? { mode, lastEditableMode: 'live' } : undefined, persistedMode ?? null);
  if (stallPreviewPaint) await page.evaluate(() => {
    (window as any).__stalledFrames = 0;
    window.requestAnimationFrame = () => {
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
  await page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), init(text, mode, sourceLineNumbers));
  await page.waitForSelector('.editor-host > .cm-editor');
  await page.waitForSelector('.editor-wrapper:not(.meo-preload-editor-shell)');
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
  for (const mode of ['source', 'live'] as const) for (const [action, expected] of actions) {
    const page = await open(browser, target, mode); try {
      await select(page); await page.click(`.selection-inline-button[data-action="${action}"]`);
      await page.waitForFunction((x) => (window as any).__hostMessages.some((m: any) => m.type === 'draftChanged' && m.text === x), {}, expected); assert.deepEqual(await drafts(page), [expected]);
      await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await page.waitForFunction((x) => (window as any).__hostMessages.filter((m: any) => m.type === 'draftChanged').at(-1)?.text === x, {}, target);
      await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control'); await page.waitForFunction((x) => (window as any).__hostMessages.filter((m: any) => m.type === 'draftChanged').at(-1)?.text === x, {}, expected); assert.deepEqual(await drafts(page), [expected, target, expected]);
    } finally { await page.close(); }
  }
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
    const option = '[data-action="boldHeadings"]';
    assert.equal(await page.$eval(option, element => element.querySelector('.more-tools-option-label')?.textContent), 'Bold headings');
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
  try {
    await page.click('[data-action="settings"]');
    const option = await page.$('[data-action="largeDocumentOptimization"]');
    assert.ok(option, 'Large-document startup option was not present');
    assert.equal(
      await option.evaluate((element) => element.querySelector('.more-tools-option-label')?.textContent),
      'Open large documents faster'
    );
    await page.hover('[data-action="largeDocumentOptimization"] .more-tools-option-info');
    await page.waitForFunction(() => getComputedStyle(
      document.querySelector<HTMLElement>('#large-document-startup-tooltip')!
    ).visibility === 'visible');
    const tooltip = await page.$eval('#large-document-startup-tooltip', (element) => element.textContent ?? '');
    assert.match(tooltip, /Source mode/);
    const tooltipBounds = await page.$eval('#large-document-startup-tooltip', (element) => {
      const rect = element.getBoundingClientRect();
      const panelRect = element.closest('.more-tools-panel')!.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        panelTop: panelRect.top,
        panelRight: panelRect.right,
        panelBottom: panelRect.bottom,
        panelLeft: panelRect.left
      };
    });
    assert.ok(
      tooltipBounds.top >= tooltipBounds.panelTop
        && tooltipBounds.right <= tooltipBounds.panelRight
        && tooltipBounds.bottom <= tooltipBounds.panelBottom
        && tooltipBounds.left >= tooltipBounds.panelLeft,
      `Large-document tooltip was clipped by the settings panel: ${JSON.stringify(tooltipBounds)}`
    );
    await page.click('[data-action="largeDocumentOptimization"] .more-tools-option-label');
    const posted = await page.evaluate(() => (window as any).__hostMessages.filter(
      (message: any) => message.type === 'setLargeDocumentOptimization'
    ));
    assert.deepEqual(posted, [{ type: 'setLargeDocumentOptimization', enabled: false }]);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'largeDocumentOptimizationChanged', enabled: true }
    })));
    await page.waitForFunction(() => document.querySelector('[data-action="largeDocumentOptimization"]')
      ?.getAttribute('aria-checked') === 'true');
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
        previewText: document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes('Reopened preview') ?? false,
        stalledFrames: (window as any).__stalledFrames
      };
    });
    const { stalledFrames, ...presentation } = state;
    assert.ok(stalledFrames > 0, 'Preview paint frames were not stalled');
    assert.deepEqual(presentation, {
      selected: 'true', rootMode: 'preview', editorHidden: true,
      editorInert: true, editorCover: false, previewHidden: false,
      hitPreview: true, previewText: true
    }, `Reopened Preview selected a noninteractive Live surface: ${JSON.stringify(state)}`);
  } finally {
    await page.close();
  }
}
async function main() { const build = await Bun.build({ entrypoints: [path.join(root, 'scripts', 'test-basic-capability-index-entry.ts')], outdir: temp, target: 'browser', format: 'iife', naming: 'bundle.js' }); if (!build.success) throw new Error(build.logs.map(String).join('\n')); const browser = await launchTestBrowser(); try { await startupModeVisibility(browser); await reopenedPreviewMode(browser); await blockquotePressLayout(browser); await alertPressLayout(browser); await blockquoteEnterFirstFrame(browser); await matrix(browser); await resolveMergeConflicts(browser); await preview(browser); await alerts(browser); await sourceLineNumberPreference(browser); await headingWeightPreference(browser); await largeDocumentStartupPreference(browser); } finally { await browser.close(); } console.log('Basic capability production matrix passed'); }
main().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
