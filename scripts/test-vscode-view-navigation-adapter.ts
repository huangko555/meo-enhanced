import assert from 'node:assert/strict';
import { mock } from 'bun:test';

class Position {
  constructor(readonly line: number, readonly character: number) {}
}

const vscodeWindow: {
  activeTextEditor: unknown;
  visibleTextEditors: unknown[];
} = {
  activeTextEditor: undefined,
  visibleTextEditors: []
};

mock.module('vscode', () => ({ Position, window: vscodeWindow }));

const { createVscodeViewNavigationAdapter } = await import('../src/host/vscodeViewNavigationAdapter');

type FakeUri = {
  scheme: string;
  fsPath: string;
  fragment: string;
  query: string;
  with(changes: Partial<Pick<FakeUri, 'query' | 'fragment'>>): FakeUri;
  toString(): string;
};

const createUri = (fsPath: string, fragment = ''): FakeUri => ({
  scheme: 'file',
  fsPath,
  fragment,
  query: '',
  with(changes) { return createUri(fsPath, changes.fragment ?? fragment); },
  toString() { return `file:${fsPath}${fragment ? `#${fragment}` : ''}`; }
});

const createDocument = (uri: FakeUri, lineCount = 100) => ({
  uri,
  lineCount,
  lineAt: () => ({ range: { end: { character: 5 } } }),
  offsetAt: (position: Position) => position.line * 10 + position.character
});

let stored: Record<string, unknown> = {};
let failUpdate = false;
const workspaceState = {
  get: () => stored,
  update: async (_key: string, value: Record<string, unknown>) => {
    if (failUpdate) throw new Error('workspace update failed');
    stored = value;
  }
};
const context = { workspaceState };
const messages: unknown[] = [];
let resolvedLinkTarget: FakeUri | null = null;

const documentUri = createUri('D:/docs/a.md');
const document = createDocument(documentUri);
const editor = {
  document,
  selection: { start: new Position(2, 1), end: new Position(2, 3) }
};
vscodeWindow.activeTextEditor = editor;
stored = {
  [documentUri.toString()]: { line: 40, lineOffset: 0.5, updatedAt: 1 },
  'file:D:/docs/b.md': { line: 12, lineOffset: 0, updatedAt: 2 }
};
resolvedLinkTarget = documentUri;

const adapter = createVscodeViewNavigationAdapter({
  document: document as never,
  documentUri: documentUri as never,
  context: context as never,
  readMinimumRememberedLines: () => 20,
  getDocumentFragmentHref: (href) => href.includes('#') ? `#${href.split('#')[1]}` : null,
  resolveLocalLinkTarget: async () => resolvedLinkTarget as never,
  post: async (message) => { messages.push(message); return true; },
  reportFailure: () => undefined
});
assert.equal(adapter.getInitialRestore(), null, 'active editor Selection must suppress remembered viewport');
await adapter.ready();
assert.deepEqual(messages.splice(0), [{
  type: 'revealSelection',
  anchor: 21,
  head: 23,
  focus: undefined,
  preserveViewport: false
}]);
await adapter.revealSelectionForEditor(editor as never);
assert.equal(messages.length, 0, 'equal VS Code Selection must be deduplicated');

await adapter.rememberViewport(50, 0.25);
assert.equal((stored[documentUri.toString()] as { line: number }).line, 50);
assert.equal((stored['file:D:/docs/b.md'] as { line: number }).line, 12, 'document-scoped writes must preserve other documents');
failUpdate = true;
await assert.rejects(() => adapter.rememberViewport(51, 0), /workspace update failed/);
failUpdate = false;
await adapter.rememberViewport(51, 0);
assert.equal((stored[documentUri.toString()] as { line: number }).line, 51, 'failed workspace writes must remain retryable');

assert.equal(await adapter.revealDocumentLink('a.md#heading'), true);
assert.deepEqual(messages.splice(0), [{ type: 'revealDocumentFragment', href: '#heading' }]);
resolvedLinkTarget = createUri('D:/docs/other.md');
assert.equal(await adapter.revealDocumentLink('other.md#heading'), false);
assert.equal(messages.length, 0, 'another document fragment must stay on the normal open-link path');
adapter.dispose();

vscodeWindow.activeTextEditor = undefined;
vscodeWindow.visibleTextEditors = [];
const lineUri = createUri('D:/docs/line.md', 'L999C99');
const lineMessages: unknown[] = [];
const lineAdapter = createVscodeViewNavigationAdapter({
  document: createDocument(lineUri) as never,
  documentUri: lineUri as never,
  context: context as never,
  readMinimumRememberedLines: () => 20,
  getDocumentFragmentHref: () => null,
  resolveLocalLinkTarget: async () => null,
  post: async (message) => { lineMessages.push(message); return true; },
  reportFailure: () => undefined
});
assert.equal(lineAdapter.getInitialRestore(), null);
await lineAdapter.ready();
assert.deepEqual(lineMessages, [{
  type: 'revealSelection',
  anchor: 995,
  head: 995,
  focus: undefined,
  preserveViewport: false
}], 'line/column fragments must clamp to EOF and line length');
lineAdapter.dispose();

const invalidUri = createUri('D:/docs/invalid.md', 'L0');
const invalidMessages: unknown[] = [];
const invalidAdapter = createVscodeViewNavigationAdapter({
  document: createDocument(invalidUri) as never,
  documentUri: invalidUri as never,
  context: context as never,
  readMinimumRememberedLines: () => 20,
  getDocumentFragmentHref: () => null,
  resolveLocalLinkTarget: async () => null,
  post: async (message) => { invalidMessages.push(message); return true; },
  reportFailure: () => undefined
});
await invalidAdapter.ready();
assert.deepEqual(invalidMessages, [{ type: 'revealDocumentFragment', href: '#L0' }], 'invalid line syntax must degrade to a document fragment');
invalidAdapter.dispose();

console.log('VS Code view navigation adapter checks passed');
