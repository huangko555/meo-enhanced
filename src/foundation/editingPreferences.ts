export const editorCommandIds = [
  'save', 'saveAs', 'undo', 'redo', 'find', 'replace', 'all', 'copy', 'cut', 'paste', 'plain',
  'bold', 'italic', 'inlineCode', 'strike', 'highlight', 'underline', 'kbd', 'link', 'wikiLink', 'image', 'inlineMath', 'blockMath', 'formatHtml',
  'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'headingUp', 'headingDown',
  'bullet', 'ordered', 'taskList', 'taskDone', 'quote', 'codeBlock', 'rule', 'indent',
  'insertTable', 'tableNav', 'cellBreak', 'rowAbove', 'rowBelow', 'rowDelete',
  'columnBefore', 'columnAfter', 'columnDelete', 'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight',
  'alignLeft', 'alignCenter', 'alignRight', 'copyMarkdown', 'copyCsv', 'convert',
  'selection', 'home', 'expandSelection', 'shrinkSelection', 'nextOccurrence', 'skipOccurrence', 'addCursor', 'splitCursors',
  'lineComment', 'selectionComment', 'moveUp', 'moveDown', 'copyUp', 'copyDown', 'deleteLine', 'blankAbove', 'blankBelow', 'mode', 'preview', 'openFileTree', 'resetWindowZoom', 'enter', 'tab', 'escape', 'delete'
] as const;

export type EditorCommandId = typeof editorCommandIds[number];
export type ShortcutPlatform = 'mac' | 'windows' | 'other';
export type PairMode = 'smart' | 'always' | 'off';
export type InputAssistance = {
  readonly selectionToolbar: boolean;
  readonly wrapSelection: boolean;
  readonly pairMode: PairMode;
  readonly skipMode: PairMode;
  readonly deleteMode: PairMode;
  readonly lists: boolean;
  readonly renumberOrderedLists: boolean;
  readonly showPasteOptions: boolean;
  readonly convertTables: boolean;
  readonly pasteUrl: boolean;
  readonly pasteHtml: boolean;
  readonly documentSuggestions: boolean;
  readonly slash: boolean;
  /** Shared candidate placement; retain the storage key for existing preferences. */
  readonly slashPreferAbove: boolean;
  readonly emoji: boolean;
  readonly math: boolean;
  readonly html: boolean;
};
export type InputSuggestionSetting = 'documentSuggestions' | 'slash' | 'emoji' | 'math' | 'html';
/** Missing commands use platform defaults; an explicit empty array removes a binding. */
export type ShortcutOverrides = Partial<Record<EditorCommandId, readonly string[]>>;
export const customShortcutScopes = ['global', 'editor', 'live', 'source'] as const;
export type CustomShortcutScope = typeof customShortcutScopes[number];
export const shortcutTargetModes = ['live', 'source', 'preview'] as const;
export const insertCurrentTimeExampleId = 'example-insert-current-time';
export const insertCurrentTimeExampleName = 'Example · Insert current time';
export type CustomShortcutAction =
  | { readonly type: 'command'; readonly command: EditorCommandId }
  | { readonly type: 'snippet'; readonly template: string }
  | { readonly type: 'mode'; readonly mode: typeof shortcutTargetModes[number] };
export type CustomShortcut = {
  readonly id: string;
  readonly name: string;
  readonly useDefaultName?: true;
  readonly scope: CustomShortcutScope;
  readonly strokes: readonly string[];
  readonly actions: readonly CustomShortcutAction[];
};
export type EditingPreferences = {
  readonly input: InputAssistance;
  readonly shortcuts: ShortcutOverrides;
  readonly customShortcuts?: readonly CustomShortcut[];
};
export type ShortcutReplacement =
  | { readonly type: 'command'; readonly command: EditorCommandId; readonly keys: readonly string[] }
  | { readonly type: 'custom'; readonly id: string; readonly scope: CustomShortcutScope; readonly keys: readonly string[] };
export type EditingPreferencesChange =
  | { readonly type: 'input'; readonly key: keyof InputAssistance; readonly value: boolean | PairMode }
  | { readonly type: 'bind'; readonly command: EditorCommandId; readonly keys: readonly string[]; readonly confirmedReplacements: readonly ShortcutReplacement[] }
  | { readonly type: 'saveCustomShortcut'; readonly shortcut: CustomShortcut; readonly confirmedReplacements: readonly ShortcutReplacement[] }
  | { readonly type: 'deleteCustomShortcut'; readonly id: string }
  | { readonly type: 'resetShortcuts' };

export const defaultInputAssistance: InputAssistance = {
  selectionToolbar: true, wrapSelection: true, pairMode: 'smart', skipMode: 'smart', deleteMode: 'smart', lists: true,
  renumberOrderedLists: true,
  showPasteOptions: true, convertTables: true, pasteUrl: true, pasteHtml: true,
  documentSuggestions: true, slash: true, slashPreferAbove: false, emoji: false, math: true, html: true
};

export function isEditorCommandId(value: unknown): value is EditorCommandId {
  return typeof value === 'string' && (editorCommandIds as readonly string[]).includes(value);
}

export function isInputAssistance(value: unknown): value is InputAssistance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(defaultInputAssistance).every(([key, fallback]) => typeof fallback === 'boolean'
    ? typeof record[key] === 'boolean'
    : record[key] === 'smart' || record[key] === 'always' || record[key] === 'off');
}

export function isShortcutOverrides(value: unknown): value is ShortcutOverrides {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, keys]) => isEditorCommandId(key) && Array.isArray(keys)
      && keys.length <= 4 && keys.every(key => typeof key === 'string' && key.length > 0 && key.length <= 80));
}

function isCustomShortcutId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function isShortcutReplacement(value: unknown): value is ShortcutReplacement {
  if (!value || typeof value !== 'object' || !('type' in value) || !('keys' in value)
    || !Array.isArray(value.keys) || !value.keys.length || value.keys.length > 4
    || !value.keys.every(key => typeof key === 'string' && key.length > 0 && key.length <= 80)) return false;
  if (value.type === 'command') return 'command' in value && isEditorCommandId(value.command);
  return value.type === 'custom' && 'id' in value && isCustomShortcutId(value.id)
    && 'scope' in value && customShortcutScopes.some(scope => scope === value.scope);
}

function isCustomShortcutAction(value: unknown): value is CustomShortcutAction {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  if (value.type === 'command') return 'command' in value && isEditorCommandId(value.command);
  if (value.type === 'mode') return 'mode' in value && shortcutTargetModes.some(mode => mode === value.mode);
  return value.type === 'snippet' && 'template' in value && typeof value.template === 'string'
    && value.template.length > 0 && value.template.length <= 20_000;
}

export function isCustomShortcut(value: unknown): value is CustomShortcut {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const shortcut = value as Record<string, unknown>;
  return isCustomShortcutId(shortcut.id) && typeof shortcut.name === 'string'
    && shortcut.name.length <= 100 && Boolean(shortcut.name.trim())
    && (shortcut.useDefaultName === undefined || (shortcut.id === insertCurrentTimeExampleId && shortcut.useDefaultName === true))
    && customShortcutScopes.some(scope => scope === shortcut.scope)
    && Array.isArray(shortcut.strokes) && shortcut.strokes.length <= 2
    && shortcut.strokes.every(stroke => typeof stroke === 'string' && stroke.length > 0 && stroke.length <= 80)
    && Array.isArray(shortcut.actions) && shortcut.actions.length > 0 && shortcut.actions.length <= 12
    && shortcut.actions.every(isCustomShortcutAction);
}

export function isEditingPreferences(value: unknown): value is EditingPreferences {
  return !!value && typeof value === 'object' && 'input' in value && 'shortcuts' in value
    && isInputAssistance(value.input) && isShortcutOverrides(value.shortcuts)
    && (!('customShortcuts' in value) || value.customShortcuts === undefined
      || Array.isArray(value.customShortcuts) && value.customShortcuts.every(isCustomShortcut));
}

export function isEditingPreferencesChange(value: unknown): value is EditingPreferencesChange {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'resetShortcuts') return true;
  if (record.type === 'deleteCustomShortcut') return isCustomShortcutId(record.id);
  if (record.type === 'saveCustomShortcut' || record.type === 'bind') {
    if (!Array.isArray(record.confirmedReplacements) || !record.confirmedReplacements.every(isShortcutReplacement)) return false;
    return record.type === 'saveCustomShortcut' ? isCustomShortcut(record.shortcut)
      : isEditorCommandId(record.command) && isShortcutOverrides({ [record.command]: record.keys });
  }
  if (record.type !== 'input' || typeof record.key !== 'string'
    || !Object.hasOwn(defaultInputAssistance, record.key)) return false;
  return isInputAssistance({ ...defaultInputAssistance, [record.key]: record.value });
}
