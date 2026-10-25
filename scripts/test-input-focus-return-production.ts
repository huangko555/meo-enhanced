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

async function checkTableActivationClick(page: Page, frame: Frame): Promise<void> {
  const original = (await readEditor(frame)).text;
  for (const large of [false, true]) {
    for (const crossTable of [false, true]) {
      for (const restore of ['none', 'cell', 'document'] as const) {
        for (const gesture of ['click', 'drag', 'cells', 'cancel', 'lostcapture', 'blur'] as const) {
          const fixture = 'Before\n\n| A | B |\n| --- | --- |\n| original cell | second target text |\n\nBetween\n\n'
            + '| C | D |\n| --- | --- |\n| third cell | fourth target text |\n\nAfter'
            + (large ? '\n'.repeat(8000) : '');
          await frame.evaluate(fixture => {
            const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: fixture }, selection: { anchor: 0 } });
            view.focus(); view.scrollDOM.scrollTop = 0;
          }, fixture);
          await settle(frame, 8);
          await (await frame.$('tbody td .meo-md-html-table-cell-preview'))!.click();
          const pendingEdit = large && restore === 'cell' && gesture === 'click';
          if (pendingEdit) await frame.evaluate(() => {
            const input = document.activeElement as HTMLTextAreaElement;
            input.value += '!'; input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '!' }));
          });
          const point = await frame.evaluate(crossTable => {
            const cells = [...document.querySelectorAll<HTMLTableCellElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody td')];
            const oldInput = cells[0].querySelector('textarea')!;
            oldInput.setSelectionRange(2, 5, 'backward');
            const target = cells[crossTable ? 3 : 1];
            const preview = target.querySelector('.meo-md-html-table-cell-preview')!;
            const node = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT).nextNode()!;
            const range = document.createRange(); range.setStart(node, 2); range.setEnd(node, 3);
            const rect = range.getBoundingClientRect();
            (window as any).__activationFixture = { oldInput, input: target.querySelector('textarea'), cells,
              scrollTop: document.querySelector('.cm-scroller')!.scrollTop, samples: [] };
            document.addEventListener('pointerdown', event => {
              (window as any).__activationFixture.pointerId = event.pointerId;
            }, { capture: true, once: true });
            range.setStart(node, 7); range.setEnd(node, 8);
            const end = range.getBoundingClientRect();
            const adjacent = cells[crossTable ? 2 : 0].getBoundingClientRect();
            return { x: rect.right, y: rect.top + rect.height / 2, endX: end.right, endY: end.top + end.height / 2,
              adjacentX: adjacent.left + 10, adjacentY: adjacent.top + 10 };
          }, crossTable);
          await page.focus('#host-control');
          // Window activation may restore the old input before the press too.
          await returnToFrame(page);
          const bounds = await (await page.$('#webview'))!.boundingBox();
          assert.ok(bounds);
          await page.mouse.move(bounds.x + point.x, bounds.y + point.y);
          await page.mouse.down();
          if (gesture === 'drag') await page.mouse.move(bounds.x + point.endX, bounds.y + point.endY, { steps: 3 });
          if (gesture === 'cells') await page.mouse.move(bounds.x + point.adjacentX, bounds.y + point.adjacentY, { steps: 3 });
          // Native activation and its Host hint may reach the Webview after the
          // new pointer press. Exercise both suspended editable return targets.
          await frame.evaluate(restore => {
            const state = (window as any).__activationFixture;
            const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
            if (restore !== 'none') (restore === 'cell' ? state.oldInput : view.contentDOM).focus({ preventScroll: true });
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
            state.sample = () => {
              const outline = getComputedStyle(state.cells[0], '::after');
              state.samples.push({ oldPainted: document.activeElement === state.oldInput
                && outline.visibility !== 'hidden' && outline.boxShadow !== 'none', scrollTop: view.scrollDOM.scrollTop,
                text: document.getSelection()?.toString() ?? '' });
              state.raf = requestAnimationFrame(state.sample);
            };
            state.sample();
          }, restore);
          await settle(frame, 8);
          if (gesture === 'cancel' || gesture === 'lostcapture' || gesture === 'blur') {
            await frame.evaluate(gesture => {
              const state = (window as any).__activationFixture;
              if (gesture === 'blur') { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); }
              else if (gesture === 'lostcapture') state.input.closest('table').releasePointerCapture(state.pointerId);
              else state.input.closest('table').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: state.pointerId }));
            }, gesture);
          }
          await page.mouse.up();
          if (gesture === 'cells') {
            await settle(frame, 2);
            await frame.evaluate(() => {
              const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
              view.contentDOM.focus({ preventScroll: true });
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
            });
          }
          if (gesture === 'cancel' || gesture === 'lostcapture' || gesture === 'blur') await page.mouse.click(bounds.x + point.x, bounds.y + point.y);
          await settle(frame, 8);
          const result = await frame.evaluate(() => {
            const state = (window as any).__activationFixture;
            cancelAnimationFrame(state.raf);
            return { focused: document.activeElement === state.input, caret: state.input.selectionStart, end: state.input.selectionEnd,
              cellRange: state.input.closest('table').querySelectorAll('.meo-md-html-table-cell-selected').length,
              samples: state.samples, scrollTop: state.scrollTop,
              retained: state.cells.every((cell: Element) => cell.isConnected) };
          });
          const label = `${large ? 'large' : 'small'}/${crossTable ? 'cross-table' : 'same-table'}/${restore}/${gesture}`;
          assert.ok(result.samples.length >= 8 && result.samples.every((sample: any) => !sample.oldPainted),
            `${label}: native activation repainted the old cell outline: ${JSON.stringify(result)}`);
          assert.ok(gesture === 'cells' ? result.cellRange === 2 : result.focused && result.caret === 3 && result.end === (gesture === 'drag' ? 8 : 3),
            `${label}: the new text click lost its caret: ${JSON.stringify(result)}`);
          if (gesture === 'drag') assert.ok(result.samples.slice(0, 8).every((sample: any) => sample.text === (crossTable ? 'rth t' : 'ond t')),
            `${label}: activation cleared the visible text drag: ${JSON.stringify(result)}`);
          assert.ok(result.retained && result.samples.every((sample: any) => Math.abs(sample.scrollTop - result.scrollTop) <= 2),
            `${label}: activation replaced cells or moved the viewport`);
          assert.equal((await readEditor(frame)).text, pendingEdit ? fixture.replace('original cell', 'original cell!') : fixture,
            `${label}: focus handoff must retain pending input without editing other Markdown`);
        }
      }
    }
  }
  await frame.evaluate(original => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original }, selection: { anchor: 0 } }); view.focus();
  }, original);
  await settle(frame);
  await (await frame.$('tbody .meo-md-html-table-cell-preview'))!.click();
  const sameCellPoint = await frame.evaluate(() => {
    const input = document.activeElement as HTMLTextAreaElement;
    input.setSelectionRange(2, 7, 'backward');
    const node = document.createTreeWalker(input.parentElement!.querySelector('.meo-md-html-table-cell-preview')!, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange(); range.setStart(node, 2); range.setEnd(node, 3);
    const rect = range.getBoundingClientRect();
    return { x: rect.right, y: rect.top + rect.height / 2 };
  });
  await page.focus('#host-control');
  await returnToFrame(page);
  await settle(frame);
  const returned = await readInput(frame, 'tbody textarea');
  assert.ok(returned.focused && returned.start === 2 && returned.end === 7 && returned.direction === 'backward',
    'keyboard window return must retain the original cell and backward range');
  await page.focus('#host-control');
  const bounds = await (await page.$('#webview'))!.boundingBox();
  assert.ok(bounds);
  await page.mouse.click(bounds.x + sameCellPoint.x, bounds.y + sameCellPoint.y);
  const clicked = await readInput(frame, 'tbody textarea');
  assert.ok(clicked.focused && clicked.start === 3 && clicked.end === 3,
    `clicking the original cell must use the new native caret: ${JSON.stringify(clicked)}`);
  await page.keyboard.type('Q');
  assert.ok((await readInput(frame, 'tbody textarea')).value === 'TabQle selection', 'the first key must reach the clicked original cell');
  await chord(page, 'z');
  await settle(frame);
  assert.equal((await readEditor(frame)).text, original, 'same-cell return Undo must restore Markdown');
}

async function checkTableActivationBoundaries(page: Page, frame: Frame): Promise<void> {
  const original = (await readEditor(frame)).text;
  for (const large of [false, true]) for (const origin of ['cell', 'document'] as const) {
    for (const target of ['same', 'other', 'left-border', 'bottom-border', 'row-border', 'column-border', 'chrome'] as const)
      for (const recovery of ['held', 'released', 'window-cycle'] as const) {
      if (recovery === 'released' && target !== 'same' && target !== 'other' && target !== 'chrome') continue;
      const fixture = 'Before table.\n\n| A | B |\n| --- | --- |\n| original cell | another target |\n| next row | final cell |\n\nAfter table.'
        + (large ? '\n\n' + 'Unchanged background paragraph.\n\n'.repeat(34000) : '');
      await frame.evaluate(fixture => {
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: fixture }, selection: { anchor: 0 } });
        view.focus(); view.scrollDOM.scrollTop = 0;
      }, fixture);
      await settle(frame, 8);
      if (origin === 'cell') await (await frame.$('tbody td .meo-md-html-table-cell-preview'))!.click();
      if (origin === 'cell') await frame.evaluate(() => (document.activeElement as HTMLTextAreaElement).setSelectionRange(2, 5, 'backward'));
      await settle(frame, 3);
      const point = await frame.evaluate(target => {
        const table = document.querySelector<HTMLTableElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
        const cells = [...table.querySelectorAll<HTMLTableCellElement>('tbody td')];
        const bounds = cells[0].getBoundingClientRect(), outer = table.getBoundingClientRect();
        const destination = cells[target === 'other' ? 1 : target === 'bottom-border' ? 2 : 0];
        const textClick = target === 'same' || target === 'other';
        const input = textClick ? destination.querySelector('textarea')! : document.activeElement as HTMLElement;
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        (window as any).__activationBoundary = { table, cells, input, oldInput: cells[0].querySelector('textarea'),
          beforeHead: view.state.selection.main.head,
          beforeRange: input instanceof HTMLTextAreaElement ? {start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection} : null,
          bounds: { top: outer.top, left: outer.left, width: outer.width, height: outer.height }, samples: [], armed: false };
        document.addEventListener('pointerdown', event => {
          const state = (window as any).__activationBoundary;
          state.armed = true;
          // Accept the native text hit only for text clicks; grid pixels keep
          // the original cell/document target regardless of their DOM target.
          const cell = event.target instanceof Element ? event.target.closest('td, th') : null;
          if (textClick && cell && table.contains(cell)) state.input = cell.querySelector('textarea');
        }, { capture: true, once: true });
        if (target === 'chrome') {
          const toolbar = document.querySelector('.mode-toolbar')!.getBoundingClientRect();
          const y = toolbar.top + toolbar.height / 2;
          for (let x = toolbar.left + 2; x < toolbar.right - 2; x += 2) {
            const hit = document.elementFromPoint(x, y);
            if (hit && !hit.closest('button, input, select, [role="tab"], [role="tablist"]')) return {x,y};
          }
          throw new Error('Toolbar has no focus-preserving blank point');
        }
        if (target === 'left-border') return { x: outer.left + 0.1, y: bounds.top + bounds.height / 2 };
        if (target === 'bottom-border') return { x: bounds.left + bounds.width / 2, y: outer.bottom - 0.1 };
        if (target === 'row-border') return { x: bounds.left + bounds.width / 2, y: bounds.bottom - 0.1 };
        if (target === 'column-border') return { x: bounds.right - 0.1, y: bounds.top + bounds.height / 2 };
        const node = document.createTreeWalker(destination.querySelector('.meo-md-html-table-cell-preview')!, NodeFilter.SHOW_TEXT).nextNode()!;
        const range = document.createRange(); range.setStart(node, 2); range.setEnd(node, 3);
        const rect = range.getBoundingClientRect();
        return { x: rect.right, y: rect.top + rect.height / 2 };
      }, target);
      await page.focus('#host-control');
      await returnToFrame(page);
      await frame.evaluate(() => {
        const state = (window as any).__activationBoundary;
        const sample = () => {
          if (state.armed) {
            const bounds = state.table.getBoundingClientRect();
            const rings = state.cells.map((cell: Element) => {
              const style = getComputedStyle(cell, '::after');
              return style.visibility !== 'hidden' && style.boxShadow !== 'none';
            });
            state.samples.push({ rings, focused: document.hasFocus(), top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height });
          }
          state.raf = requestAnimationFrame(sample);
        };
        state.raf = requestAnimationFrame(sample);
      });
      const iframe = (await page.$('#webview'))!;
      const bounds = await iframe.boundingBox(); assert.ok(bounds);
      const inset = await iframe.evaluate(node => ({ x: node.clientLeft, y: node.clientTop }));
      await page.mouse.move(bounds.x + inset.x + point.x, bounds.y + inset.y + point.y);
      await page.mouse.down();
      if (recovery === 'window-cycle') {
        // Native VS Code activation can blur and refocus the Webview while the
        // same press is still held. Replay that recorded handoff, not just a
        // late focus call in an otherwise continuously focused document.
        await settle(frame, 3);
        await page.focus('#host-control');
        await frame.evaluate(() => (document.activeElement as HTMLElement).blur());
        await settle(frame, 3);
        await returnToFrame(page);
      }
      if (recovery === 'released') { await settle(frame, 3); await page.mouse.up(); await settle(frame, 2); }
      await frame.evaluate(({ origin, target, recovery }) => {
        const state = (window as any).__activationBoundary;
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        // A delayed native restore must not replace the newer pointer destination.
        (recovery === 'held' && origin === 'cell' && target !== 'column-border' && target !== 'chrome' ? state.oldInput : view.contentDOM).focus({ preventScroll: true });
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      }, { origin, target, recovery });
      await settle(frame, 3);
      if (recovery !== 'released') await page.mouse.up();
      await settle(frame, 10);
      const result = await frame.evaluate(() => {
        const state = (window as any).__activationBoundary;
        cancelAnimationFrame(state.raf);
        const input = state.input as HTMLTextAreaElement;
        const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
        return { focused: document.activeElement === input, caret: input.selectionStart, end: input.selectionEnd, direction:input.selectionDirection,
          beforeRange:state.beforeRange, beforeHead:state.beforeHead, head:view.state.selection.main.head, samples: state.samples,
          bounds: state.bounds, retained: state.cells.every((cell: Element) => cell.isConnected) };
      });
      const label = `${large ? 'large' : 'small'}/${origin}/${target}/${recovery}`;
      assert.ok(result.focused, `${label}: a border or activation click lost the native cell caret`);
      const textClick = target === 'same' || target === 'other';
      if (textClick) assert.equal(result.caret, 3, `${label}: native hit testing moved the caret`);
      else {
        assert.equal(result.head, result.beforeHead, `${label}: a border changed the original source caret`);
        if (result.beforeRange) assert.deepEqual({start:result.caret,end:result.end,direction:result.direction}, result.beforeRange,
          `${label}: a preserving click changed the original native selection`);
      }
      let appeared = false;
      for (const sample of result.samples) {
        if (!sample.focused) continue;
        const visible = sample.rings.some(Boolean);
        assert.ok(!appeared || visible, `${label}: the cell outline disappeared after appearing`);
        appeared ||= visible;
        for (const key of ['top', 'left', 'width', 'height'] as const) {
          assert.ok(Math.abs(sample[key] - result.bounds[key]) <= 0.5, `${label}: table ${key} changed during focus handoff`);
        }
      }
      assert.ok((appeared || !textClick && origin === 'document') && result.samples.length >= 8 && result.retained,
        `${label}: missing outline frames or replaced cells`);
      if (recovery === 'released' && (textClick || origin === 'cell')) {
        await page.keyboard.press('Tab');
        assert.ok(await frame.evaluate(() => document.activeElement instanceof HTMLTextAreaElement
          && document.activeElement !== (window as any).__activationBoundary.input), `${label}: the completed pointer trapped Tab`);
        await page.keyboard.down('Shift');
        try { await page.keyboard.press('Tab'); } finally { await page.keyboard.up('Shift'); }
        assert.ok(await frame.evaluate(() => document.activeElement === (window as any).__activationBoundary.input), `${label}: Shift+Tab could not return`);
      }
      await page.keyboard.type('Q');
      await frame.waitForFunction(() => {
        const input = (window as any).__activationBoundary.input;
        return input instanceof HTMLTextAreaElement ? input.value.includes('Q')
          : (window as any).EditingSettingsHarness.EditorView.findFromDOM(input).state.doc.toString().includes('Q');
      });
      await chord(page, 'z');
      await settle(frame, 4);
      assert.equal((await readEditor(frame)).text, fixture, `${label}: first-key Undo changed unrelated Markdown`);
    }
  }
  await frame.evaluate(original => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original }, selection: { anchor: 0 } }); view.focus();
  }, original);
  await settle(frame);
}

async function checkInactiveScrollTableActivation(page: Page, frame: Frame): Promise<void> {
  const original = (await readEditor(frame)).text;
  for (const large of [false, true]) for (const recovery of ['native', 'held-cycle', 'released-cycle'] as const) {
    const fixture = 'Original prose caret.\n\n' + 'Unchanged background paragraph.\n\n'.repeat(large ? 34000 : 80)
      + '| A | B |\n| --- | --- |\n| distant target | another cell |\n\nAfter table.';
    await frame.evaluate(fixture => {
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: fixture}, selection: {anchor: 2}});
      view.focus(); view.scrollDOM.scrollTop = 0;
    }, fixture);
    await settle(frame, 8);
    await (await frame.$('.cm-line'))!.click();
    assert.equal(await frame.evaluate(() => document.activeElement?.classList.contains('cm-content')), true,
      'inactive-scroll fixture must start with a real prose caret');
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'hostWindowFocusChanged', focused: true}})));
    await page.focus('#host-control');
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'hostWindowFocusChanged', focused: false}})));
    const bounds = await (await page.$('#webview'))!.boundingBox(); assert.ok(bounds);
    const inset = await frame.$eval('.cm-scroller', node => {
      const rect = node.getBoundingClientRect(); return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    });
    await page.mouse.move(bounds.x + inset.x, bounds.y + inset.y);
    await page.mouse.wheel({deltaY: 10_000_000});
    await settle(frame, 12);
    assert.equal(await frame.evaluate(() => document.hasFocus()), false, 'inactive wheel must not activate the editor');
    const point = await frame.evaluate(() => {
      const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
      const cell = document.querySelector<HTMLTableCellElement>('tbody td')!;
      const node = document.createTreeWalker(cell.querySelector('.meo-md-html-table-cell-preview')!, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange(); range.setStart(node, 2); range.setEnd(node, 3);
      const rect = range.getBoundingClientRect();
      const state = (window as any).__inactiveScrollActivation = {cell, input: cell.querySelector('textarea'), top: view.scrollDOM.scrollTop, samples: [], events: []};
      const read = () => {
        const style = getComputedStyle(cell, '::after');
        return {top: view.scrollDOM.scrollTop, focused: document.hasFocus(), active: document.activeElement?.tagName,
          head: view.state.selection.main.head, domSelection: document.getSelection()?.anchorNode?.parentElement?.className,
          ring: style.visibility !== 'hidden' && style.boxShadow !== 'none', retained: cell.isConnected};
      };
      state.record = (event: Event) => state.events.push({type: event.type,
        target: event.target instanceof Element ? `${event.target.tagName}.${event.target.className}` : 'window', ...read()});
      for (const type of ['focus', 'blur', 'pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) window.addEventListener(type, state.record, true);
      const sample = () => {state.samples.push(read()); state.raf = requestAnimationFrame(sample);}; sample();
      return {x: rect.right, y: rect.top + rect.height / 2};
    });
    await returnToFrame(page);
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'hostWindowFocusChanged', focused: true}})));
    await page.mouse.move(bounds.x + point.x, bounds.y + point.y);
    await page.mouse.down();
    await settle(frame, 4);
    if (recovery === 'held-cycle') {
      await page.focus('#host-control');
      await frame.evaluate(() => (document.activeElement as HTMLElement).blur());
      await settle(frame, 3);
      await returnToFrame(page);
      await frame.evaluate(() => {
        window.dispatchEvent(new MessageEvent('message', {data: {type: 'focusEditor'}}));
      });
    }
    await page.mouse.up();
    if (recovery === 'released-cycle') {
      await settle(frame, 3);
      // VS Code can refocus its frame again after the cell has been accepted.
      // The actual Host is still focused throughout this internal handoff.
      await page.focus('#host-control');
      await frame.evaluate(() => (document.activeElement as HTMLElement).blur());
      await settle(frame, 3);
      await returnToFrame(page);
      await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'focusEditor'}})));
    }
    await settle(frame, 10);
    const result = await frame.evaluate(() => {
      const state = (window as any).__inactiveScrollActivation;
      cancelAnimationFrame(state.raf);
      for (const type of ['focus', 'blur', 'pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) window.removeEventListener(type, state.record, true);
      return {focused: document.activeElement === state.input, caret: state.input.selectionStart, end: state.input.selectionEnd,
        beforeTop: state.top, samples: state.samples, events: state.events};
    });
    const label = `${large ? 'large' : 'small'}/inactive-wheel/${recovery}`;
    assert.ok(result.focused && result.caret === 3 && result.end === 3, `${label}: new cell lost its exact caret: ${JSON.stringify(result)}`);
    let appeared = false;
    for (const sample of result.samples) {
      assert.ok(sample.retained && Math.abs(sample.top - result.beforeTop) <= 2, `${label}: activation replaced the table or moved its viewport: ${JSON.stringify(result)}`);
      if (!sample.focused && recovery !== 'released-cycle') continue;
      assert.ok(!appeared || sample.ring, `${label}: the new cell outline flashed: ${JSON.stringify(result)}`);
      appeared ||= sample.ring;
    }
    assert.ok(appeared, `${label}: missing final native outline`);
    if (large && recovery === 'released-cycle') await page.screenshot({path: '.local/focus-return-production/host-internal-return.png'});
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'hostWindowFocusChanged', focused: false}})));
    assert.equal(await frame.evaluate(() => {
      const style = getComputedStyle((window as any).__inactiveScrollActivation.cell, '::after');
      return style.visibility !== 'hidden' && style.boxShadow !== 'none';
    }), false, `${label}: a genuinely inactive Host must hide the editing outline`);
    if (large && recovery === 'released-cycle') await page.screenshot({path: '.local/focus-return-production/host-window-away.png'});
    await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', {data: {type: 'hostWindowFocusChanged', focused: true}})));
    console.log(`PASS ${label}: exact caret, outline, DOM and inactive reading viewport`);
  }
  await frame.evaluate(original => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: original}, selection: {anchor: 0}}); view.focus();
  }, original);
  await settle(frame);
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
  const onlyInactiveScroll = process.argv.includes('--only=inactive-scroll');
  const onlyTable = onlyInactiveScroll || process.argv.includes('--only=table-activation') || process.argv.includes('--only=table-boundaries');
  for (const mode of (onlyTable ? ['live'] : ['live', 'source', 'preview']) as ('live' | 'source' | 'preview')[]) {
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
      if (mode === 'live') {
        if (!onlyInactiveScroll) {
          if (!process.argv.includes('--only=table-boundaries')) await checkTableActivationClick(page, frame);
          await checkTableActivationBoundaries(page, frame);
        }
        await checkInactiveScrollTableActivation(page, frame);
      }
      if (onlyTable) continue;
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
            // Pin the ordering where an outside click's post-click cleanup is
            // still queued when Find returns to a newly chosen table cell.
            const outside = view.contentDOM.querySelector('.cm-line')!;
            for (const type of ['pointerdown', 'pointerup']) outside.dispatchEvent(new PointerEvent(type, {
              bubbles: true, button: 0, pointerId: 91
            }));
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
          const refreshedFocus = await frame.$eval(selector, cell => ({
            retained: document.activeElement === cell,
            connected: cell.isConnected,
            editing: cell.parentElement?.classList.contains('is-editing'),
            activeTag: document.activeElement?.tagName,
            activeClass: document.activeElement?.className
          }));
          assert.equal(refreshedFocus.retained, true,
            `the derived refresh must retain the searched cell focus (${mode}/${query}: ${JSON.stringify(refreshedFocus)})`);
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
  console.log(onlyTable
    ? 'Table window-return activation, border, resize, drag, cancellation and native caret checks passed.'
    : 'Input window-return and document handoff production checks passed in Live, Source and Preview.');
} catch (error) { primaryError = error; }
finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
