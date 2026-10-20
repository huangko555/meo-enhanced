import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import type { Frame, Page } from 'puppeteer-core';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const text = 'alpha beta\n\nA document selection witness.\n\n| Cell |\n| --- |\n| Table selection |\n\n' + 'More reading content.\n\n'.repeat(30);
const build = await Bun.build({ entrypoints: ['scripts/test-settings-window-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
await mkdir('.local/focus-return-production', { recursive: true });
const browser = await launchTestBrowser();
let primaryError: unknown;

async function chord(page: Page, key: string): Promise<void> {
  await page.keyboard.down('Control');
  try { await page.keyboard.press(key); } finally { await page.keyboard.up('Control'); }
}

async function leave(page: Page, frame: Frame, selector: string): Promise<void> {
  await page.focus('#host-control');
  assert.equal(await frame.evaluate(() => document.hasFocus()), false);
  await frame.evaluate(selector => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
    const input = document.querySelector<HTMLInputElement>(selector)!;
    input.blur();
    // Model a native activation that loses the DOM range, rather than passing
    // merely because Chromium happened to retain it without our controller.
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollLeft = 0;
  }, selector);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'host-control', 'a Host hint must not steal Workbench focus');
}

async function returnToFrame(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#webview')!.contentWindow!.focus());
}

async function readInput(frame: Frame, selector: string) {
  return frame.evaluate(selector => {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    return { focused: document.activeElement === input, value: input.value, start: input.selectionStart, end: input.selectionEnd,
      direction: input.selectionDirection, scrollLeft: input.scrollLeft };
  }, selector);
}

async function readEditor(frame: Frame) {
  return frame.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    const selection = view.state.selection.main;
    return { anchor: selection.anchor, head: selection.head, text: view.state.doc.toString() as string, focused: view.hasFocus, scrollTop: view.scrollDOM.scrollTop };
  });
}

async function settle(frame: Frame, count = 15): Promise<void> {
  await frame.evaluate(async count => {
    for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame);
  }, count);
}

async function checkOffscreenReturn(page: Page, frame: Frame, target: 'table' | 'document', side: 'above' | 'below', backward = false): Promise<void> {
  const original = (await readEditor(frame)).text;
  const fixture = side === 'below' ? 'Earlier reading content.\n\n'.repeat(30) + original : original;
  await frame.evaluate(({ fixture, target }) => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: fixture },
      selection: { anchor: fixture.indexOf(target === 'table' ? 'Table selection' : 'alpha beta') + 2 }, scrollIntoView: true });
    view.focus();
  }, { fixture, target });
  await settle(frame);
  if (target === 'table') await (await frame.$('tbody .meo-md-html-table-cell-preview'))!.click();
  await settle(frame);
  const selection = await frame.evaluate(({ target, backward }) => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    const input = document.querySelector<HTMLTextAreaElement>('tbody textarea');
    if (target === 'table') {
      input!.focus(); input!.setSelectionRange(2, backward ? 7 : 2, backward ? 'backward' : 'none');
    } else {
      const start = view.state.doc.toString().indexOf('alpha beta') + 2;
      view.dispatch({ selection: { anchor: backward ? start + 5 : start, head: start } }); view.focus();
    }
    (window as any).__windowReturnTarget = target === 'table' ? input : view.contentDOM;
    return { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
  }, { target, backward });
  const scroller = await frame.$eval('.editor-host > .cm-editor .cm-scroller', node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const bounds = await (await page.$('#webview'))!.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + scroller.x, bounds.y + scroller.y);
  await page.mouse.wheel({ deltaY: side === 'above' ? 700 : -700 });
  await settle(frame);
  const before = await frame.evaluate(({ target, side }) => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    const input = (window as any).__windowReturnTarget as HTMLElement;
    const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
    const rect = target === 'table' ? input.getBoundingClientRect() : view.coordsAtPos(view.state.selection.main.head);
    const viewport = scroller.getBoundingClientRect();
    return { scrollTop: scroller.scrollTop, offscreen: !rect || (side === 'above' ? rect.bottom < viewport.top : rect.top > viewport.bottom), focused: document.activeElement === input,
      start: input instanceof HTMLTextAreaElement ? input.selectionStart : null, end: input instanceof HTMLTextAreaElement ? input.selectionEnd : null };
  }, { target, side });
  const label = `${target}/${side}/${backward ? 'selection' : 'caret'}`;
  assert.ok(before.offscreen && before.focused, `${label}: fixture must retain an offscreen editing target: ${JSON.stringify(before)}`);
  if (target === 'table') assert.deepEqual({ start: before.start, end: before.end }, { start: 2, end: backward ? 7 : 2 }, `${label}: scrolling must retain the native range`);
  if (target === 'table' && side === 'above') await page.screenshot({ path: '.local/focus-return-production/before.png' });
  await page.focus('#host-control');
  assert.equal(await frame.evaluate(() => document.hasFocus()), false);
  await frame.evaluate(() => {
    ((window as any).__windowReturnTarget as HTMLElement).blur();
    (window as any).__returnScrollFrames = [];
    (window as any).__sampleReturnScroll = true;
    const sample = () => {
      if (!(window as any).__sampleReturnScroll) return;
      (window as any).__returnScrollFrames.push(document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!.scrollTop);
      requestAnimationFrame(sample);
    };
    sample();
  });
  await returnToFrame(page);
  await frame.evaluate(async () => {
    // A native activation may restore the embedded input after the window's
    // focus notification. Exercise Chromium's default focus scrolling too.
    const input = (window as any).__windowReturnTarget as HTMLElement;
    input.blur(); input.focus();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
    for (let index = 0; index < 15; index++) await new Promise(requestAnimationFrame);
    (window as any).__sampleReturnScroll = false;
  });
  const frames = await frame.evaluate(() => (window as any).__returnScrollFrames as number[]);
  if (target === 'table' && side === 'above') await page.screenshot({ path: '.local/focus-return-production/after.png' });
  assert.ok(frames.every(top => Math.abs(top - before.scrollTop) <= 2),
    `${label}: window return moved the reading viewport: before=${before.scrollTop}, frames=${JSON.stringify(frames)}`);
  assert.equal(await frame.evaluate(() => document.activeElement === (window as any).__windowReturnTarget), true, `${label}: keyboard focus must return`);
  if (target === 'table') {
    assert.deepEqual(await readInput(frame, 'tbody textarea'), {
      focused: true, value: 'Table selection', start: 2, end: backward ? 7 : 2,
      direction: backward ? 'backward' : 'forward', scrollLeft: 0
    }, `${label}: native selection must survive`);
  } else {
    const after = await readEditor(frame);
    assert.deepEqual({ anchor: after.anchor, head: after.head }, selection, `${label}: document selection must survive`);
  }
  // A fresh wheel gesture must take ownership even inside the activation grace.
  await frame.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
  await page.mouse.wheel({ deltaY: side === 'above' ? -200 : 200 });
  await settle(frame);
  const moved = (await readEditor(frame)).scrollTop - before.scrollTop;
  assert.ok(side === 'above' ? moved < -100 : moved > 100, `${label}: focus retention blocked a new wheel gesture: ${moved}`);
  if (side === 'above') {
    await frame.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await page.keyboard.type('Q');
    const expected = target === 'table' ? 'TaQble selection' : 'alQpha beta';
    await frame.waitForFunction(expected => {
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      return view.state.doc.toString().includes(expected);
    }, {}, expected);
    assert.ok((await readEditor(frame)).scrollTop < before.scrollTop + moved - 100, `${label}: typing must still reveal the offscreen caret`);
  } else {
    const readingTop = (await readEditor(frame)).scrollTop;
    await frame.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await page.mouse.click(bounds.x + scroller.x, bounds.y + scroller.y);
    const clicked = await readEditor(frame);
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } })));
    await settle(frame);
    const returned = await readEditor(frame);
    assert.equal(returned.head, clicked.head, `${label}: late Host recovery must preserve the new click`);
    assert.ok(Math.abs(returned.scrollTop - readingTop) <= 2, `${label}: a new document click must retain its reading viewport`);
  }
  await frame.evaluate(original => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original }, selection: { anchor: 8, head: 3 } }); view.focus();
    document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!.scrollTop = 0;
    delete (window as any).__windowReturnTarget;
  }, original);
  await settle(frame);
}

try {
  for (const mode of ['live', 'source', 'preview'] as const) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      page.setDefaultTimeout(8000);
      await page.setViewport({ width: 1200, height: 800 });
      await page.setContent('<button id="host-control">Workbench</button><iframe id="webview" style="width:1180px;height:740px"></iframe>');
      const frame = await (await page.$('#webview'))!.contentFrame();
      assert.ok(frame);
      await frame.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
      await frame.addStyleTag({ path: 'webview/src/styles.css' });
      await page.exposeFunction('__renderFocusPreview', (message: any) => {
        if (message.type !== 'requestPreviewRender') return null;
        return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: exportRuntime.renderPreviewDocument({
          markdownText: message.text, sourceDocumentPath: 'C:/tmp/input-focus.md', uiLanguage: message.uiLanguage, styleEnvironment: message.environment
        }) } };
      });
      await frame.addScriptTag({ content: `window.__messages=[];window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__messages.push(message);parent.__renderFocusPreview(message).then(reply=>{if(reply)window.dispatchEvent(new MessageEvent('message',{data:reply}));});}});` });
      await frame.addScriptTag({ content: bundle });
      await frame.evaluate(({ text, mode }) => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', documentId: 'file:///input-focus.md', text, version: 1, savedRevision: { version: 1, text }, diagnostics: [],
        mode: mode === 'preview' ? 'live' : mode, uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'light', previewFontFamily: '',
        previewSourceColoring: true, editorAppearance: 'light', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
        diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
        findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        restoreReadingPositionOnOpen: false, vscodeTheme: null
      } })), { text, mode });
      await frame.waitForSelector('.editor-wrapper:not(.meo-preload-editor-shell) .cm-content');
      if (mode !== 'preview') {
        for (const side of ['above', 'below'] as const) {
          if (mode === 'live') await checkOffscreenReturn(page, frame, 'table', side, side === 'below');
          await checkOffscreenReturn(page, frame, 'document', side, side === 'below');
        }
      }
      await frame.evaluate(() => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        view.dispatch({ selection: { anchor: 8, head: 3 } }); view.focus();
      });
      if (mode === 'preview') {
        await (await frame.$('[data-mode="preview"]'))!.click();
        await frame.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === true);
      }
      const documentBefore = await readEditor(frame);

      for (const [index, direction] of ['forward', 'backward', 'none'].entries()) {
        await (await frame.$('[data-action="find"]'))!.click();
        const editorBefore = await readEditor(frame);
        for (const field of (mode === 'preview' ? ['find'] : ['find', 'replace']) as ('find' | 'replace')[]) {
          const selector = field === 'find' ? '.find-row .find-input' : '.find-replace-row .find-input';
          const value = 'Search selection and scrolling witness '.repeat(8);
          const before = await frame.evaluate(({ selector, value, direction }) => {
            const input = document.querySelector<HTMLInputElement>(selector)!;
            input.focus(); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
            const start = direction === 'none' ? 170 : 160; const end = direction === 'none' ? 170 : 175;
            input.setSelectionRange(start, end, direction as 'forward' | 'backward' | 'none'); input.scrollLeft = 700;
            return { value, start, end, direction: input.selectionDirection, scrollLeft: input.scrollLeft };
          }, { selector, value, direction });
          assert.ok(before.scrollLeft > 0, `${mode}/${field}: fixture must be horizontally scrolled`);
          // Present the user's scrolled input before leaving. Native scroll
          // notification is delivered at the rendering opportunity.
          await frame.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
          await leave(page, frame, selector);
          await returnToFrame(page);
          assert.deepEqual(await readInput(frame, selector), { focused: true, ...before }, `${mode}/${field}/${direction}: window return lost the input range`);
          await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } })));
          assert.deepEqual(await readInput(frame, selector), { focused: true, ...before }, `${mode}/${field}: late Host recovery changed the input`);
          await page.keyboard.type('Q');
          const after = await readInput(frame, selector);
          assert.equal(after.value, value.slice(0, before.start) + 'Q' + value.slice(before.end), `${mode}/${field}: first input missed the restored position`);
          const editorAfter = await readEditor(frame);
          assert.deepEqual(editorAfter, editorBefore, `${mode}/${field}: input recovery changed document selection or viewport`);
        }
        if (index === 0) await page.keyboard.press('Escape');
        else await (await frame.$(index === 1 ? '.find-close-button' : '[data-action="find"]'))!.click();
        await frame.waitForFunction(() => !document.querySelector('.find-panel.is-visible'));
        const closed = await readEditor(frame);
        assert.equal(closed.text, text);
        assert.equal(closed.anchor, documentBefore.anchor);
        assert.equal(closed.head, documentBefore.head);
        assert.equal(closed.focused, mode !== 'preview', `${mode}: closing search must return to the active document surface`);
      }

      await (await frame.$('.more-tools-wrapper > .format-button'))!.click();
      await (await frame.$('.more-tools-settings-button'))!.click();
      await frame.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('.settings-search')!;
        input.value = 'Search settings witness'; input.dispatchEvent(new Event('input'));
        input.setSelectionRange(2, 9, 'backward');
      });
      const settingsBefore = await readInput(frame, '.settings-search');
      await leave(page, frame, '.settings-search'); await returnToFrame(page);
      assert.deepEqual(await readInput(frame, '.settings-search'), settingsBefore, `${mode}: settings search did not restore its selection`);
      await page.keyboard.type('S');
      assert.equal((await readInput(frame, '.settings-search')).value, 'SeS' + 'Search settings witness'.slice(9));
      await (await frame.$('.settings-close'))!.click();
      assert.equal(await frame.$eval('.settings-window', node => (node as HTMLDialogElement).open), false);
      const settingsClosed = await readEditor(frame);
      assert.equal(settingsClosed.text, text); assert.equal(settingsClosed.anchor, documentBefore.anchor); assert.equal(settingsClosed.head, documentBefore.head);
      assert.equal(settingsClosed.focused, mode !== 'preview');
      if (mode !== 'preview') {
        await page.keyboard.type('!');
        assert.equal((await readEditor(frame)).text, text.slice(0, 3) + '!' + text.slice(8), `${mode}: closing an input must allow typing at the saved document selection`);
      }

      // Explicit new interaction supersedes the old input recovery.
      await (await frame.$('[data-action="find"]'))!.click();
      await frame.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('.find-row .find-input')!;
        input.value = 'old range'; input.setSelectionRange(2, 5, 'backward');
      });
      await leave(page, frame, '.find-row .find-input');
      const nextInput = mode === 'preview' ? '.find-row .find-input' : '.find-replace-row .find-input';
      await (await frame.$(nextInput))!.click();
      await frame.evaluate(selector => {
        const input = document.querySelector<HTMLInputElement>(selector)!;
        input.setSelectionRange(0, 0);
      }, nextInput);
      await page.keyboard.type('NEW');
      await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } })));
      assert.equal((await readInput(frame, nextInput)).value, mode === 'preview' ? 'NEWold range' : 'NEW');
      assert.equal((await readInput(frame, nextInput)).focused, true);
      await frame.focus('[data-action="find"]');
      await chord(page, 'f');
      const explicitlyOpened = await readInput(frame, '.find-row .find-input');
      assert.equal(explicitlyOpened.start, 0); assert.equal(explicitlyOpened.end, explicitlyOpened.value.length, 'explicit Find retains select-all behavior');
      await frame.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('.find-row .find-input')!;
        window.dispatchEvent(new Event('blur')); input.blur();
        input.value = 'changed'; input.setSelectionRange(3, 3);
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      });
      const changed = await readInput(frame, '.find-row .find-input');
      assert.equal(changed.value, 'changed'); assert.equal(changed.focused, true);
      assert.equal(changed.start, changed.end, 'a value change must not reapply the old select-all range');
      if (mode === 'live') {
        await (await frame.$('.find-close-button'))!.click();
        await frame.waitForSelector('tbody textarea');
        await frame.evaluate(() => {
          const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
          input.focus(); input.setSelectionRange(2, 7, 'backward');
        });
        for (const order of ['window-first', 'input-first']) {
          if (order === 'input-first') {
            await frame.evaluate(() => document.querySelector<HTMLTextAreaElement>('tbody textarea')!.blur());
          }
          await leave(page, frame, 'tbody textarea');
          assert.equal(await frame.evaluate(() => {
            const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
            return input.parentElement!.classList.contains('is-editing') && getComputedStyle(input).opacity === '1';
          }), true, `${order}: window loss must retain the cell editing presentation`);
          await returnToFrame(page);
          assert.deepEqual(await readInput(frame, 'tbody textarea'), {
            focused: true, value: 'Table selection', start: 2, end: 7, direction: 'backward', scrollLeft: 0
          }, `${order}: window return must restore the suspended cell and selection`);
        }
        await (await frame.$('[data-action="find"]'))!.click();
        assert.equal(await frame.evaluate(() => document.querySelector('tbody textarea')!.parentElement!.classList.contains('is-editing')), true,
          'opening Find must suspend the cell without switching to the rendered presentation');
        await leave(page, frame, '.find-row .find-input'); await returnToFrame(page);
        await page.keyboard.press('Escape');
        assert.deepEqual(await frame.evaluate(() => {
          const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
          return {focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection};
        }), {focused: true, start: 2, end: 7, direction: 'backward'}, 'closing a returned search must retain the original native table selection');
        await (await frame.$('[data-action="find"]'))!.click();
        await frame.evaluate(() => {
          const input = document.querySelector<HTMLInputElement>('.find-row .find-input')!;
          input.value = 'witness.'; input.dispatchEvent(new Event('input', {bubbles: true}));
        });
        await page.keyboard.press('Enter');
        const navigated = await readEditor(frame);
        assert.equal(await frame.evaluate(() => document.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table) .is-editing').length), 0,
          'an explicit search outside the table must end the old cell editing session');
        assert.equal(navigated.anchor, navigated.text.indexOf('witness.'));
        assert.equal(navigated.head, navigated.anchor + 'witness.'.length);
        await leave(page, frame, '.find-row .find-input'); await returnToFrame(page);
        await page.keyboard.press('Escape');
        const returned = await readEditor(frame);
        assert.equal(returned.anchor, navigated.anchor, 'an explicit search must supersede the previous table return point');
        assert.equal(returned.head, navigated.head);
        await page.keyboard.type('FOUND');
        assert.equal((await readEditor(frame)).text, navigated.text.slice(0, navigated.anchor) + 'FOUND' + navigated.text.slice(navigated.head));
        await (await frame.$('[data-action="find"]'))!.click();
        await frame.evaluate(() => {
          const input = document.querySelector<HTMLInputElement>('.find-row .find-input')!;
          input.value = 'Cell'; input.dispatchEvent(new Event('input', {bubbles: true}));
        });
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        assert.deepEqual(await frame.evaluate(() => {
          const input = document.querySelector<HTMLTextAreaElement>('thead textarea')!;
          return {focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd};
        }), {focused: true, start: 0, end: 4}, 'searching another cell must return to that cell instead of the original one');
        await (await frame.$('.cm-line'))!.click();
        assert.equal(await frame.evaluate(() => document.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table) .is-editing').length), 0,
          'clicking document text must end cell editing');
        await page.focus('#host-control'); await returnToFrame(page);
        assert.equal(await frame.evaluate(() => document.activeElement instanceof HTMLTextAreaElement), false,
          'window return must respect the new document target instead of resurrecting the exited cell');
        for (const [query, selector] of [['Cell', 'thead textarea'], ['Table selection', 'tbody textarea']]) {
          const immediateSearch = await frame.evaluate(({query, selector}) => {
            const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
            // Keep input and Find in one task so the derived input refresh cannot
            // finish first and conceal an outdated match cache or cell range.
            view.focus();
            view.dispatch({changes: {from: 0, insert: 'Added text\n\n'}, selection: {anchor: 12}, userEvent: 'input.type'});
            document.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
            const input = document.querySelector<HTMLInputElement>('.find-row .find-input')!;
            input.value = query; input.dispatchEvent(new Event('input', {bubbles: true}));
            input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
            input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
            const cell = document.querySelector<HTMLTextAreaElement>(selector)!;
            const selection = view.state.selection.main;
            return {focused: document.activeElement === cell, start: cell.selectionStart, end: cell.selectionEnd,
              selected: view.state.doc.sliceString(selection.from, selection.to)};
          }, {query, selector});
          assert.deepEqual(immediateSearch, {focused: true, start: 0, end: query.length, selected: query},
            'Find immediately after typing must use the accepted document and current table cell');
          await frame.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          assert.equal(await frame.$eval(selector, cell => document.activeElement === cell), true,
            'the derived refresh must retain the searched cell focus');
        }
        const unchangedQuery = await frame.evaluate(() => {
          const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
          document.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
          const input = document.querySelector<HTMLInputElement>('.find-row .find-input')!;
          input.value = 'new search match'; input.dispatchEvent(new Event('input', {bubbles: true}));
          view.dispatch({changes: {from: 0, insert: 'new search match\n\n'}, selection: {anchor: 0}, userEvent: 'input.type'});
          input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
          input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
          const selection = view.state.selection.main;
          return {from: selection.from, to: selection.to, focused: view.hasFocus};
        });
        assert.deepEqual(unchangedQuery, {from: 0, to: 'new search match'.length, focused: true},
          'an unchanged query must find a newly typed match before the derived refresh');
      }
      assert.deepEqual(errors, [], `${mode}: focus handlers must not throw`);
    } finally { await page.close(); }
  }
  console.log('Input window-return and document handoff production checks passed in Live, Source and Preview.');
} catch (error) { primaryError = error; }
finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
