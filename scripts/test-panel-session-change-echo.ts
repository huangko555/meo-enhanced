import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { createPendingDraftRecovery } from '../src/application/pendingDraftRecovery';
import { createPanelSessionControllerParams, createPanelSessionTestDocument,
  createPanelSessionTestUri, createPanelSessionVscodeMock, panelSessionDisposable } from './panel-session-test-helper';

const document = createPanelSessionTestDocument(createPanelSessionTestUri('C:/echo.md'), '');
class Range { constructor(readonly start: { offset: number }, readonly end: { offset: number }) {} }
class WorkspaceEdit {
  readonly edits: Array<{ range: Range; text: string }> = [];
  replace(_uri: unknown, range: Range, text: string) { this.edits.push({ range, text }); }
}
type Change = { rangeOffset: number; rangeLength: number; text: string };
let onChange: (event: { document: typeof document; contentChanges: Change[] }) => void = () => undefined;
let foreignDuringApply = false;
let failApply = false;
const notify = (changes: Change[]) => onChange({ document, contentChanges: changes });
mock.module('vscode', () => createPanelSessionVscodeMock(document, {
  Range, WorkspaceEdit,
  onDidChangeTextDocument: listener => { onChange = listener; return panelSessionDisposable(); },
  applyEdit: async (edit: WorkspaceEdit) => {
    const eol = document.text.includes('\r\n') ? '\r\n' : '\n';
    const changes = edit.edits.map(({ range, text }) => ({ rangeOffset: range.start.offset,
      rangeLength: range.end.offset - range.start.offset, text: text.replace(/\r?\n/g, eol) }));
    for (const change of changes) document.text = document.text.slice(0, change.rangeOffset)
      + change.text + document.text.slice(change.rangeOffset + change.rangeLength);
    document.version += 1;
    notify(changes);
    if (foreignDuringApply) {
      document.text += '\nexternal';
      document.version += 1;
      notify([{ rangeOffset: document.text.length - 9, rangeLength: 0, text: '\nexternal' }]);
    }
    return !failApply;
  }
}));
const { createPanelSessionController } = await import('../src/extension/panelSession');
const posted: Array<Record<string, unknown>> = [];
const panel = {
  active: true,
  webview: { postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; },
    onDidReceiveMessage: () => panelSessionDisposable() },
  onDidChangeViewState: () => panelSessionDisposable(), onDidDispose: () => panelSessionDisposable()
};
const settle = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); };
for (const eol of ['\n', '\r\n']) {
  document.text = 'paragraph 😀\n'.repeat(65_536).replaceAll('\n', eol);
  document.version = 1;
  posted.length = 0;
  let recovered = '';
  const recovery = createPendingDraftRecovery({ readCurrentText: () => document.text,
    applyDraft: async (_base, text) => { recovered = text; return true; } });
  const controller = createPanelSessionController(createPanelSessionControllerParams({
    panel, document, readDiskText: () => document.text,
    pendingDraftRecovery: recovery
  }) as never);
  try {
    for (let index = 0; index < 12; index += 1) {
      await controller.handleMessage({ type: 'applyChanges', baseVersion: document.version,
        changes: [{ from: 25, to: 25, insert: index % 2 ? '😁\n' : 'x' }] });
      await settle();
    }
    assert.equal(posted.filter(message => message.type === 'applied').length, 12);
    assert.equal(posted.filter(message => message.type === 'docChanged').length, 0,
      'accepted editor changes must not echo the complete document back through the workbench');
    foreignDuringApply = true;
    const base = document.version;
    await controller.handleMessage({ type: 'applyChanges', baseVersion: base,
      changes: [{ from: 0, to: 0, insert: 'local' }] });
    await settle();
    assert.ok(posted.some(message => message.type === 'applied' && message.version === base + 1),
      'the local acknowledgement must identify its own revision, not a subsequent foreign edit');
    assert.ok(posted.some(message => message.type === 'docChanged' && message.version === base + 2
      && message.text === document.text), 'external edits during apply must still broadcast');
    foreignDuringApply = false;
    posted.length = 0;
    await controller.handleMessage({ type: 'applyChanges', baseVersion: base,
      changes: [{ from: 0, to: 0, insert: 'stale' }] });
    assert.equal(posted.at(-1)?.type, 'docChanged', 'stale input must still request reconciliation');
    failApply = true;
    posted.length = 0;
    await controller.handleMessage({ type: 'applyChanges', baseVersion: document.version,
      changes: [{ from: 0, to: 0, insert: 'rejected' }] });
    await settle();
    assert.equal(posted.filter(message => message.type === 'applied').length, 0);
    assert.ok(posted.some(message => message.type === 'docChanged'), 'failed apply must restore a complete revision');
    failApply = false;
    await controller.handleMessage({ type: 'draftChanged', receiptVersion: 1, text: 'full checkpoint 😀' });
    await controller.handleMessage({ type: 'draftPatched', baseReceiptVersion: 1, receiptVersion: 2,
      change: { from: 0, to: 4, insert: 'latest' } });
    assert.equal(await recovery.recover(), true);
    assert.equal(recovered, 'latest checkpoint 😀', 'the production Host route must recover the reconstructed draft');
    await controller.handleMessage({ type: 'draftPatched', baseReceiptVersion: 99, receiptVersion: 100,
      change: { from: 0, to: 0, insert: 'bad' } });
    assert.equal(posted.at(-1)?.type, 'requestDraftRecoverySnapshot');
  } finally { controller.dispose(); }
}
console.log('Panel local-echo budget, foreign edit, stale apply and failure checks passed (LF/CRLF)');
