import { commandContext, defaultShortcuts, resolveShortcut, shortcutFromStroke, type ShortcutPlatform } from '../../../src/application/editingPreferences';
import type { ShortcutOverrides } from '../../../src/foundation/editingPreferences';
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
export const isPrimaryModifier = (event: KeyboardEvent): boolean => event.metaKey !== event.ctrlKey && (event.metaKey || event.ctrlKey);
export const isShortcutKey = (event: KeyboardEvent, key: string, code: string): boolean => event.key.toLowerCase() === key || event.code === code;
export { normalizeDocumentText as normalizeEol } from '../../../src/foundation/documentText';
export interface ShortcutHandlerContext {
  editor: any;
  editableMode: 'live' | 'source';
  editorSurfaceActive: boolean;
  shortcuts?: ShortcutOverrides;
  platform?: ShortcutPlatform;
  requestSave: () => void;
  openFindPanel: (target: 'find' | 'replace') => void;
  requestMode: (mode: 'live' | 'source') => void;
  requestPreview?: () => void;
  requestPlainPaste?: () => void;
  requestTableCopy?: (format: 'markdown' | 'csv') => void;
}
export const handleEditorShortcut = (event: KeyboardEvent, context: ShortcutHandlerContext): boolean => {
  const editor = context.editor;
  if (!editor || event.isComposing || event.keyCode === 229 || editor.view?.compositionStarted) return false;
  const target = event.target;
  if (typeof Element !== 'undefined' && target instanceof Element) {
    if (target.closest('[data-meo-settings]')) return false;
    if (target.matches('input, textarea, [contenteditable="true"]') && !editor.view?.dom.contains(target)) return false;
  }
  const editorFocused = editor.hasFocus();
  const detached = context.editorSurfaceActive && (target as Node | null)?.nodeName === 'BODY';
  const editable = context.editorSurfaceActive && (editorFocused || detached);
  const table = editable && (editor.isTableFocused?.() ?? false);
  const scope = table ? 'table' : editable ? 'editor' : 'global';
  const platform = context.platform ?? (isMac ? 'mac' : 'other');
  const stroke = { key: event.key, code: event.code, ctrl: !!event.ctrlKey, meta: !!event.metaKey, alt: !!event.altKey, shift: !!event.shiftKey, composing: event.isComposing, altGraph: event.getModifierState?.('AltGraph') ?? false };
  const command = resolveShortcut(stroke, context.shortcuts ?? {}, platform, scope);
  const nestedInput = typeof Element !== 'undefined' && target instanceof Element && target.matches('input, textarea') && !target.closest('.meo-md-html-table-wrap');
  if (nestedInput && command && !['undo', 'redo', 'plain'].includes(command) && commandContext(command) !== 'global') return false;
  if (detached && !editorFocused && command && !['undo', 'redo'].includes(command) && commandContext(command) !== 'global') return false;
  const consume = () => { event.preventDefault(); event.stopPropagation(); };
  if (!command) {
    // A cleared/reassigned gesture must not fall through to CodeMirror's old default map.
    const key = shortcutFromStroke(stroke);
    const removedDefault = editable && key && Object.entries(defaultShortcuts(platform)).some(([id, keys]) => keys.includes(key) && commandContext(id as Parameters<typeof commandContext>[0]) !== 'native'
      && (commandContext(id as Parameters<typeof commandContext>[0]) !== 'table' || table));
    if (removedDefault) { consume(); return true; }
    return false;
  }
  consume();
  switch (command) {
    case 'save': context.requestSave(); break;
    case 'find': case 'replace': context.openFindPanel(command); break;
    case 'mode': context.requestMode(context.editableMode === 'live' ? 'source' : 'live'); break;
    case 'preview': context.requestPreview?.(); break;
    case 'undo': editor.undo(); break;
    case 'redo': editor.redo(); break;
    case 'all': editor.selectAll(); break;
    case 'plain': context.requestPlainPaste?.(); break;
    case 'copyMarkdown': case 'copyCsv': context.requestTableCopy?.(command === 'copyCsv' ? 'csv' : 'markdown'); break;
    default: editor.executeCommand?.(command); break;
  }
  return true;
};
