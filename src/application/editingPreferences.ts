import {
  defaultInputAssistance, editorCommandIds, type EditingPreferences,
  type EditingPreferencesChange, type EditorCommandId, type ShortcutOverrides
} from '../foundation/editingPreferences';

export type ShortcutPlatform = 'mac' | 'other';
export type ShortcutContext = 'global' | 'editor' | 'table' | 'native';
export type ShortcutStroke = {
  readonly key: string;
  readonly code?: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly composing?: boolean;
  readonly altGraph?: boolean;
};

const fixedCommands = new Set<EditorCommandId>(['copy', 'cut', 'paste', 'selection', 'home', 'enter', 'tab', 'escape', 'delete', 'indent', 'tableNav']);
const globalCommands = new Set<EditorCommandId>(['save', 'find', 'replace', 'mode', 'preview']);
const tableCommands = new Set<EditorCommandId>([
  'cellBreak', 'rowAbove', 'rowBelow', 'rowDelete', 'columnBefore', 'columnAfter', 'columnDelete',
  'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight', 'alignLeft', 'alignCenter', 'alignRight', 'copyMarkdown', 'copyCsv'
]);

export function commandContext(command: EditorCommandId): ShortcutContext {
  if (fixedCommands.has(command)) return 'native';
  if (globalCommands.has(command)) return 'global';
  return tableCommands.has(command) ? 'table' : 'editor';
}

export function canBindCommand(command: EditorCommandId): boolean { return !fixedCommands.has(command); }

export function defaultShortcuts(platform: ShortcutPlatform): Record<EditorCommandId, readonly string[]> {
  const primary = platform === 'mac' ? 'Cmd' : 'Ctrl';
  const result = Object.fromEntries(editorCommandIds.map(id => [id, [] as readonly string[]])) as Record<EditorCommandId, readonly string[]>;
  Object.assign(result, {
    save: [`${primary} + S`], undo: [`${primary} + Z`], redo: platform === 'mac' ? ['Cmd + Shift + Z'] : ['Ctrl + Y', 'Ctrl + Shift + Z'],
    find: [`${primary} + F`], replace: platform === 'mac' ? ['Cmd + Alt + F'] : ['Ctrl + H'],
    all: [`${primary} + A`], copy: [`${primary} + C`], cut: [`${primary} + X`], paste: [`${primary} + V`],
    lineComment: [`${primary} + /`], selectionComment: ['Alt + Shift + A'],
    bold: [`${primary} + B`], italic: [`${primary} + I`], mode: ['Alt + Shift + M'],
    moveUp: ['Alt + ArrowUp'], moveDown: ['Alt + ArrowDown'], copyUp: ['Alt + Shift + ArrowUp'], copyDown: ['Alt + Shift + ArrowDown'],
    deleteLine: platform === 'mac' ? ['Cmd + Shift + K'] : ['Ctrl + Shift + K'],
    cellBreak: ['Shift + Enter', 'Ctrl + Enter'], indent: ['Tab', 'Shift + Tab'], tableNav: ['Tab', 'Shift + Tab'],
    enter: ['Enter', 'Shift + Enter'], tab: ['Tab', 'Shift + Tab'], escape: ['Escape'], delete: ['Backspace', 'Delete']
  });
  return result;
}

const namedKeys: Record<string, string> = {
  esc: 'Escape', escape: 'Escape', enter: 'Enter', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight', plus: 'Plus'
};

export function normalizeShortcut(value: string): string | null {
  const parts = value.trim().split(/\s*\+\s*/);
  const rawKey = parts.pop();
  if (!rawKey) return null;
  const modifiers = new Set<string>();
  for (const modifier of parts) {
    const canonical = { ctrl: 'Ctrl', control: 'Ctrl', cmd: 'Cmd', meta: 'Cmd', command: 'Cmd', alt: 'Alt', option: 'Alt', shift: 'Shift' }[modifier.toLowerCase()];
    if (!canonical || modifiers.has(canonical)) return null;
    modifiers.add(canonical);
  }
  const key = namedKeys[rawKey.toLowerCase()] ?? (/^f(?:[1-9]|1\d|2[0-4])$/i.test(rawKey) ? rawKey.toUpperCase()
    : rawKey.length === 1 ? rawKey.toUpperCase() : null);
  if (!key || key === 'Tab' || key === 'Escape' && modifiers.size === 0) return null;
  if (modifiers.size === 0 && !/^F\d+$/.test(key)) return null;
  if (modifiers.size === 1 && modifiers.has('Shift') && key.length === 1) return null;
  return [...['Ctrl', 'Cmd', 'Alt', 'Shift'].filter(modifier => modifiers.has(modifier)), key].join(' + ');
}

export function shortcutFromStroke(stroke: ShortcutStroke): string | null {
  if (stroke.composing || stroke.altGraph || ['Control', 'Meta', 'Alt', 'Shift', 'Process', 'Dead', 'Unidentified'].includes(stroke.key)) return null;
  let key = stroke.key === ' ' ? 'Space' : stroke.key === '+' ? 'Plus' : stroke.key;
  // Physical letters retain shortcuts while an IME or alternate layout is active.
  if (stroke.code && /^Key[A-Z]$/.test(stroke.code)) key = stroke.code.slice(3);
  return normalizeShortcut([
    ...(stroke.ctrl ? ['Ctrl'] : []), ...(stroke.meta ? ['Cmd'] : []),
    ...(stroke.alt ? ['Alt'] : []), ...(stroke.shift ? ['Shift'] : []), key
  ].join(' + '));
}

export function effectiveShortcuts(overrides: ShortcutOverrides, platform: ShortcutPlatform): Record<EditorCommandId, readonly string[]> {
  const defaults = defaultShortcuts(platform);
  for (const command of editorCommandIds) {
    const keys = overrides[command];
    if (keys && canBindCommand(command) && keys.every(key => normalizeShortcut(key))) defaults[command] = keys.map(key => normalizeShortcut(key)!);
  }
  return defaults;
}

export function shortcutConflicts(command: EditorCommandId, keys: readonly string[], overrides: ShortcutOverrides, platform: ShortcutPlatform): EditorCommandId[] {
  const wanted = new Set(keys.map(normalizeShortcut));
  const context = commandContext(command);
  const bindings = effectiveShortcuts(overrides, platform);
  return editorCommandIds.filter(other => {
    if (other === command) return false;
    const otherContext = commandContext(other);
    // Native navigation is a fallback. Clipboard chords remain reserved.
    if (otherContext === 'native' && !['copy', 'cut', 'paste'].includes(other)) return false;
    if (context === 'native') return false;
    return bindings[other].some(key => wanted.has(normalizeShortcut(key)))
      && (context === otherContext || context === 'global' || otherContext === 'global'
        || context === 'editor' || otherContext === 'editor' || otherContext === 'native');
  });
}

export function normalizeEditingPreferences(value: unknown): EditingPreferences {
  const record = value && typeof value === 'object' ? value as Partial<EditingPreferences> : {};
  return {
    input: { ...defaultInputAssistance, ...Object.fromEntries(Object.entries(record.input ?? {}).filter(([key, value]) => {
      if (!Object.hasOwn(defaultInputAssistance, key)) return false;
      const fallback = defaultInputAssistance[key as keyof typeof defaultInputAssistance];
      return typeof fallback === 'boolean' ? typeof value === 'boolean' : fallback !== undefined && ['smart', 'always', 'off'].includes(String(value));
    })) },
    shortcuts: Object.fromEntries(Object.entries(record.shortcuts ?? {}).filter(([id, keys]) =>
      editorCommandIds.includes(id as EditorCommandId) && canBindCommand(id as EditorCommandId)
      && Array.isArray(keys) && keys.length <= 4 && keys.every(key => typeof key === 'string' && key.length <= 80 && normalizeShortcut(key))).map(([id, keys]) => [id, [...new Set((keys as string[]).map(key => normalizeShortcut(key)!))]]))
  };
}

export function changeEditingPreferences(current: EditingPreferences, change: EditingPreferencesChange, platform: ShortcutPlatform): EditingPreferences {
  if (change.type === 'input') return { ...current, input: { ...current.input, [change.key]: change.value } };
  if (change.type === 'resetShortcuts') return { ...current, shortcuts: {} };
  if (!canBindCommand(change.command)) throw new Error('This platform binding cannot be changed');
  const keys = change.keys.map(normalizeShortcut);
  if (keys.some(key => key === null) || new Set(keys).size !== keys.length) throw new Error('Invalid key combination');
  const conflicts = shortcutConflicts(change.command, keys as string[], current.shortcuts, platform);
  if (conflicts.length && (!change.replaceConflicts || conflicts.some(command => !canBindCommand(command)))) throw new Error('Key combination is already assigned');
  const shortcuts = { ...current.shortcuts };
  const bindings = effectiveShortcuts(shortcuts, platform);
  for (const conflict of conflicts) shortcuts[conflict] = bindings[conflict].filter(key => !keys.includes(normalizeShortcut(key)));
  shortcuts[change.command] = keys as string[];
  return { ...current, shortcuts };
}

export function resolveShortcut(stroke: ShortcutStroke, overrides: ShortcutOverrides, platform: ShortcutPlatform, context: 'global' | 'editor' | 'table'): EditorCommandId | null {
  const key = shortcutFromStroke(stroke);
  if (!key) return null;
  const bindings = effectiveShortcuts(overrides, platform);
  return editorCommandIds.find(command => canBindCommand(command) && bindings[command].includes(key)
    && (commandContext(command) === 'global' || context === 'editor' && commandContext(command) === 'editor'
      || context === 'table' && ['editor', 'table'].includes(commandContext(command)))) ?? null;
}
