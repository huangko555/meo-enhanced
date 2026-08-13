import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { platform: 'Win32' }
});

const { handleEditorShortcut } = await import('../webview/src/helpers/shortcuts');

let openedTarget: 'find' | 'replace' | null = null;
let prevented = false;
let stopped = false;
const context = new Proxy({
  editor: {
    hasFocus: () => true,
    selectAll: () => undefined,
    undo: () => undefined,
    redo: () => undefined
  },
  editableMode: 'source' as const,
  requestSave: () => undefined,
  openFindPanel: (target: 'find' | 'replace') => { openedTarget = target; },
  requestMode: (_mode: 'live' | 'source') => undefined
}, {
  get(target, property, receiver) {
    assert.equal(property in target, true, `Shortcut handler read undeclared context state: ${String(property)}`);
    return Reflect.get(target, property, receiver);
  }
});

const handled = handleEditorShortcut({
  key: 'f',
  code: 'KeyF',
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  preventDefault: () => { prevented = true; },
  stopPropagation: () => { stopped = true; }
} as KeyboardEvent, context);

assert.equal(handled, true);
assert.equal(openedTarget, 'find');
assert.equal(prevented, true);
assert.equal(stopped, true);

console.log('Editor shortcut tests passed');
