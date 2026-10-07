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
  page.setDefaultTimeout(5000);
  await page.setContent('<input id="other-input"><iframe id="meo" srcdoc="<div id=editor contenteditable=true>Fixture</div>"></iframe>');
  const frame = await (await page.waitForSelector('#meo'))!.contentFrame();
  assert.ok(frame);
  await frame.waitForSelector('#editor');
  await frame.addScriptTag({ content: await bundle.outputs[0]!.text() });
  await frame.evaluate(() => {
    const target = document.getElementById('editor')!;
    const state = { calls: 0 };
    const controller = (window as any).FocusController.createEditorFocusController({
      root: target,
      getEditor: () => ({
        view: {dom: target},
        hasFocus: () => document.hasFocus() && document.activeElement === target,
        focus: () => {state.calls++; target.focus();}
      }),
      isEditableMode: () => true
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
  assert.deepEqual(ownReturn, {hasDocumentFocus: true, restored: true, calls: 1, editorFocused: true},
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
  await frame.evaluate(() => (window as any).fixture.controller.dispose());
  await page.close();
} finally {
  await closeTestBrowser(browser);
}
console.log('Editor window-return document focus ownership checks passed; desktop switching still needs manual validation.');
