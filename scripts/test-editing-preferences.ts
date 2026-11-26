import { readFileSync } from 'node:fs';
import { appearanceCatalog, customShortcutTitle, generalSearchKeywords, imageLocationSearchKeywords, settingsSearchMatches, shortcutSearchKeywords, shortcutSections, typingSearchKeywords } from '../webview/src/application/settingsCatalog';
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { customShortcutScopes, defaultInputAssistance, editorCommandIds, insertCurrentTimeExampleId, insertCurrentTimeExampleName, isCustomShortcut, isEditingPreferencesChange, shortcutTargetModes, type CustomShortcut, type EditorCommandId, type ShortcutReplacement } from '../src/foundation/editingPreferences';
import {
  builtinShortcutConflicts, canBindCommand, changeEditingPreferences, customShortcutCanRunAt, customShortcutConflicts, defaultShortcuts, effectiveShortcuts,
  normalizeEditingPreferences, normalizeShortcut, resolveShortcut, shortcutConflicts, shortcutFromStroke, shortcutReplacements, type ShortcutPlatform
} from '../src/application/editingPreferences';
import { createEditingPreferencesHost } from '../src/host/editingPreferences';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import { createEditingPreferencesTransport } from '../webview/src/adapters/editingPreferencesTransport';
import type { EditingPreferences } from '../src/foundation/editingPreferences';
import type { UpdateEditingPreferencesRequest } from '../src/protocol/editingPreferences';

assert.deepEqual(Object.keys(generalSearchKeywords).sort(), ['latexDelimiters', 'lineNumbers', 'foldCode', 'width', 'widthValue', 'boldHeadings', 'stickyHeader', 'restorePosition', 'largeDocument', 'language'].sort());
assert.deepEqual(appearanceCatalog.map(item => item.id).sort(), ['mode', 'fontSize', 'mouseWheelZoom', 'lineHeight', 'surface', 'documentBackground', 'text', 'caret', 'accent', 'textEmphasis', 'link', 'success', 'warning', 'danger'].sort());
const wheelSetting = appearanceCatalog.find(item => item.id === 'mouseWheelZoom')!;
for (const title of ['Ctrl + 滚轮调整字号', 'Cmd + 滚轮调整字号', 'Ctrl + wheel font size', 'Cmd + wheel font size']) {
  assert.ok(settingsSearchMatches(title, ...wheelSetting.title, ...wheelSetting.description, ...wheelSetting.keywords), `Search includes the displayed platform title: ${title}`);
}
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
const windowsBindings = defaultShortcuts('windows');
assert.deepEqual(windowsBindings.codeBlock, ['Ctrl + Shift + K']);
assert.deepEqual(windowsBindings.deleteLine, []);
assert.deepEqual(windowsBindings.cellBreak, ['Shift + Enter']);
assert.deepEqual(windowsBindings.rowBelow, ['Ctrl + Enter']);
assert.deepEqual(windowsBindings.lineComment, ['Ctrl + /']);
assert.deepEqual(windowsBindings.mode, ['Alt + Shift + M']);
assert.deepEqual(defaultShortcuts('other').deleteLine, ['Ctrl + Shift + K']);
assert.deepEqual(defaultShortcuts('mac').cellBreak, ['Shift + Enter', 'Ctrl + Enter']);
assert.deepEqual(effectiveShortcuts({ deleteLine: [] }, 'windows').codeBlock, [], 'An old explicit clear must not introduce a new action');
assert.deepEqual(effectiveShortcuts({ cellBreak: ['Ctrl + Enter'] }, 'windows').rowBelow, []);
assert.deepEqual(effectiveShortcuts({ bold: ['Alt + Shift + %'] }, 'windows').strike, []);
assert.deepEqual(shortcutConflicts('bold', ['Alt + Shift + %'], {}, 'windows'), ['strike']);
assert.deepEqual(shortcutConflicts('moveRowUp', ['Alt + ArrowUp'], {}, 'windows'), [], 'Text lines and table rows have disjoint built-in scopes');
const upStroke = { key: 'ArrowUp', code: 'ArrowUp', alt: true, ctrl: false, meta: false, shift: false };
assert.equal(resolveShortcut(upStroke, {}, 'windows', 'table'), 'moveRowUp');
assert.equal(resolveShortcut(upStroke, {}, 'windows', 'editor'), 'moveUp');
assert.equal(resolveShortcut(upStroke, { moveUp: [] }, 'windows', 'table'), null, 'An explicitly cleared move key stays clear');
const strikeStroke = { key: '%', code: 'Digit5', alt: true, ctrl: false, meta: false, shift: true };
assert.equal(resolveShortcut(strikeStroke, {}, 'windows', 'editor'), 'strike');
assert.equal(resolveShortcut(strikeStroke, { bold: ['Alt + Shift + %'] }, 'windows', 'editor'), 'bold');
const zoomStroke = { key: ')', code: 'Digit0', alt: false, ctrl: true, meta: false, shift: true };
for (const platform of ['windows', 'mac', 'other'] as const) {
  assert.deepEqual(defaultShortcuts(platform).resetWindowZoom, []);
}
assert.equal(resolveShortcut(zoomStroke, {}, 'windows', 'global'), null);
const savedZoom = normalizeEditingPreferences({ shortcuts: { resetWindowZoom: ['Ctrl + Shift + 0'] } });
assert.equal(resolveShortcut(zoomStroke, savedZoom.shortcuts, 'windows', 'global'), 'resetWindowZoom');
assert.deepEqual(shortcutConflicts('bold', ['Ctrl + Shift + )'], savedZoom.shortcuts, 'windows'), ['resetWindowZoom']);
const legacyRule: CustomShortcut = { id: 'legacy-file-key', name: 'File key', scope: 'editor',
  strokes: ['Ctrl + Shift + #'], actions: [{ type: 'snippet', template: 'existing' }] };
assert.deepEqual(effectiveShortcuts({}, 'windows', [legacyRule]).openFileTree, []);
assert.deepEqual(decodeWebviewToHostMessage({ type: 'openFileTree' }), { type: 'openFileTree' });
assert.deepEqual(decodeWebviewToHostMessage({ type: 'resetWindowZoom' }), { type: 'resetWindowZoom' });
const defaults = { input: { ...defaultInputAssistance }, shortcuts: {} };
const shortcutRule = {
  id: 'notes', name: 'Note template', scope: 'live', strokes: ['Ctrl + K', 'T'],
  actions: [{ type: 'snippet', template: '## ${1:Title}\n$0' }, { type: 'command', command: 'save' }]
} as const;
const saveCustom = (shortcut: CustomShortcut, confirmedReplacements: readonly ShortcutReplacement[] = []) =>
  ({ type: 'saveCustomShortcut', shortcut, confirmedReplacements } as const);
const confirmCustom = (shortcut: CustomShortcut, preferences: EditingPreferences) =>
  saveCustom(shortcut, shortcutReplacements(customShortcutConflicts(shortcut, preferences, 'other')));
const confirmBuiltin = (command: EditorCommandId, keys: readonly string[], preferences: EditingPreferences, platform: ShortcutPlatform = 'other') =>
  ({ type: 'bind', command, keys, confirmedReplacements: shortcutReplacements(builtinShortcutConflicts(command, keys, preferences, platform)) } as const);
const custom = changeEditingPreferences(defaults, saveCustom(shortcutRule), 'other');
assert.deepEqual(normalizeEditingPreferences(custom), custom);
const sameKeysInSource = { ...shortcutRule, id: 'source-notes', scope: 'source' } as const;
const disjoint = changeEditingPreferences(custom, saveCustom(sameKeysInSource), 'other');
assert.deepEqual(disjoint.customShortcuts, [shortcutRule, sameKeysInSource]);
const sharedPrefix = { ...shortcutRule, id: 'other-notes', strokes: ['Ctrl + K', 'O'] };
assert.equal(changeEditingPreferences(disjoint, saveCustom(sharedPrefix), 'other').customShortcuts?.length, 3);
assert.throws(() => changeEditingPreferences(disjoint, saveCustom({ ...shortcutRule, id: 'prefix', strokes: ['Ctrl + K'] }), 'other'), /already assigned/);
assert.throws(() => changeEditingPreferences(defaults, saveCustom({ ...shortcutRule, strokes: ['Ctrl + C'] },
  [{ type: 'command', command: 'copy', keys: ['Ctrl + C'] }]), 'other'), /already assigned/);
const tableAction = { type: 'command', command: 'rowDelete' } as const;
const proseAction = shortcutRule.actions[0];
const cellSnippet = { type: 'snippet', template: 'Time: ${CURRENT_HOUR}:$0${CURRENT_MINUTE}' } as const;
const mixed = { ...shortcutRule, id: 'mixed', scope: 'editor', strokes: ['Ctrl + Alt + K'], actions: [proseAction, tableAction] } as const;
assert.deepEqual(changeEditingPreferences(defaults, saveCustom(mixed), 'other').customShortcuts, [mixed]);
const disjointSteps = { ...mixed, actions: [tableAction, proseAction] };
assert.deepEqual(changeEditingPreferences(defaults, saveCustom(disjointSteps), 'other').customShortcuts, [disjointSteps],
  'A table step can precede a step that is skipped whenever the table step runs');
assert.throws(() => changeEditingPreferences(defaults,
  saveCustom({ ...mixed, actions: [tableAction, { type: 'command', command: 'bold' }] }), 'other'), /Invalid shortcut rule/);
assert.throws(() => changeEditingPreferences(defaults,
  saveCustom({ ...mixed, actions: [tableAction, cellSnippet] }), 'other'), /Invalid shortcut rule/);
assert.equal(customShortcutCanRunAt({ ...mixed, scope: 'source' }, 'table', 'source'), true);
assert.equal(customShortcutCanRunAt({ ...mixed, scope: 'source' }, 'table', 'live'), false);
const moveLine = { ...mixed, actions: [{ type: 'command', command: 'moveUp' }] } as const;
assert.equal(customShortcutCanRunAt(moveLine, 'table', 'source'), false);
assert.equal(customShortcutCanRunAt(moveLine, 'tableInput', 'live'), false);
assert.equal(customShortcutCanRunAt(mixed, 'tableInput', 'live'), true);
const proseOnly = { ...mixed, id: 'prose-only', actions: [proseAction] };
const tableOnly = { ...mixed, id: 'table-only', actions: [tableAction] };
const separateLocations = changeEditingPreferences(changeEditingPreferences(defaults, saveCustom(proseOnly), 'other'), saveCustom(tableOnly), 'other');
assert.deepEqual(separateLocations.customShortcuts, [proseOnly, tableOnly], 'The same keys may be used at disjoint editing locations');
assert.throws(() => changeEditingPreferences(separateLocations, saveCustom(mixed), 'other'), /already assigned/);
const cellAndProse = { ...proseOnly, actions: [cellSnippet] };
assert.equal(customShortcutCanRunAt(cellAndProse, 'tableInput', 'live'), true);
assert.equal(customShortcutCanRunAt(proseOnly, 'tableInput', 'live'), false);
assert.throws(() => changeEditingPreferences(separateLocations, saveCustom(cellAndProse), 'other'), /already assigned/);
const reboundRow = changeEditingPreferences(defaults, { type: 'bind', command: 'rowDelete', keys: [...cellAndProse.strokes], confirmedReplacements: [] }, 'other');
assert.throws(() => changeEditingPreferences(reboundRow, saveCustom(cellAndProse), 'other'), /already assigned/);
assert.throws(() => changeEditingPreferences(defaults, saveCustom({ ...shortcutRule, actions: [...shortcutRule.actions].reverse() }), 'other'), /Invalid shortcut rule/);
const overlaps = changeEditingPreferences(disjoint, confirmCustom({ ...shortcutRule, id: 'replacement', scope: 'editor' }, disjoint), 'other');
assert.deepEqual(overlaps.customShortcuts?.map(rule => rule.strokes), [[], [], ['Ctrl + K', 'T']]);
const reassignBuiltin = changeEditingPreferences(overlaps,
  confirmBuiltin('bold', ['Ctrl + K'], overlaps), 'other');
assert.deepEqual(reassignBuiltin.customShortcuts?.map(rule => rule.strokes), [[], [], []]);
let concurrentPreferences: EditingPreferences = { ...defaults, customShortcuts: [] };
const concurrentHost = createEditingPreferencesHost({ platform: 'other', read: () => concurrentPreferences,
  write: async next => { concurrentPreferences = next; } });
const contender = { ...mixed, id: 'contender', strokes: ['Ctrl + B'] };
const intended = { ...mixed, id: 'intended', strokes: ['Ctrl + B'] };
const staleConfirmation = confirmCustom(intended, concurrentHost.read());
const competingWrite = concurrentHost.update({ type: 'updateEditingPreferences', requestId: 'competitor',
  change: confirmCustom(contender, concurrentHost.read()) });
const staleWrite = concurrentHost.update({ type: 'updateEditingPreferences', requestId: 'stale', change: staleConfirmation });
assert.ok((await competingWrite).result.ok);
const rejected = await staleWrite;
assert.ok(!rejected.result.ok && rejected.result.error.code === 'shortcut-conflicts-changed');
assert.deepEqual(decodeHostToWebviewMessage(rejected), rejected);
assert.deepEqual(concurrentHost.read().customShortcuts, [contender], 'A stale click cannot clear a newly assigned keybinding');
const confirmed = await concurrentHost.update({ type: 'updateEditingPreferences', requestId: 'confirmed',
  change: confirmCustom(intended, concurrentHost.read()) });
assert.ok(confirmed.result.ok);
assert.deepEqual(concurrentHost.read().customShortcuts?.map(rule => rule.strokes), [[], ['Ctrl + B']]);
assert.deepEqual(changeEditingPreferences(disjoint, { type: 'resetShortcuts' }, 'other').customShortcuts,
  [shortcutRule, sameKeysInSource].map(rule => ({ ...rule, strokes: [] })));
const customRedo = changeEditingPreferences(defaults,
  confirmCustom({ ...shortcutRule, strokes: ['Ctrl + Shift + Z', 'T'] }, defaults), 'other');
const changedSave = changeEditingPreferences(customRedo,
  { type: 'bind', command: 'save', keys: ['Ctrl + Alt + U'], confirmedReplacements: [] }, 'other');
const resetWithCustom = changeEditingPreferences(changedSave, { type: 'resetShortcuts' }, 'other');
assert.deepEqual(resetWithCustom.customShortcuts, customRedo.customShortcuts?.map(rule => ({ ...rule, strokes: [] })),
  'reset clears the chord but preserves the rule and its actions');
assert.deepEqual(effectiveShortcuts(resetWithCustom.shortcuts, 'other').redo, ['Ctrl + Y', 'Ctrl + Shift + Z'], 'reset restores the claimed default key');
assert.deepEqual(effectiveShortcuts(resetWithCustom.shortcuts, 'other').save, ['Ctrl + S'], 'reset restores unrelated built-in defaults');
const cellBreakSequence = { ...mixed, actions: [{ type: 'command', command: 'cellBreak' }, cellSnippet] } as const;
assert.deepEqual(changeEditingPreferences(defaults, saveCustom(cellBreakSequence), 'other').customShortcuts, [cellBreakSequence]);
const customShortcutSchema = JSON.parse(readFileSync('package.json', 'utf8')).contributes.configuration.properties['meoEnhanced.editing.preferences'].properties.customShortcuts.items;
assert.deepEqual(customShortcutSchema.properties.scope.enum, [...customShortcutScopes]);
const [commandSchema, snippetSchema, modeSchema] = customShortcutSchema.properties.actions.items.oneOf;
assert.deepEqual(commandSchema.properties.command.enum, editorCommandIds.filter(canBindCommand));
assert.deepEqual(modeSchema.properties.mode.enum, [...shortcutTargetModes]);
assert.equal(customShortcutSchema.then.properties.id.const, insertCurrentTimeExampleId);
for (const [branch, action, required] of [
  [commandSchema, { type: 'command', command: 'bold' }, 'command'],
  [snippetSchema, { type: 'snippet', template: 'hello' }, 'template'],
  [modeSchema, { type: 'mode', mode: 'preview' }, 'mode']
] as const) {
  assert.equal(branch.properties.type.const, action.type);
  assert.deepEqual(branch.required, ['type', required]);
  assert.ok(isCustomShortcut({ ...shortcutRule, actions: [action] }));
  assert.equal(isCustomShortcut({ ...shortcutRule, actions: [{ type: action.type }] }), false);
}
assert.equal(defaults.input.selectionToolbar, true, 'existing users keep the selection toolbar by default');
assert.equal(defaults.input.pasteHtml, true, 'HTML paste formatting is enabled by default');
assert.equal(normalizeEditingPreferences(undefined).input.pasteHtml, true);
assert.equal(normalizeEditingPreferences({ input: { pasteHtml: false } }).input.pasteHtml, false);
const { showPasteOptions, ...olderInput } = defaults.input;
assert.equal(showPasteOptions, true, 'paste options are shown by default');
assert.equal(normalizeEditingPreferences({ input: olderInput }).input.showPasteOptions, true);
assert.equal(normalizeEditingPreferences({ input: { ...olderInput, showPasteOptions: false } }).input.showPasteOptions, false);
const { renumberOrderedLists, ...beforeListNumbering } = defaults.input;
assert.equal(renumberOrderedLists, true);
assert.equal(normalizeEditingPreferences({ input: beforeListNumbering }).input.renumberOrderedLists, true);
for (const value of [true, false]) {
  const change = { type: 'input' as const, key: 'renumberOrderedLists' as const, value };
  assert.ok(decodeWebviewToHostMessage({ type: 'updateEditingPreferences', requestId: 'list-numbering', change }));
  const { input } = changeEditingPreferences(defaults, change, 'other');
  assert.equal(input.renumberOrderedLists, value);
  assert.equal(input.lists, defaults.input.lists);
  assert.equal(normalizeEditingPreferences({ input }).input.renumberOrderedLists, value);
}
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
  const formatBinding = changeEditingPreferences(defaults, { type: 'bind', command: 'formatHtml', keys: [`${primary} + Alt + L`], confirmedReplacements: [] }, platform);
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
  const saveAs = changeEditingPreferences(defaults, { type: 'bind', command: 'saveAs', keys: [saveAsKey], confirmedReplacements: [] }, platform);
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
  const changed = changeEditingPreferences(defaults, confirmBuiltin('italic', [`${primary} + B`], defaults, platform), platform);
  assert.deepEqual(effectiveShortcuts(changed.shortcuts, platform).bold, []);
  assert.deepEqual(effectiveShortcuts(changed.shortcuts, platform).italic, [`${primary} + B`]);
  assert.throws(() => changeEditingPreferences(defaults, { type: 'bind', command: 'italic', keys: [`${primary} + B`], confirmedReplacements: [] }, platform));
  assert.throws(() => changeEditingPreferences(defaults, { type: 'bind', command: 'italic', keys: [`${primary} + C`],
    confirmedReplacements: [{ type: 'command', command: 'copy', keys: [`${primary} + C`] }] }, platform));
  const reset = changeEditingPreferences(changed, { type: 'resetShortcuts' }, platform);
  assert.deepEqual(reset, defaults);
  assert.equal(resolveShortcut({ key: 'b', code: 'KeyB', ctrl: platform === 'other', meta: platform === 'mac', alt: false, shift: false }, {}, platform, 'editor'), 'bold');
  assert.equal(resolveShortcut({ key: 'b', code: 'KeyB', ctrl: platform === 'other', meta: platform === 'mac', alt: false, shift: false }, {}, platform, 'global'), null);
}

const replacedRedo = changeEditingPreferences(defaults, confirmBuiltin('bold', ['Ctrl + Shift + Z'], defaults), 'other');
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
  change: { type: 'bind' as const, command: 'saveAs' as const, keys: ['Ctrl + Shift + S'], confirmedReplacements: [] } };
assert.ok(decodeWebviewToHostMessage(saveAsRequest));
const saveAsResponse = await host.update(saveAsRequest);
assert.equal(saveAsResponse.result.ok, true);
assert.ok(decodeHostToWebviewMessage(saveAsResponse));
assert.deepEqual(reloaded.read().shortcuts.saveAs, ['Ctrl + Shift + S'], 'Save As bindings survive a new Host instance');
const formatRequest = { type: 'updateEditingPreferences' as const, requestId: 'html-format-binding',
  change: { type: 'bind' as const, command: 'formatHtml' as const, keys: ['Ctrl + Alt + L'], confirmedReplacements: [] } };
assert.ok(decodeWebviewToHostMessage(formatRequest));
assert.equal((await host.update(formatRequest)).result.ok, true);
assert.deepEqual(reloaded.read().shortcuts.formatHtml, ['Ctrl + Alt + L'], 'HTML formatting binding persists through Host');
assert.equal(changeEditingPreferences(persisted, { type: 'resetShortcuts' }, 'other').input.selectionToolbar, false);
const failing = createEditingPreferencesHost({ platform: 'other', read: () => persisted, write: async () => { throw new Error('disk failure'); } });
const failure = await failing.update({ ...request, requestId: 'failed' });
assert.equal(failure.result.ok, false);
assert.deepEqual(failing.read(), persisted);
assert.ok(decodeHostToWebviewMessage(first));

let examplePreferences: EditingPreferences = defaults;
const openExampleHost = () => createEditingPreferencesHost({
  platform: 'other', read: () => examplePreferences, write: async value => { examplePreferences = value; }
});
const exampleHost = openExampleHost();
const examples = exampleHost.read().customShortcuts!;
assert.equal(examples.length, 1);
const [timeExample] = examples;
assert.equal(timeExample.id, insertCurrentTimeExampleId);
assert.equal(timeExample.scope, 'editor');
assert.deepEqual(timeExample.strokes, ['Ctrl + Alt + T']);
assert.equal(customShortcutTitle(timeExample, 'zh-CN'), '示例 · 插入当前时间');
assert.equal(customShortcutTitle(timeExample, 'en'), insertCurrentTimeExampleName);
assert.equal(customShortcutTitle({ id: 'user-created', name: insertCurrentTimeExampleName }, 'zh-CN'), insertCurrentTimeExampleName);
assert.equal(examplePreferences.customShortcuts, undefined, 'Reading the default does not write user settings');
examplePreferences = { ...defaults, shortcuts: { bold: ['Ctrl + Alt + T'] } };
assert.deepEqual(exampleHost.read().customShortcuts, [{ ...timeExample, strokes: [] }], 'The example yields to a previously assigned key');
assert.deepEqual(exampleHost.read().shortcuts.bold, ['Ctrl + Alt + T']);
examplePreferences = custom;
assert.deepEqual(exampleHost.read(), custom, 'An existing action list is never seeded again');
examplePreferences = defaults;
const exampleReset = await exampleHost.update({ ...request, requestId: 'reset-example', change: { type: 'resetShortcuts' } });
assert.ok(exampleReset.result.ok);
assert.deepEqual(openExampleHost().read().customShortcuts, [{ ...timeExample, strokes: [] }], 'Reset clears the example binding but preserves the action');
const exampleRemoval = await exampleHost.update({
  ...request, requestId: 'delete-example', change: { type: 'deleteCustomShortcut', id: insertCurrentTimeExampleId }
});
assert.ok(exampleRemoval.result.ok);
assert.deepEqual(openExampleHost().read().customShortcuts, [], 'An explicitly removed example stays removed after reopening');

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
assert.equal(schema.properties.input.properties.pasteHtml.default, true);
assert.equal(schema.properties.input.properties.showPasteOptions.default, true);
assert.equal(schema.properties.input.properties.renumberOrderedLists.default, true);

let savedGlobal: Partial<EditingPreferences> | undefined;
let savedWorkspace: Partial<EditingPreferences> | undefined;
const configurationWrites: number[] = [];
mock.module('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  workspace: { getConfiguration: () => ({
    inspect: () => ({ globalValue: savedGlobal, workspaceValue: savedWorkspace }),
    get: () => normalizeEditingPreferences({
      input: { ...savedGlobal?.input, ...savedWorkspace?.input },
      shortcuts: { ...savedGlobal?.shortcuts, ...savedWorkspace?.shortcuts }
    }),
    update: async (_key: string, value: EditingPreferences, target: number) => {
      configurationWrites.push(target);
      if (target === 1) savedGlobal = value; else savedWorkspace = value;
    }
  }) }
}));
const { createVscodeEditingPreferences } = await import('../src/host/vscodeEditingPreferences');
for (const language of ['zh-CN', 'en'] as const) {
  savedGlobal = undefined; savedWorkspace = undefined; configurationWrites.length = 0;
  const initialized = await createVscodeEditingPreferences(language);
  assert.equal(initialized.read().input.pasteHtml, true);
  assert.equal(initialized.read().input.slashPreferAbove, language === 'zh-CN');
  assert.deepEqual(configurationWrites, [1], 'the language-derived default is immediately persisted globally');
  const later = await createVscodeEditingPreferences(language === 'zh-CN' ? 'en' : 'zh-CN');
  assert.equal(later.read().input.slashPreferAbove, language === 'zh-CN', 'language changes preserve the initial value without a manual toggle');
  assert.deepEqual(configurationWrites, [1], 'reloading does not initialize twice');
  await initialized.update({ type: 'updateEditingPreferences', requestId: 'placement', change: { type: 'input', key: 'slashPreferAbove', value: language !== 'zh-CN' } });
  assert.equal((await createVscodeEditingPreferences(language)).read().input.slashPreferAbove, language !== 'zh-CN', 'explicit changes survive restart');
}
savedGlobal = { input: { ...defaultInputAssistance, emoji: true, pasteUrl: false }, shortcuts: { bold: [] } };
delete (savedGlobal.input as { slashPreferAbove?: boolean }).slashPreferAbove;
savedWorkspace = { input: { ...defaultInputAssistance, slashPreferAbove: false, pasteHtml: false } };
configurationWrites.length = 0;
const migrated = await createVscodeEditingPreferences('zh-CN');
assert.equal(savedGlobal.input!.slashPreferAbove, true);
assert.equal(savedGlobal.input!.emoji, true);
assert.equal(savedGlobal.input!.pasteUrl, false);
assert.deepEqual(savedGlobal.shortcuts, { bold: [] }, 'initialization preserves existing global choices');
assert.equal(migrated.read().input.slashPreferAbove, false, 'an existing workspace choice overrides the global default');
assert.equal(savedGlobal.input!.pasteHtml, true);
assert.equal(migrated.read().input.pasteHtml, false, 'the stored workspace choice takes precedence');
assert.deepEqual(configurationWrites, [1]);
savedWorkspace = undefined;
assert.equal((await createVscodeEditingPreferences('en')).read().input.slashPreferAbove, true);
assert.deepEqual(configurationWrites, [1]);
console.log('Slash menu preference: one-time language defaults, persistence, explicit choices and workspace overrides passed');

savedGlobal = { input: { ...defaultInputAssistance, pasteHtml: true, emoji: true, slashPreferAbove: true }, shortcuts: { bold: ['Alt + B'] } };
savedWorkspace = { input: { ...defaultInputAssistance, pasteHtml: false, pasteUrl: false }, shortcuts: { italic: ['Alt + I'] } };
const previousGlobal = structuredClone(savedGlobal);
const previousWorkspace = structuredClone(savedWorkspace);
configurationWrites.length = 0;
const upgraded = await createVscodeEditingPreferences('en');
assert.equal(upgraded.read().input.pasteHtml, false, 'a workspace opt-out overrides the new default');
assert.deepEqual(savedGlobal, previousGlobal);
assert.deepEqual(savedWorkspace, previousWorkspace);
assert.deepEqual(configurationWrites, [], 'saved choices are never rewritten by activation');
await upgraded.update({ type: 'updateEditingPreferences', requestId: 'enable-html-workspace', change: { type: 'input', key: 'pasteHtml', value: true } });
assert.equal((await createVscodeEditingPreferences('en')).read().input.pasteHtml, true, 'a workspace opt-in survives restart');
assert.deepEqual(configurationWrites, [2]);

savedWorkspace = undefined;
const userPreferences = await createVscodeEditingPreferences('en');
assert.equal(userPreferences.read().input.pasteHtml, true, 'a saved global opt-in survives activation');
await userPreferences.update({ type: 'updateEditingPreferences', requestId: 'disable-html-global', change: { type: 'input', key: 'pasteHtml', value: false } });
assert.equal((await createVscodeEditingPreferences('zh-CN')).read().input.pasteHtml, false, 'a global opt-out survives restart');
assert.deepEqual(configurationWrites, [2, 1]);
console.log('HTML paste preference: default on, saved profile/workspace choices and persistence passed');
