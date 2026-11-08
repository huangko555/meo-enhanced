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
    const createController = (root: HTMLElement, editor: HTMLElement, owner = state) => (window as any).FocusController.createEditorFocusController({
      root,
      getEditor: () => ({
        view: {dom: editor},
        hasFocus: () => document.hasFocus() && document.activeElement === editor,
        focus: () => {owner.calls++; editor.focus();},
        retainViewportOnWindowReturn: () => () => {}
      }),
      isEditableMode: () => owner.editable
    });
    const controller = createController(document.getElementById('app')!, target);
    (window as any).fixture = {state, controller, createController};
  });
  await frame.focus('#editor');
  const coldBeforeReturn = await frame.evaluate(() => {
    const {state, controller} = (window as any).fixture;
    const app = document.getElementById('app')!;
    const editor = document.getElementById('editor')!;
    editor.blur(); app.inert = true; controller.armInitialEditorFocus(); state.calls = 0;
    return {calls: state.calls, documentFocused: document.hasFocus(), active: document.activeElement?.nodeName};
  });
  assert.deepEqual(coldBeforeReturn, {calls: 0, documentFocused: true, active: 'BODY'},
    'the inert cold fixture must retain intent without claiming the editor');
  await page.focus('#other-input');
  assert.equal(await frame.evaluate(() => document.hasFocus()), false,
    'the cold fixture must lose native document focus before return');
  await frame.evaluate(() => { (document.getElementById('app') as HTMLElement).inert = false; });
  await page.evaluate(() => (document.getElementById('meo') as HTMLIFrameElement).contentWindow!.focus());
  const coldInitial = await frame.evaluate(() => {
    const {state, controller} = (window as any).fixture;
    const editor = document.getElementById('editor')!;
    const afterNativeReturn = state.calls;
    controller.restoreFromHost();
    return {afterNativeReturn, afterHostEcho: state.calls, focused: document.activeElement === editor,
      documentFocused: document.hasFocus(), active: document.activeElement?.id ?? document.activeElement?.nodeName};
  });
  assert.deepEqual(coldInitial, {afterNativeReturn: 1, afterHostEcho: 1, focused: true,
    documentFocused: true, active: 'editor'},
    'cold startup focus must wait for a ready native return and ignore a late Host echo');
  const canceledColdInitial = await frame.evaluate(() => {
    const {createController} = (window as any).fixture;
    const app = document.getElementById('app')!;
    const createFixture = () => {
      const root = document.createElement('section');
      const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.textContent = 'Cold fixture';
      root.append(editor); app.append(root);
      const state = {calls: 0, editable: true};
      return {root, editor, state, controller: createController(root, editor, state)};
    };
    const inputFixture = createFixture();
    const input = document.createElement('input'); inputFixture.root.append(input); input.focus();
    inputFixture.controller.armInitialEditorFocus(); input.blur();
    const inputResult = inputFixture.controller.restoreInitialEditorFocusIfReady();
    const previewFixture = createFixture();
    previewFixture.controller.armInitialEditorFocus(); previewFixture.state.editable = false;
    const previewResult = previewFixture.controller.restoreInitialEditorFocusIfReady();
    const modalFixture = createFixture();
    modalFixture.controller.armInitialEditorFocus();
    const dialog = document.createElement('dialog'); document.body.append(dialog); dialog.showModal();
    const modalResult = modalFixture.controller.restoreInitialEditorFocusIfReady();
    dialog.close(); dialog.remove();
    const result = {
      input: {result: inputResult, calls: inputFixture.state.calls},
      preview: {result: previewResult, calls: previewFixture.state.calls},
      modal: {result: modalResult, calls: modalFixture.state.calls}
    };
    for (const fixture of [inputFixture, previewFixture, modalFixture]) {
      fixture.controller.dispose(); fixture.root.remove();
    }
    return result;
  });
  assert.deepEqual(canceledColdInitial, {
    input: {result: false, calls: 0}, preview: {result: false, calls: 0}, modal: {result: false, calls: 0}
  }, 'new input, Preview, and modal ownership must cancel startup focus intent');
  for (const nextOwner of ['input', 'command'] as const) {
    const controlPage = await browser.newPage();
    try {
      await controlPage.setContent('<input id="outside"><iframe id="control-frame" srcdoc="<main id=app><div id=editor contenteditable=true>Initial text</div><input id=next-input><button id=next-command>Open input</button></main>"></iframe>');
      const controlFrame = await (await controlPage.waitForSelector('#control-frame'))!.contentFrame();
      assert.ok(controlFrame);
      await controlFrame.addScriptTag({content: await bundle.outputs[0]!.text()});
      await controlFrame.evaluate(() => {
        const root = document.getElementById('app')!;
        const editor = document.getElementById('editor')!;
        const input = document.getElementById('next-input') as HTMLInputElement;
        const state = {calls: 0, commandCalls: 0};
        const controller = (window as any).FocusController.createEditorFocusController({
          root, getEditor: () => ({view: {dom: editor},
            hasFocus: () => document.hasFocus() && document.activeElement === editor,
            focus: () => {state.calls++; editor.focus();}, retainViewportOnWindowReturn: () => () => {}}),
          isEditableMode: () => true
        });
        controller.registerInput(input);
        document.getElementById('next-command')!.addEventListener('click', () => {state.commandCalls++; input.focus();});
        root.inert = true;
        controller.armInitialEditorFocus();
        (window as any).nextOwnerFixture = {root, state, controller};
      });
      await controlPage.focus('#outside');
      await controlFrame.evaluate(() => { (window as any).nextOwnerFixture.root.inert = false; });
      await controlPage.evaluate(() => document.querySelector<HTMLIFrameElement>('#control-frame')!.contentWindow!.focus());
      assert.deepEqual(await controlFrame.evaluate(() => ({
        calls: (window as any).nextOwnerFixture.state.calls,
        editor: document.activeElement?.id
      })), {calls: 1, editor: 'editor'}, 'an unclaimed native BODY return must connect input synchronously');
      await controlFrame.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      await controlFrame.click(nextOwner === 'input' ? '#next-input' : '#next-command');
      await controlPage.keyboard.type('NEXT_OWNER');
      const afterNewOwner = await controlFrame.evaluate(async () => {
        const fixture = (window as any).nextOwnerFixture;
        fixture.controller.restoreFromHost();
        for (let frame = 0; frame < 4; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        return {calls: fixture.state.calls, commandCalls: fixture.state.commandCalls,
          active: document.activeElement?.id, text: (document.getElementById('next-input') as HTMLInputElement).value};
      });
      assert.deepEqual(afterNewOwner, {calls: 1, commandCalls: nextOwner === 'command' ? 1 : 0,
        active: 'next-input', text: 'NEXT_OWNER'}, `${nextOwner}: a later control owns its first input and late Host echoes cannot restore the startup editor`);
    } finally { await controlPage.close(); }
  }
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
  // VS Code forwards unconsumed Ctrl+A and later echoes a native selectAll.
  // Hold that reply until two new characters exist, as in the native failure.
  for (const tag of ['input', 'textarea']) {
    await frame.evaluate(tag => {
      const scope = window as any, input = document.createElement(tag) as HTMLInputElement | HTMLTextAreaElement;
      input.id = 'select-all-target'; input.value = 'previous query'; document.getElementById('app')!.append(input);
      const unregister = scope.fixture.controller.registerInput(input);
      const platform = Object.getOwnPropertyDescriptor(navigator, 'platform');
      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
      const state = scope.selectAllState = { forwarded: 0, inputs: 0, pending: false };
      const forward = (event: KeyboardEvent) => {
        if (event.target === input && event.ctrlKey && event.key.toLowerCase() === 'a') {
          state.forwarded++; state.pending = true;
        }
      };
      const receive = () => {
        if (++state.inputs === 2 && state.pending) queueMicrotask(() => document.execCommand('selectAll'));
      };
      window.addEventListener('keydown', forward);
      input.addEventListener('input', receive);
      scope.cleanupSelectAll = () => {
        window.removeEventListener('keydown', forward); input.removeEventListener('input', receive);
        unregister(); input.remove();
        if (platform) Object.defineProperty(navigator, 'platform', platform); else delete (navigator as any).platform;
      };
    }, tag);
    try {
      await frame.focus('#select-all-target');
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
      await page.keyboard.type('N89[Stage 89]', { delay: 10 });
      const result = await frame.evaluate(() => ({ value: (document.getElementById('select-all-target') as HTMLInputElement).value,
        forwarded: (window as any).selectAllState.forwarded }));
      assert.deepEqual(result, { value: 'N89[Stage 89]', forwarded: 0 }, 'An echoed native selectAll must not erase a new input prefix');
      const ignored = await frame.evaluate(() => {
        const input = document.getElementById('select-all-target') as HTMLInputElement;
        const send = (options: KeyboardEventInit) => {
          const event = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true, ...options });
          input.dispatchEvent(event); return event.defaultPrevented;
        };
        const composing = send({ isComposing: true }), shifted = send({ shiftKey: true });
        input.readOnly = true; const readonly = send({}); input.readOnly = false;
        const external = document.createElement('input'); document.getElementById('app')!.append(external);
        const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
        external.dispatchEvent(event); external.remove();
        return { composing, shifted, readonly, unregistered: event.defaultPrevented };
      });
      assert.deepEqual(ignored, { composing: false, shifted: false, readonly: false, unregistered: false },
        'Native select-all ownership must leave other shortcuts, composition and unowned inputs alone');
    } finally { await frame.evaluate(() => (window as any).cleanupSelectAll()); }
  }
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
