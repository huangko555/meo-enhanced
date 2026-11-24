import assert from 'node:assert/strict';
import { mock } from 'bun:test';

class Position {
  constructor(readonly line: number, readonly character: number) {}
}

const vscodeWindow: { activeTextEditor: unknown; visibleTextEditors: unknown[] } = {
  activeTextEditor: undefined,
  visibleTextEditors: []
};
const EndOfLine = { LF: 1, CRLF: 2 };
mock.module('vscode', () => ({ EndOfLine, Position, window: vscodeWindow }));

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
  scheme: 'file', fsPath, fragment, query: '',
  with(changes) { return createUri(fsPath, changes.fragment ?? fragment); },
  toString() { return `file:${fsPath}${fragment ? `#${fragment}` : ''}`; }
});
const createDocument = (uri: FakeUri) => ({
  uri,
  lineCount: 100,
  lineAt: () => ({ range: { end: { character: 5 } } }),
  offsetAt: (position: Position) => position.line * 10 + position.character
});

const documentUri = createUri('D:/docs/a.md');
const document = createDocument(documentUri);
const editor = { document, selection: { start: new Position(2, 1), end: new Position(2, 3) } };
vscodeWindow.activeTextEditor = editor;
const messages: unknown[] = [];
let resolvedLinkTarget: FakeUri | null = documentUri;
const adapter = createVscodeViewNavigationAdapter({
  document: document as never,
  documentUri: documentUri as never,
  getDocumentFragmentHref: (href) => href.includes('#') ? `#${href.split('#')[1]}` : null,
  resolveLocalLinkTarget: async () => resolvedLinkTarget as never,
  post: async (message) => { messages.push(message); return true; }
});
assert.equal(adapter.hasPendingExplicitNavigation(), true);
await adapter.ready();
assert.deepEqual(messages.splice(0), [{
  type: 'revealSelection', anchor: 21, head: 23, focus: undefined, preserveViewport: false
}], 'a fresh adapter must reveal current VS Code selection without consulting MEO workspace state');
await adapter.revealSelectionForEditor(editor as never);
assert.equal(messages.length, 0, 'same-session equal Selection must be deduplicated');
assert.equal(await adapter.revealDocumentLink('a.md#heading'), true);
assert.deepEqual(messages.splice(0), [{ type: 'revealDocumentFragment', href: '#heading' }]);
resolvedLinkTarget = createUri('D:/docs/other.md');
assert.equal(await adapter.revealDocumentLink('other.md#heading'), false);
assert.equal(messages.length, 0, 'another document fragment must stay on the normal open-link path');
adapter.dispose();

vscodeWindow.activeTextEditor = undefined;
const lineUri = createUri('D:/docs/line.md', 'L999C99');
const lineMessages: unknown[] = [];
const lineAdapter = createVscodeViewNavigationAdapter({
  document: createDocument(lineUri) as never,
  documentUri: lineUri as never,
  getDocumentFragmentHref: () => null,
  resolveLocalLinkTarget: async () => null,
  post: async (message) => { lineMessages.push(message); return true; }
});
assert.equal(lineAdapter.hasPendingExplicitNavigation(), true);
await lineAdapter.ready();
assert.deepEqual(lineMessages, [{
  type: 'revealSelection', anchor: 995, head: 995, focus: undefined, preserveViewport: false
}], 'explicit line/column navigation must remain available');
lineAdapter.dispose();

const invalidUri = createUri('D:/docs/invalid.md', 'L0');
const invalidMessages: unknown[] = [];
const invalidAdapter = createVscodeViewNavigationAdapter({
  document: createDocument(invalidUri) as never,
  documentUri: invalidUri as never,
  getDocumentFragmentHref: () => null,
  resolveLocalLinkTarget: async () => null,
  post: async (message) => { invalidMessages.push(message); return true; }
});
assert.equal(invalidAdapter.hasPendingExplicitNavigation(), true);
await invalidAdapter.ready();
assert.deepEqual(
  invalidMessages,
  [{ type: 'revealDocumentFragment', href: '#L0' }],
  'invalid line syntax must degrade to a document fragment'
);
invalidAdapter.dispose();

const textLines = ['alpha', 'bravo', 'x target y'];
const createTextDocument = (uri: FakeUri, eol: '\n' | '\r\n') => ({
  uri,
  lineCount: textLines.length,
  eol: eol.length === 2 ? EndOfLine.CRLF : EndOfLine.LF,
  lineAt: (line: number) => ({ range: { end: { character: textLines[line]!.length } } }),
  offsetAt: (position: Position) => textLines.slice(0, position.line)
    .reduce((offset, line) => offset + line.length + eol.length, position.character)
});
const revealInTextDocument = async (
  eol: '\n' | '\r\n',
  fragment: string,
  selection?: { start: Position; end: Position }
): Promise<unknown> => {
  const textDocument = createTextDocument(createUri('D:/docs/eol.md', fragment), eol);
  vscodeWindow.activeTextEditor = selection ? { document: textDocument, selection } : undefined;
  const revealed: unknown[] = [];
  const textAdapter = createVscodeViewNavigationAdapter({
    document: textDocument as never,
    documentUri: textDocument.uri as never,
    getDocumentFragmentHref: () => null,
    resolveLocalLinkTarget: async () => null,
    post: async (message) => { revealed.push(message); return true; }
  });
  await textAdapter.ready();
  textAdapter.dispose();
  return revealed[0];
};
for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
  assert.deepEqual(
    await revealInTextDocument(eol, '', { start: new Position(0, 1), end: new Position(2, 8) }),
    { type: 'revealSelection', anchor: 1, head: 20, focus: undefined, preserveViewport: false },
    `${label} text-editor selection must use the Webview's LF offsets`
  );
  for (const [fragment, offset] of [['L1C3', 2], ['L3C3', 14], ['L3C99', 22]] as const) {
    assert.deepEqual(
      await revealInTextDocument(eol, fragment),
      { type: 'revealSelection', anchor: offset, head: offset, focus: undefined, preserveViewport: false },
      `${label} #${fragment} must use the Webview's LF offsets`
    );
  }
}

console.log('VS Code view navigation adapter checks passed');
