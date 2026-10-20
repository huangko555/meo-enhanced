import { readFileSync } from 'node:fs';
import { appearanceCatalog, generalSearchKeywords, imageLocationSearchKeywords, settingsSearchMatches, shortcutSearchKeywords, shortcutSections, typingSearchKeywords } from '../webview/src/application/settingsCatalog';
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
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

assert.deepEqual(Object.keys(generalSearchKeywords).sort(), ['lineNumbers', 'foldCode', 'width', 'strongColor', 'boldHeadings', 'stickyHeader', 'restorePosition', 'largeDocument', 'language'].sort());
assert.deepEqual(appearanceCatalog.map(item => item.id).sort(), ['mode', 'fontSize', 'lineHeight', 'surface', 'documentBackground', 'text', 'accent', 'textEmphasis', 'success', 'warning', 'danger'].sort());
assert.deepEqual(Object.keys(typingSearchKeywords).sort(), Object.keys(defaultInputAssistance).sort(), 'every input setting has search aliases');
assert.deepEqual(Object.keys(shortcutSearchKeywords).sort(), [...editorCommandIds].sort(), 'every shortcut has search aliases');
for (const [zh, en] of [...Object.values(generalSearchKeywords), ...appearanceCatalog.map(item => item.keywords), ...Object.values(typingSearchKeywords), imageLocationSearchKeywords, ...Object.values(shortcutSearchKeywords)]) {
  assert.match(zh, /[\u4e00-\u9fff]/); assert.match(en, /[a-z]/i);
}
assert.ok(settingsSearchMatches('  STORAGE   图片  ', '图片保存位置', 'Image storage folder'));
assert.ok(settingsSearchMatches('text plain', 'Paste as plain text'));
assert.ok(settingsSearchMatches('ＣＴＲＬ ＋ Ｂ', 'Ctrl + B'));
assert.ok(settingsSearchMatches('ctrl+b', 'Ctrl + B'));
assert.ok(settingsSearchMatches(' ', 'anything'));
assert.ok(settingsSearchMatches('_', 'symbols * _ ~'));
assert.equal(settingsSearchMatches('image theme', 'Image storage folder'), false, 'all query terms must match the same setting');
assert.equal(settingsSearchMatches('csv table', 'CSV only'), false);
const defaults = { input: { ...defaultInputAssistance }, shortcuts: {} };
assert.equal(defaults.input.selectionToolbar, true, 'existing users keep the selection toolbar by default');
assert.equal(defaults.input.pasteHtml, false, 'HTML paste formatting is disabled by default');
assert.equal(normalizeEditingPreferences(undefined).input.pasteHtml, false);
const { math: _math, ...beforeMath } = defaultInputAssistance;
assert.equal(normalizeEditingPreferences({ input: beforeMath }).input.math, true, 'older preferences enable math completion');
assert.equal(normalizeEditingPreferences({ input: { math: false } }).input.math, false);
assert.equal(normalizeEditingPreferences({ input: { math: 'off' } }).input.math, true);
assert.equal(normalizeEditingPreferences({ input: { math: false } }).input.html, true, 'older preferences retain HTML completion');
assert.equal(normalizeEditingPreferences({ input: { html: false } }).input.html, false);
assert.equal(normalizeEditingPreferences({ input: { html: 'off' } }).input.html, true);
for (const value of [true, false]) {
  const change = { type: 'input' as const, key: 'html' as const, value };
  assert.ok(decodeWebviewToHostMessage({ type: 'updateEditingPreferences', requestId: 'html', change }));
  assert.equal(changeEditingPreferences(defaults, change, 'other').input.html, value);
}
for (const value of [true, false]) {
  const change = { type: 'input' as const, key: 'math' as const, value };
  assert.ok(decodeWebviewToHostMessage({ type: 'updateEditingPreferences', requestId: 'math', change }));
  assert.equal(changeEditingPreferences(defaults, change, 'other').input.math, value);
}
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
  assert.deepEqual(bindings.formatHtml, ['Alt + Shift + F']);
  const formatStroke = { key: 'f', code: 'KeyF', ctrl: false, meta: false, alt: true, shift: true };
  assert.equal(resolveShortcut(formatStroke, {}, platform, 'editor'), 'formatHtml');
  assert.equal(resolveShortcut(formatStroke, {}, platform, 'global'), null, 'Preview cannot format a hidden HTML fragment');
  assert.equal(resolveShortcut(formatStroke, { formatHtml: [] }, platform, 'editor'), null);
  assert.equal(resolveShortcut(formatStroke, { bold: ['Alt + Shift + F'] }, platform, 'editor'), 'bold', 'new formatting default respects older custom bindings');
  assert.deepEqual(effectiveShortcuts({ bold: ['Alt + Shift + F'] }, platform).formatHtml, []);
  assert.deepEqual(shortcutConflicts('italic', ['Alt + Shift + F'], {}, platform), ['formatHtml']);
  const formatBinding = changeEditingPreferences(defaults, { type: 'bind', command: 'formatHtml', keys: [`${primary} + Alt + L`], replaceConflicts: false }, platform);
  assert.deepEqual(effectiveShortcuts(formatBinding.shortcuts, platform).formatHtml, [`${primary} + Alt + L`]);
  assert.equal(resolveShortcut(formatStroke, formatBinding.shortcuts, platform, 'editor'), null);
  const saveAsKey = `${primary} + Shift + S`;
  assert.deepEqual(bindings.saveAs, [saveAsKey]);
  const legacySaveAsChord = { bold: [saveAsKey] };
  assert.deepEqual(effectiveShortcuts(legacySaveAsChord, platform).saveAs, [], 'new Save As default does not steal an older custom binding');
  assert.deepEqual(effectiveShortcuts(legacySaveAsChord, platform).bold, [saveAsKey]);
  assert.equal(resolveShortcut({ key: 's', code: 'KeyS', ctrl: platform === 'other', meta: platform === 'mac', alt: false, shift: true },
    legacySaveAsChord, platform, 'editor'), 'bold', 'the existing custom command keeps ownership of the new default chord');
  assert.deepEqual(shortcutConflicts('italic', [saveAsKey], {}, platform), ['saveAs']);
  const saveAs = changeEditingPreferences(defaults, { type: 'bind', command: 'saveAs', keys: [saveAsKey], replaceConflicts: false }, platform);
  assert.deepEqual(effectiveShortcuts(saveAs.shortcuts, platform).saveAs, [saveAsKey]);
  assert.deepEqual(shortcutConflicts('saveAs', [`${primary} + S`], {}, platform), ['save']);
  for (const context of ['global', 'editor', 'table'] as const) {
    const stroke = { key: 's', code: 'KeyS', ctrl: platform === 'other', meta: platform === 'mac', alt: false, shift: true };
    assert.equal(resolveShortcut(stroke, saveAs.shortcuts, platform, context), 'saveAs');
    assert.equal(resolveShortcut(stroke, { saveAs: [] }, platform, context), null);
  }
  assert.deepEqual(changeEditingPreferences(saveAs, { type: 'resetShortcuts' }, platform), defaults);
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
for (const platform of ['mac', 'other'] as const) {
  const primary = { ctrl: platform === 'other', meta: platform === 'mac', alt: false, shift: false };
  const modifier = platform === 'mac' ? 'Cmd' : 'Ctrl';
  for (const slash of [
    { key: '/', code: 'Slash' }, { key: '/', code: 'NumpadDivide' },
    { key: '／', code: 'Slash' }, { key: '/', code: 'Digit7', shift: true }
  ]) {
    const event = { ...primary, ...slash };
    assert.equal(shortcutFromStroke(event), `${modifier} + /`, `${platform}: ${slash.code}/${slash.key}`);
    for (const context of ['editor', 'table'] as const) {
      assert.equal(resolveShortcut(event, {}, platform, context), 'lineComment');
      assert.equal(resolveShortcut(event, { lineComment: [] }, platform, context), null);
      assert.equal(resolveShortcut(event, { lineComment: [`${modifier} + J`] }, platform, context), null);
      assert.equal(resolveShortcut(event, { lineComment: [], bold: [`${modifier} + /`] }, platform, context), 'bold');
    }
    assert.equal(shortcutFromStroke({ ...event, composing: true }), null);
    assert.equal(shortcutFromStroke({ ...event, altGraph: true }), null);
  }
  assert.equal(shortcutFromStroke({ ...primary, key: '/', code: 'Slash', shift: true }), `${modifier} + Shift + /`, 'an explicit Shift binding on the slash key is preserved');
  assert.equal(shortcutFromStroke({ ...primary, key: '?', code: 'Slash', shift: true }), `${modifier} + Shift + ?`, 'other punctuation bindings are preserved');
  const shiftedSlash = { ...primary, key: '/', code: 'Digit7', shift: true };
  for (const context of ['editor', 'table'] as const) {
    assert.equal(resolveShortcut(shiftedSlash, { lineComment: [`${modifier} + Shift + /`] }, platform, context), 'lineComment', 'previously recorded layout bindings still work');
    assert.equal(resolveShortcut(shiftedSlash, { bold: [`${modifier} + Shift + /`] }, platform, context), 'bold', 'an existing explicit binding takes priority over the default slash gesture');
  }
}
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
const saveAsRequest = { type: 'updateEditingPreferences' as const, requestId: 'save-as-binding',
  change: { type: 'bind' as const, command: 'saveAs' as const, keys: ['Ctrl + Shift + S'], replaceConflicts: false } };
assert.ok(decodeWebviewToHostMessage(saveAsRequest));
const saveAsResponse = await host.update(saveAsRequest);
assert.equal(saveAsResponse.result.ok, true);
assert.ok(decodeHostToWebviewMessage(saveAsResponse));
assert.deepEqual(reloaded.read().shortcuts.saveAs, ['Ctrl + Shift + S'], 'Save As bindings survive a new Host instance');
const formatRequest = { type: 'updateEditingPreferences' as const, requestId: 'html-format-binding',
  change: { type: 'bind' as const, command: 'formatHtml' as const, keys: ['Ctrl + Alt + L'], replaceConflicts: false } };
assert.ok(decodeWebviewToHostMessage(formatRequest));
assert.equal((await host.update(formatRequest)).result.ok, true);
assert.deepEqual(reloaded.read().shortcuts.formatHtml, ['Ctrl + Alt + L'], 'HTML formatting binding persists through Host');
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
assert.equal(schema.properties.input.properties.pasteHtml.default, false);

let savedGlobal: Partial<EditingPreferences> | undefined;
let savedWorkspace: Partial<EditingPreferences> | undefined;
let failedConfigurationTarget: number | undefined;
const configurationWrites: number[] = [];
const createMigrationStore = () => {
  const values = new Map<string, unknown>();
  const writes: { key: string; value: unknown }[] = [];
  return {
    get<T>(key: string, fallback?: T): T { return (values.has(key) ? values.get(key) : fallback) as T; },
    update: async (key: string, value: unknown) => { values.set(key, value); writes.push({ key, value }); },
    writes
  };
};
const createMigrationState = () => ({ globalState: createMigrationStore(), workspaceState: createMigrationStore() });
mock.module('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  workspace: { getConfiguration: () => ({
    inspect: () => ({ globalValue: savedGlobal, workspaceValue: savedWorkspace }),
    get: () => normalizeEditingPreferences({
      input: { ...savedGlobal?.input, ...savedWorkspace?.input },
      shortcuts: { ...savedGlobal?.shortcuts, ...savedWorkspace?.shortcuts }
    }),
    update: async (_key: string, value: EditingPreferences, target: number) => {
      if (target === failedConfigurationTarget) throw new Error('settings write failed');
      configurationWrites.push(target);
      if (target === 1) savedGlobal = value; else savedWorkspace = value;
    }
  }) }
}));
const { createVscodeEditingPreferences } = await import('../src/host/vscodeEditingPreferences');
for (const language of ['zh-CN', 'en'] as const) {
  savedGlobal = undefined; savedWorkspace = undefined; configurationWrites.length = 0;
  const migrationState = createMigrationState();
  const initialized = await createVscodeEditingPreferences(language, migrationState);
  assert.equal(initialized.read().input.pasteHtml, false);
  assert.equal(initialized.read().input.slashPreferAbove, language === 'zh-CN');
  assert.deepEqual(configurationWrites, [1], 'the language-derived default is immediately persisted globally');
  const later = await createVscodeEditingPreferences(language === 'zh-CN' ? 'en' : 'zh-CN', migrationState);
  assert.equal(later.read().input.slashPreferAbove, language === 'zh-CN', 'language changes preserve the initial value without a manual toggle');
  assert.deepEqual(configurationWrites, [1], 'reloading does not initialize twice');
  await initialized.update({ type: 'updateEditingPreferences', requestId: 'placement', change: { type: 'input', key: 'slashPreferAbove', value: language !== 'zh-CN' } });
  assert.equal((await createVscodeEditingPreferences(language, migrationState)).read().input.slashPreferAbove, language !== 'zh-CN', 'explicit changes survive restart');
}
savedGlobal = { input: { ...defaultInputAssistance, emoji: true, pasteUrl: false }, shortcuts: { bold: [] } };
delete (savedGlobal.input as { slashPreferAbove?: boolean }).slashPreferAbove;
savedWorkspace = { input: { ...defaultInputAssistance, slashPreferAbove: false, pasteHtml: false } };
configurationWrites.length = 0;
const slashMigrationState = createMigrationState();
const migrated = await createVscodeEditingPreferences('zh-CN', slashMigrationState);
assert.equal(savedGlobal.input!.slashPreferAbove, true);
assert.equal(savedGlobal.input!.emoji, true);
assert.equal(savedGlobal.input!.pasteUrl, false);
assert.deepEqual(savedGlobal.shortcuts, { bold: [] }, 'initialization preserves existing global choices');
assert.equal(migrated.read().input.slashPreferAbove, false, 'an existing workspace choice overrides the global default');
assert.equal(savedGlobal.input!.pasteHtml, false);
assert.deepEqual(configurationWrites, [1]);
savedWorkspace = undefined;
assert.equal((await createVscodeEditingPreferences('en', slashMigrationState)).read().input.slashPreferAbove, true);
assert.deepEqual(configurationWrites, [1]);
console.log('Slash menu preference: one-time language defaults, persistence, explicit choices and workspace overrides passed');

savedGlobal = { input: { ...defaultInputAssistance, pasteHtml: true, emoji: true, slashPreferAbove: true }, shortcuts: { bold: ['Alt + B'] } };
savedWorkspace = { input: { ...defaultInputAssistance, pasteHtml: true, pasteUrl: false }, shortcuts: { italic: ['Alt + I'] } };
const previousGlobal = structuredClone(savedGlobal);
const previousWorkspace = structuredClone(savedWorkspace);
configurationWrites.length = 0;
const migrationState = createMigrationState();
const upgraded = await createVscodeEditingPreferences('en', migrationState);
assert.equal(upgraded.read().input.pasteHtml, false, 'both old configuration scopes are disabled on upgrade');
assert.deepEqual(savedGlobal, { ...previousGlobal, input: { ...previousGlobal.input, pasteHtml: false } });
assert.deepEqual(savedWorkspace, { ...previousWorkspace, input: { ...previousWorkspace.input, pasteHtml: false } }, 'migration changes only pasteHtml, retaining input choices and shortcuts');
assert.deepEqual(configurationWrites, [1, 2]);
await upgraded.update({ type: 'updateEditingPreferences', requestId: 'enable-html-workspace', change: { type: 'input', key: 'pasteHtml', value: true } });
assert.equal((await createVscodeEditingPreferences('en', migrationState)).read().input.pasteHtml, true, 'a workspace opt-in survives restart after migration');
assert.deepEqual(configurationWrites, [1, 2, 2], 'completed migrations do not repeat');
assert.equal(migrationState.globalState.writes.length, 1);
assert.equal(migrationState.workspaceState.writes.length, 1);

savedWorkspace = undefined;
const userPreferences = await createVscodeEditingPreferences('en', migrationState);
await userPreferences.update({ type: 'updateEditingPreferences', requestId: 'enable-html-global', change: { type: 'input', key: 'pasteHtml', value: true } });
assert.equal((await createVscodeEditingPreferences('zh-CN', migrationState)).read().input.pasteHtml, true, 'a global opt-in survives restart after migration');
savedWorkspace = previousWorkspace;
configurationWrites.length = 0;
const otherWorkspaceState = { globalState: migrationState.globalState, workspaceState: createMigrationStore() };
assert.equal((await createVscodeEditingPreferences('en', otherWorkspaceState)).read().input.pasteHtml, false, 'an old workspace opened later migrates independently');
assert.equal(savedGlobal!.input!.pasteHtml, true, 'opening an old workspace preserves the migrated profile\'s new choice');
assert.deepEqual(configurationWrites, [2]);

savedGlobal = { input: { ...defaultInputAssistance, pasteHtml: false }, shortcuts: {} };
savedWorkspace = undefined;
configurationWrites.length = 0;
await createVscodeEditingPreferences('en', createMigrationState());
assert.deepEqual(configurationWrites, [], 'disabled and missing saved values need no configuration rewrite');

for (const target of [1, 2]) {
  savedGlobal = structuredClone(previousGlobal); savedWorkspace = structuredClone(previousWorkspace);
  configurationWrites.length = 0;
  const retryState = createMigrationState();
  failedConfigurationTarget = target;
  await assert.rejects(createVscodeEditingPreferences('en', retryState), /settings write failed/);
  const failedState = target === 1 ? retryState.globalState : retryState.workspaceState;
  assert.equal(failedState.writes.length, 0, 'a failed configuration write must not mark the migration complete');
  failedConfigurationTarget = undefined;
  const retried = await createVscodeEditingPreferences('en', retryState);
  assert.equal(retried.read().input.pasteHtml, false, 'a failed migration retries on the next activation');
  assert.deepEqual(configurationWrites, [1, 2], 'retry skips already completed configuration writes');
  assert.equal(retryState.globalState.writes.length, 1);
  assert.equal(retryState.workspaceState.writes.length, 1);
}
console.log('HTML paste preference: default off, one-time profile/workspace overrides, opt-in persistence and failed migration retries passed');
