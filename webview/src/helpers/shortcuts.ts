const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export const isPrimaryModifier = (event: KeyboardEvent): boolean => {
  return event.metaKey !== event.ctrlKey && (event.metaKey || event.ctrlKey);
};

export const isShortcutKey = (event: KeyboardEvent, key: string, code: string): boolean => {
  return event.key.toLowerCase() === key || event.code === code;
};

export const normalizeEol = (text: string): string => text.replace(/\r\n?/g, '\n');

export interface ShortcutHandlerContext {
  editor: any;
  editableMode: 'live' | 'source';
  vimModeEnabled: boolean;
  requestSave: () => void;
  openFindPanel: (target: 'find' | 'replace') => void;
  requestMode: (mode: 'live' | 'source') => void;
}

export const handleEditorShortcut = (
  event: KeyboardEvent,
  context: ShortcutHandlerContext
): boolean => {
  const { editor, editableMode, vimModeEnabled } = context;
  
  if (!editor || event.isComposing) {
    return false;
  }
  
  const hasPrimaryModifier = isPrimaryModifier(event);
  const editorFocused = editor.hasFocus();
  const vimEditorFocused = vimModeEnabled && editorFocused;
  const vimWinsCtrlConflicts = vimEditorFocused && !isMac;
  const isPlainAltShiftChord =
    event.altKey &&
    event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey;
  const isModeToggleShortcut = isPlainAltShiftChord && isShortcutKey(event, 'm', 'KeyM');

  if (isModeToggleShortcut) {
    event.preventDefault();
    event.stopPropagation();
    context.requestMode(editableMode === 'live' ? 'source' : 'live');
    return true;
  }

  if (
    vimEditorFocused &&
    (
      isPlainAltShiftChord ||
      (isMac && event.metaKey && !event.ctrlKey)
    )
  ) {
    event.stopPropagation();
    return false;
  }

  if (hasPrimaryModifier && isShortcutKey(event, 's', 'KeyS') && !event.altKey) {
    event.preventDefault();
    event.stopPropagation();
    context.requestSave();
    return true;
  }

  if (hasPrimaryModifier && isShortcutKey(event, 'f', 'KeyF') && !event.altKey && !event.shiftKey) {
    if (vimWinsCtrlConflicts) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    context.openFindPanel('find');
    return true;
  }

  if (
    hasPrimaryModifier &&
    (
      (isMac && isShortcutKey(event, 'f', 'KeyF') && event.altKey) ||
      (!isMac && isShortcutKey(event, 'h', 'KeyH') && !event.altKey)
    )
  ) {
    if (vimWinsCtrlConflicts) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    context.openFindPanel('replace');
    return true;
  }

  if (!editorFocused) {
    return false;
  }

  if (!hasPrimaryModifier) {
    return false;
  }

  if (isShortcutKey(event, 'a', 'KeyA') && !event.altKey) {
    if (vimWinsCtrlConflicts) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    editor.selectAll();
    return true;
  }

  if (isShortcutKey(event, 'z', 'KeyZ') && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    event.stopPropagation();
    editor.undo();
    return true;
  }

  const redoByShiftZ = isShortcutKey(event, 'z', 'KeyZ') && event.shiftKey;
  const redoByY = isShortcutKey(event, 'y', 'KeyY');
  if ((redoByShiftZ || redoByY) && !event.altKey) {
    if (vimWinsCtrlConflicts && redoByY) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    editor.redo();
    return true;
  }

  return false;
};
