import { readFileSync } from 'node:fs';
import { shortcutSections } from '../webview/src/application/settingsCatalog';
import assert from 'node:assert/strict';
import { defaultInputAssistance, editorCommandIds, isEditingPreferencesChange } from '../src/foundation/editingPreferences';
import {
  canBindCommand, changeEditingPreferences, defaultShortcuts, effectiveShortcuts,
  normalizeEditingPreferences, normalizeShortcut, resolveShortcut, shortcutConflicts, shortcutFromStroke
} from '../src/application/editingPreferences';
import { createEditingPreferencesHost } from '../src/host/editingPreferences';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import { createEditingPreferencesTransport } from '../webview/src/adapters/editingPreferencesTransport';
import type { EditingPreferences } from '../src/foundation/editingPreferences';
import type { UpdateEditingPreferencesRequest } from '../src/protocol/editingPreferences';

const defaults = { input: { ...defaultInputAssistance }, shortcuts: {} };
assert.equal(defaults.input.selectionToolbar, true, 'existing users keep the selection toolbar by default');
const { selectionToolbar: _toolbar, ...previousInput } = defaultInputAssistance;
assert.deepEqual(normalizeEditingPreferences({ input: { ...previousInput, emoji: true }, shortcuts: { bold: [] } }), {
  input: { ...defaultInputAssistance, emoji: true }, shortcuts: { bold: [] }
}, 'older saved preferences gain the default without losing other choices');
for (const value of [true, false]) {
  const change = { type: 'input' as const, key: 'selectionToolbar' as const, value };
  assert.ok(decodeWebviewToHostMessage({ type: 'updateEditingPreferences', requestId: 'toolbar', change }));
  assert.equal(changeEditingPreferences(defaults, change, 'other').input.selectionToolbar, value);
}
assert.equal(isEditingPreferencesChange({ type: 'input', key: 'selectionToolbar', value: 'off' }), false);
assert.equal(normalizeEditingPreferences({ input: { selectionToolbar: 'off' } }).input.selectionToolbar, true);
for (const platform of ['mac', 'other'] as const) {
  const bindings = defaultShortcuts(platform);
  assert.deepEqual(Object.keys(bindings), editorCommandIds);
  const primary = platform === 'mac' ? 'Cmd' : 'Ctrl';
  assert.deepEqual(bindings.bold, [`${primary} + B`]);
  for (const command of editorCommandIds.filter(canBindCommand)) {
    for (const key of bindings[command]) assert.equal(normalizeShortcut(key), key, `${command}: ${key}`);
  }
  assert.deepEqual(shortcutConflicts('italic', [`${primary} + B`], {}, platform), ['bold']);
  assert.deepEqual(shortcutConflicts('cellBreak', ['Shift + Enter'], {}, platform), []);
  const changed = changeEditingPreferences(defaults, { type: 'bind', command: 'italic', keys: [`${primary} + B`], replaceConflicts: true }, platform);
  assert.deepEqual(effectiveShortcuts(changed.shortcuts, platform).bold, []);
  assert.deepEqual(effectiveShortcuts(changed.shortcuts, platform).italic, [`${primary} + B`]);
  assert.throws(() => changeEditingPreferences(defaults, { type: 'bind', command: 'italic', keys: [`${primary} + B`], replaceConflicts: false }, platform));
  assert.throws(() => changeEditingPreferences(defaults, { type: 'bind', command: 'italic', keys: [`${primary} + C`], replaceConflicts: true }, platform));
  const reset = changeEditingPreferences(changed, { type: 'resetShortcuts' }, platform);
  assert.deepEqual(reset, defaults);
  assert.equal(resolveShortcut({ key: 'b', code: 'KeyB', ctrl: platform === 'other', meta: platform === 'mac', alt: false, shift: false }, {}, platform, 'editor'), 'bold');
  assert.equal(resolveShortcut({ key: 'b', code: 'KeyB', ctrl: platform === 'other', meta: platform === 'mac', alt: false, shift: false }, {}, platform, 'global'), null);
}

const replacedRedo = changeEditingPreferences(defaults, { type: 'bind', command: 'bold', keys: ['Ctrl + Shift + Z'], replaceConflicts: true }, 'other');
assert.deepEqual(effectiveShortcuts(replacedRedo.shortcuts, 'other').redo, ['Ctrl + Y']);
assert.deepEqual(defaults.shortcuts, {});
assert.equal(normalizeShortcut('shift + control + b'), 'Ctrl + Shift + B');
assert.equal(normalizeShortcut('ctrl + /'), 'Ctrl + /');
assert.equal(normalizeShortcut('Alt + ↑'), 'Alt + ArrowUp');
assert.equal(normalizeShortcut('F12'), 'F12');
for (const key of ['', 'x', 'Shift + X', 'Ctrl', 'Ctrl + Ctrl + B', 'Tab', 'Shift + Tab', 'Escape', 'F25', 'Mouse1']) assert.equal(normalizeShortcut(key), null, key);
const stroke = { key: '中', code: 'KeyB', ctrl: true, meta: false, alt: false, shift: false };
assert.equal(shortcutFromStroke(stroke), 'Ctrl + B');
assert.equal(shortcutFromStroke({ ...stroke, composing: true }), null);
assert.equal(shortcutFromStroke({ ...stroke, altGraph: true }), null);
for (const key of ['input', 'bind', 'resetShortcuts']) assert.equal(isEditingPreferencesChange({ type: key }), key === 'resetShortcuts');
assert.equal(isEditingPreferencesChange({ type: 'input', key: 'pairMode', value: true }), false);
assert.equal(isEditingPreferencesChange({ type: 'input', key: '__proto__', value: true }), false);
assert.deepEqual(normalizeEditingPreferences({ input: { emoji: true, pairMode: 'invalid', lists: 1 }, shortcuts: { save: [], bold: ['Q'], unknown: ['Ctrl + P'] } }), {
  input: { ...defaultInputAssistance, emoji: true }, shortcuts: { save: [] }
});
assert.deepEqual(normalizeEditingPreferences({ input: JSON.parse('{"__proto__":"always","constructor":"off","toString":"smart"}') }), defaults, 'prototype names are not input preferences');
assert.equal(decodeWebviewToHostMessage({ type: 'updateEditingPreferences', requestId: 'x', change: { type: 'input', key: 'pairMode', value: 'invalid' } }), null);
assert.equal(decodeWebviewToHostMessage({ type: 'updateEditingPreferences', requestId: '', change: { type: 'resetShortcuts' } }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'editingPreferencesChanged', preferences: { input: {}, shortcuts: {} } }), null);

let persisted: EditingPreferences = defaults;
let writes = 0;
const host = createEditingPreferencesHost({ platform: 'other', read: () => persisted, write: async value => {
  await Promise.resolve(); persisted = value; writes++;
} });
const request = { type: 'updateEditingPreferences' as const, requestId: 'first', change: { type: 'input' as const, key: 'emoji' as const, value: true } };
const [first, duplicate, second] = await Promise.all([
  host.update(request), host.update(request), host.update({ ...request, requestId: 'second', change: { type: 'input', key: 'pasteUrl', value: false } })
]);
assert.deepEqual(first, duplicate);
assert.equal(second.result.ok, true);
assert.equal(writes, 2);
assert.ok(second.revision > first.revision);
const reused = await host.update({ ...request, change: { type: 'resetShortcuts' } });
assert.equal(reused.result.ok, false);
assert.equal(writes, 2);
const reloaded = createEditingPreferencesHost({ platform: 'other', read: () => persisted, write: async () => {} });
assert.deepEqual(reloaded.read(), persisted);
assert.equal(persisted.input.emoji, true);
assert.equal(persisted.input.pasteUrl, false);
const toolbarResponse = await host.update({ type: 'updateEditingPreferences', requestId: 'toolbar', change: { type: 'input', key: 'selectionToolbar', value: false } });
assert.equal(toolbarResponse.result.ok, true);
assert.equal(reloaded.read().input.selectionToolbar, false, 'the disabled toolbar survives a new Host instance');
assert.equal(changeEditingPreferences(persisted, { type: 'resetShortcuts' }, 'other').input.selectionToolbar, false);
const failing = createEditingPreferencesHost({ platform: 'other', read: () => persisted, write: async () => { throw new Error('disk failure'); } });
const failure = await failing.update({ ...request, requestId: 'failed' });
assert.equal(failure.result.ok, false);
assert.deepEqual(failing.read(), persisted);
assert.ok(decodeHostToWebviewMessage(first));

const requests: UpdateEditingPreferencesRequest[] = [];
const timers = new Map<number, () => void>();
let timerId = 0;
const transport = createEditingPreferencesTransport({
  post: request => requests.push(request), requestPrefix: 'test',
  schedule: callback => { timers.set(++timerId, callback); return timerId; }, cancel: id => { timers.delete(id as number); }
});
const pending = transport.update({ type: 'resetShortcuts' });
assert.equal(transport.accept({ type: 'updatedEditingPreferences', requestId: 'unknown', revision: 0, result: { ok: true, value: defaults } }), false);
assert.equal(transport.accept({ type: 'updatedEditingPreferences', requestId: requests[0].requestId, revision: 0, result: { ok: true, value: defaults } }), true);
assert.deepEqual(await pending, { ok: true, value: defaults });
assert.equal(timers.size, 0);
const timeout = transport.update({ type: 'resetShortcuts' });
timers.values().next().value!();
assert.equal((await timeout).ok, false);
assert.equal(transport.accept({ type: 'updatedEditingPreferences', requestId: requests[1].requestId, revision: 0, result: { ok: true, value: defaults } }), false);
const disposed = transport.update({ type: 'resetShortcuts' });
transport.dispose();
assert.equal((await disposed).ok, false);
assert.equal(timers.size, 0);
assert.equal((await transport.update({ type: 'resetShortcuts' })).ok, false);
console.log('Editing preferences: platform defaults, contexts, replacement, validation, Host merge/write failures, correlation, timeout and disposal passed');

assert.deepEqual(new Set(Object.values(shortcutSections).flat()), new Set(editorCommandIds));
assert.deepEqual(normalizeEditingPreferences({ shortcuts: { bold: ['ctrl + b', 'Ctrl + B'] } }).shortcuts, { bold: ['Ctrl + B'] });
let raceValue = defaults;
const raceHost = createEditingPreferencesHost({ platform: 'other', read: () => raceValue, write: async value => { raceValue = { ...value, input: { ...value.input, emoji: false } }; } });
const race = await raceHost.update(request);
assert.deepEqual(race.result, { ok: true, value: raceValue }, 'acknowledgement carries the authoritative post-write value');

const schema = JSON.parse(readFileSync('package.json', 'utf8')).contributes.configuration.properties['meoEnhanced.editing.preferences'];
assert.deepEqual(new Set(schema.properties.shortcuts.propertyNames.enum), new Set(editorCommandIds.filter(canBindCommand)));
assert.deepEqual(schema.default, defaults);
