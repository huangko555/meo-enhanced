import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { platform: 'Win32' }
});

const { handleEditorShortcut } = await import('../webview/src/helpers/shortcuts');

type ShortcutCase = {
  readonly name: string;
  readonly event: Partial<KeyboardEvent> & Pick<KeyboardEvent, 'key' | 'code'>;
  readonly editableMode?: 'live' | 'source';
  readonly focused?: boolean;
  readonly expectedHandled: boolean;
  readonly expectedEffects?: readonly string[];
};

const cases: readonly ShortcutCase[] = [
  {
    name: 'save',
    event: { key: 's', code: 'KeyS', ctrlKey: true },
    expectedHandled: true,
    expectedEffects: ['save']
  },
  {
    name: 'find',
    event: { key: 'f', code: 'KeyF', ctrlKey: true },
    expectedHandled: true,
    expectedEffects: ['find:find']
  },
  {
    name: 'replace',
    event: { key: 'h', code: 'KeyH', ctrlKey: true },
    expectedHandled: true,
    expectedEffects: ['find:replace']
  },
  {
    name: 'select all',
    event: { key: 'a', code: 'KeyA', ctrlKey: true },
    expectedHandled: true,
    expectedEffects: ['selectAll']
  },
  {
    name: 'undo',
    event: { key: 'z', code: 'KeyZ', ctrlKey: true },
    expectedHandled: true,
    expectedEffects: ['undo']
  },
  {
    name: 'redo with Shift+Z',
    event: { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true },
    expectedHandled: true,
    expectedEffects: ['redo']
  },
  {
    name: 'redo with Y',
    event: { key: 'y', code: 'KeyY', ctrlKey: true },
    expectedHandled: true,
    expectedEffects: ['redo']
  },
  {
    name: 'toggle Source to Live',
    editableMode: 'source',
    event: { key: 'm', code: 'KeyM', altKey: true, shiftKey: true },
    expectedHandled: true,
    expectedEffects: ['mode:live']
  },
  {
    name: 'toggle Live to Source',
    editableMode: 'live',
    event: { key: 'm', code: 'KeyM', altKey: true, shiftKey: true },
    expectedHandled: true,
    expectedEffects: ['mode:source']
  },
  {
    name: 'unfocused editor does not select all',
    focused: false,
    event: { key: 'a', code: 'KeyA', ctrlKey: true },
    expectedHandled: false
  },
  {
    name: 'IME composition has priority over save',
    event: { key: 's', code: 'KeyS', ctrlKey: true, isComposing: true },
    expectedHandled: false
  },
  {
    name: 'plain text input is not swallowed',
    event: { key: 'x', code: 'KeyX' },
    expectedHandled: false
  }
];

for (const testCase of cases) {
  const effects: string[] = [];
  let prevented = 0;
  let stopped = 0;
  const context = new Proxy({
    editor: {
      hasFocus: () => testCase.focused ?? true,
      selectAll: () => effects.push('selectAll'),
      undo: () => effects.push('undo'),
      redo: () => effects.push('redo')
    },
    editableMode: testCase.editableMode ?? 'source',
    requestSave: () => effects.push('save'),
    openFindPanel: (target: 'find' | 'replace') => effects.push(`find:${target}`),
    requestMode: (mode: 'live' | 'source') => effects.push(`mode:${mode}`)
  }, {
    get(target, property, receiver) {
      assert.equal(property in target, true, `${testCase.name}: read undeclared context state ${String(property)}`);
      return Reflect.get(target, property, receiver);
    }
  });
  const event = {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; },
    ...testCase.event
  } as KeyboardEvent;

  const handled = handleEditorShortcut(event, context);
  assert.deepEqual({
    handled,
    effects,
    prevented,
    stopped
  }, {
    handled: testCase.expectedHandled,
    effects: [...(testCase.expectedEffects ?? [])],
    prevented: testCase.expectedHandled ? 1 : 0,
    stopped: testCase.expectedHandled ? 1 : 0
  }, testCase.name);
}

console.log('Editor shortcut tests passed');
