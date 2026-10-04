export const editorCommandIds = [
  'save', 'undo', 'redo', 'find', 'replace', 'all', 'copy', 'cut', 'paste', 'plain',
  'bold', 'italic', 'inlineCode', 'strike', 'highlight', 'underline', 'kbd', 'link', 'wikiLink', 'image', 'inlineMath', 'blockMath',
  'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'headingUp', 'headingDown',
  'bullet', 'ordered', 'taskList', 'taskDone', 'quote', 'codeBlock', 'rule', 'indent',
  'insertTable', 'tableNav', 'cellBreak', 'rowAbove', 'rowBelow', 'rowDelete',
  'columnBefore', 'columnAfter', 'columnDelete', 'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight',
  'alignLeft', 'alignCenter', 'alignRight', 'copyMarkdown', 'copyCsv', 'convert',
  'selection', 'home', 'expandSelection', 'shrinkSelection', 'nextOccurrence', 'skipOccurrence', 'addCursor', 'splitCursors',
  'lineComment', 'selectionComment', 'moveUp', 'moveDown', 'copyUp', 'copyDown', 'deleteLine', 'blankAbove', 'blankBelow', 'mode', 'preview', 'enter', 'tab', 'escape', 'delete'
] as const;

export type EditorCommandId = typeof editorCommandIds[number];
export type PairMode = 'smart' | 'always' | 'off';
export type InputAssistance = {
  readonly selectionToolbar: boolean;
  readonly wrapSelection: boolean;
  readonly pairMode: PairMode;
  readonly skipMode: PairMode;
  readonly deleteMode: PairMode;
  readonly lists: boolean;
  readonly convertTables: boolean;
  readonly pasteUrl: boolean;
  readonly pasteHtml: boolean;
  readonly documentSuggestions: boolean;
  readonly slash: boolean;
  readonly emoji: boolean;
};
/** Missing commands use platform defaults; an explicit empty array removes a binding. */
export type ShortcutOverrides = Partial<Record<EditorCommandId, readonly string[]>>;
export type EditingPreferences = {
  readonly input: InputAssistance;
  readonly shortcuts: ShortcutOverrides;
};
export type EditingPreferencesChange =
  | { readonly type: 'input'; readonly key: keyof InputAssistance; readonly value: boolean | PairMode }
  | { readonly type: 'bind'; readonly command: EditorCommandId; readonly keys: readonly string[]; readonly replaceConflicts: boolean }
  | { readonly type: 'resetShortcuts' };

export const defaultInputAssistance: InputAssistance = {
  selectionToolbar: true, wrapSelection: true, pairMode: 'smart', skipMode: 'smart', deleteMode: 'smart', lists: true,
  convertTables: true, pasteUrl: true, pasteHtml: true, documentSuggestions: true, slash: true, emoji: false
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

export function isEditingPreferences(value: unknown): value is EditingPreferences {
  return !!value && typeof value === 'object' && 'input' in value && 'shortcuts' in value
    && isInputAssistance(value.input) && isShortcutOverrides(value.shortcuts);
}

export function isEditingPreferencesChange(value: unknown): value is EditingPreferencesChange {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'resetShortcuts') return true;
  if (record.type === 'bind') return isEditorCommandId(record.command)
    && typeof record.replaceConflicts === 'boolean'
    && isShortcutOverrides({ [record.command]: record.keys });
  if (record.type !== 'input' || typeof record.key !== 'string'
    || !Object.hasOwn(defaultInputAssistance, record.key)) return false;
  return isInputAssistance({ ...defaultInputAssistance, [record.key]: record.value });
}
