import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const fixture = path.resolve(import.meta.dir, '../.local/focus-window-return-test');
await mkdir(fixture, {recursive: true});
const entry = path.join(fixture, 'entry.ts');
await writeFile(entry, `import {createEditorFocusController} from '../../webview/src/adapters/editorFocusController';
(window as any).FocusController = {createEditorFocusController};`);
const bundle = await Bun.build({
  entrypoints: [entry], target: 'browser', format: 'iife'
});
assert.equal(bundle.success, true);
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(5000);
  await page.setContent('<input id="other-input"><iframe id="meo" srcdoc="<main id=app><div id=editor contenteditable=true>Fixture</div></main>"></iframe>');
  const frame = await (await page.waitForSelector('#meo'))!.contentFrame();
  assert.ok(frame);
  await frame.waitForSelector('#editor');
  await frame.addScriptTag({ content: await bundle.outputs[0]!.text() });
  await frame.evaluate(() => {
    const target = document.getElementById('editor')!;
    const state = { calls: 0, editable: true };
    const controller = (window as any).FocusController.createEditorFocusController({
      root: document.getElementById('app')!,
      getEditor: () => ({
        view: {dom: target},
        hasFocus: () => document.hasFocus() && document.activeElement === target,
        focus: () => {state.calls++; target.focus();},
        retainViewportOnWindowReturn: () => () => {}
      }),
      isEditableMode: () => state.editable
    });
    (window as any).fixture = {state, controller};
  });
  // Exercise separate document focus, as with the MEO and Codex Webviews.
  await frame.focus('#editor');
  await page.focus('#other-input');
  await frame.evaluate(() => document.getElementById('editor')!.blur());
  assert.deepEqual(await frame.evaluate(() => ({focused: document.hasFocus(), body: document.activeElement === document.body})),
    {focused: false, body: true});
  const outsideReturn = await frame.evaluate(() => {
    const {state, controller} = (window as any).fixture;
    state.calls = 0;
    const restored = controller.restoreFromHost();
    return {restored, calls: state.calls};
  });
  assert.deepEqual(outsideReturn, {restored: false, calls: 0}, 'Host return must not claim focus owned by another Webview');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'other-input');
  await page.keyboard.type('STAYS_OUTSIDE');
  assert.equal(await page.$eval('#other-input', (node) => (node as HTMLInputElement).value), 'STAYS_OUTSIDE');

  await frame.focus('#editor');
  const ownReturn = await frame.evaluate(() => {
    const {state, controller} = (window as any).fixture;
    window.dispatchEvent(new Event('blur'));
    document.getElementById('editor')!.blur();
    state.calls = 0;
    const hasDocumentFocus = document.hasFocus();
    const restored = controller.restoreFromHost();
    return {hasDocumentFocus, restored, calls: state.calls, editorFocused: document.activeElement?.id === 'editor'};
  });
  assert.deepEqual(ownReturn, {hasDocumentFocus: true, restored: 'editor', calls: 1, editorFocused: true},
    'a return to the MEO document must preserve synchronous editor recovery');
  const nativeReturn = await frame.evaluate(() => {
    const {state, controller} = (window as any).fixture;
    window.dispatchEvent(new Event('blur'));
    document.getElementById('editor')!.blur();
    state.calls = 0;
    window.dispatchEvent(new Event('focus'));
    const callsBeforeHost = state.calls;
    controller.restoreFromHost();
    return {callsBeforeHost, callsAfterHost: state.calls, editorFocused: document.activeElement?.id === 'editor'};
  });
  assert.deepEqual(nativeReturn, {callsBeforeHost: 1, callsAfterHost: 1, editorFocused: true},
    'native return must recover immediately without a duplicate focus call from the Host');
  await frame.evaluate(() => {
    const { controller } = (window as any).fixture;
    const input = document.createElement('input'); input.id = 'registered'; input.value = 'selection witness';
    const other = document.createElement('input'); other.id = 'unregistered';
    document.getElementById('app')!.append(input, other);
    (window as any).fixture.unregister = controller.registerInput(input);
  });
  // Both blur/focusout orders occur in Chromium and the native Webview.
  for (const blurFirst of [true, false]) {
    const result = await frame.evaluate(blurFirst => {
      const {state, controller} = (window as any).fixture;
      const input = document.getElementById('registered') as HTMLInputElement;
      input.focus(); input.setSelectionRange(2, 7, 'backward');
      if (blurFirst) { window.dispatchEvent(new Event('blur')); input.blur(); }
      else { input.blur(); window.dispatchEvent(new Event('blur')); }
      input.setSelectionRange(0, 0); state.calls = 0;
      window.dispatchEvent(new Event('focus'));
      const restored = controller.restoreFromHost();
      return {restored, calls: state.calls, focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection};
    }, blurFirst);
    assert.deepEqual(result, {restored: 'input', calls: 0, focused: true, start: 2, end: 7, direction: 'backward'},
      `input must own window recovery in both event orders: blurFirst=${blurFirst}`);
  }
  for (const owner of ['editor', 'registered'] as const) {
    for (const tag of ['nav', 'aside'] as const) {
      const result = await frame.evaluate(async ({owner, tag}) => {
        const {state, controller} = (window as any).fixture;
        const target = document.getElementById(owner)!;
        // New chrome subtrees use the same policy without registering their
        // location or assigning a private focus handler.
        const chrome = document.createElement(tag);
        const blank = document.createElement('span'); blank.textContent = 'Blank chrome';
        chrome.append(blank); document.getElementById('app')!.append(chrome);
        target.focus();
        if (target instanceof HTMLInputElement) target.setSelectionRange(2, 7, 'backward');
        window.dispatchEvent(new Event('blur')); target.blur();
        window.dispatchEvent(new Event('focus'));
        const press = new PointerEvent('pointerdown', {bubbles: true, cancelable: true, pointerId: 41, button: 0});
        blank.dispatchEvent(press);
        // Repeated activation while the same blank press is held must keep
        // the accepted owner and withhold transient focus paint until release.
        window.dispatchEvent(new Event('blur')); target.blur(); state.calls = 0;
        window.dispatchEvent(new Event('focus')); controller.restoreFromHost();
        for (let index = 0; index < 5; index++) await new Promise(requestAnimationFrame);
        const during = {focused: document.activeElement === target, prevented: press.defaultPrevented,
          pending: document.getElementById('app')!.classList.contains('meo-window-focus-return-pending'), calls: state.calls};
        blank.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerId: 41}));
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        const after = {focused: document.activeElement === target,
          pending: document.getElementById('app')!.classList.contains('meo-window-focus-return-pending'),
          range: target instanceof HTMLInputElement ? [target.selectionStart, target.selectionEnd, target.selectionDirection] : null};
        chrome.remove(); return {during, after};
      }, {owner, tag});
      assert.equal(result.during.focused, true, `${owner}/${tag}: blank chrome changed the return owner`);
      assert.equal(result.during.prevented, true, `${owner}/${tag}: blank chrome may not take native focus`);
      assert.equal(result.during.pending, true, `${owner}/${tag}: activation paint ended before release`);
      if (owner === 'registered') assert.equal(result.during.calls, 0, 'blank chrome must not transfer an input owner into the editor');
      assert.deepEqual(result.after, {focused: true, pending: false, range: owner === 'registered' ? [2, 7, 'backward'] : null},
        `${owner}/${tag}: blank chrome did not settle with its accepted owner`);
    }
  }
  for (const invalidation of ['hidden', 'disabled', 'readOnly', 'unregister'] as const) {
    const result = await frame.evaluate(invalidation => {
      const fixture = (window as any).fixture;
      const {state, controller} = fixture;
      const input = document.getElementById('registered') as HTMLInputElement;
      input.focus(); window.dispatchEvent(new Event('blur')); input.blur();
      if (invalidation === 'unregister') fixture.unregister();
      else input[invalidation] = true;
      state.calls = 0; const restored = controller.restoreFromHost();
      const result = {restored, calls: state.calls, focused: document.activeElement?.id};
      if (invalidation === 'unregister') fixture.unregister = controller.registerInput(input);
      else input[invalidation] = false;
      return result;
    }, invalidation);
    assert.deepEqual(result, {restored: 'editor', calls: 1, focused: 'editor'}, `${invalidation} input must fall back to the editable document`);
  }
  const preview = await frame.evaluate(() => {
    const {state, controller} = (window as any).fixture;
    const input = document.getElementById('registered') as HTMLInputElement;
    state.editable = false; input.focus(); input.setSelectionRange(3, 3);
    window.dispatchEvent(new Event('blur')); input.blur(); input.setSelectionRange(0, 0); state.calls = 0;
    const restored = controller.restoreFromHost();
    const result = {restored, calls: state.calls, focused: document.activeElement === input, start: input.selectionStart};
    window.dispatchEvent(new Event('blur')); input.blur(); input.hidden = true;
    const invalidated = controller.restoreFromHost();
    input.hidden = false; state.editable = true;
    return {result, invalidated, calls: state.calls};
  });
  assert.deepEqual(preview, {result: {restored: 'input', calls: 0, focused: true, start: 3}, invalidated: false, calls: 0},
    'Preview may restore its input but never fall back to the hidden editor');
  const modal = await frame.evaluate(() => {
    const {state, controller} = (window as any).fixture;
    const input = document.getElementById('registered') as HTMLInputElement;
    input.focus(); window.dispatchEvent(new Event('blur')); input.blur();
    const dialog = document.createElement('dialog'); dialog.innerHTML = '<button>Modal owner</button>'; document.body.append(dialog); dialog.showModal();
    (document.activeElement as HTMLElement).blur(); state.calls = 0;
    const restored = controller.restoreFromHost(); const result = {restored, calls: state.calls};
    dialog.close(); dialog.remove(); return result;
  });
  assert.deepEqual(modal, {restored: false, calls: 0}, 'a modal must block old input and document recovery');
  const blankPointer = await frame.evaluate(() => {
    const {state, controller} = (window as any).fixture;
    const input = document.getElementById('registered') as HTMLInputElement;
    input.focus(); document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); input.blur();
    window.dispatchEvent(new Event('blur')); state.calls = 0; window.dispatchEvent(new Event('focus'));
    return {restored: controller.restoreFromHost(), calls: state.calls, focused: document.activeElement?.id};
  });
  assert.deepEqual(blankPointer, {restored: false, calls: 0, focused: ''}, 'an outside blank click must not resurrect the former input');
  const previewToolbar = await frame.evaluate(async () => {
    const {state} = (window as any).fixture;
    const editor = document.getElementById('editor')!;
    const preview = document.createElement('iframe');
    const button = document.createElement('button');
    document.getElementById('app')!.append(preview, button);
    editor.focus();
    preview.contentDocument!.body.tabIndex = -1;
    preview.contentDocument!.body.focus();
    state.calls = 0;
    const press = new PointerEvent('pointerdown', {bubbles: true, cancelable: true, pointerId: 73, button: 0});
    button.dispatchEvent(press);
    button.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerId: 73, button: 0}));
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    const result = {calls: state.calls, focused: document.activeElement === preview, prevented: press.defaultPrevented};
    preview.remove(); button.remove(); return result;
  });
  assert.deepEqual(previewToolbar, {calls: 0, focused: true, prevented: false},
    'toolbar borrowing cannot restore stale editor ownership over a focused Preview iframe');
  const disposed = await frame.evaluate(() => {
    const {controller} = (window as any).fixture;
    const input = document.getElementById('registered') as HTMLInputElement;
    input.focus(); window.dispatchEvent(new Event('blur')); input.blur();
    controller.dispose(); window.dispatchEvent(new Event('focus'));
    return {focused: document.activeElement === input, pending: input.classList.contains('meo-input-focus-return-pending')};
  });
  assert.deepEqual(disposed, {focused: false, pending: false}, 'disposal must cancel input recovery and paint guards');
  assert.deepEqual(errors, [], 'focus handlers must not throw');
  await page.close();
} finally {
  await closeTestBrowser(browser);
}
console.log('Editor window-return document focus ownership checks passed; desktop switching still needs manual validation.');
