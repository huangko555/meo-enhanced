import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { createDocumentSessionCoordinator } from '../src/application/documentSession';
import { createPendingDraftRecovery } from '../src/application/pendingDraftRecovery';
import {
  createPanelSessionControllerParams,
  createPanelSessionTestDocument,
  createPanelSessionTestUri,
  createPanelSessionVscodeMock,
  panelSessionDisposable
} from './panel-session-test-helper';

const document = createPanelSessionTestDocument(createPanelSessionTestUri('C:/replacement.md'), '');
class Range {
  constructor(readonly start: { offset: number }, readonly end: { offset: number }) {}
}
class WorkspaceEdit {
  readonly edits: Array<{ range: Range; text: string }> = [];
  replace(_uri: unknown, range: Range, text: string): void { this.edits.push({ range, text }); }
}
let appliedEdits: WorkspaceEdit['edits'] = [];
mock.module('vscode', () => createPanelSessionVscodeMock(document, {
  Range,
  WorkspaceEdit,
  applyEdit: async (edit: WorkspaceEdit) => {
    appliedEdits = edit.edits;
    const eol = document.text.includes('\r\n') ? '\r\n' : '\n';
    for (const { range, text } of edit.edits) {
      document.text = document.text.slice(0, range.start.offset)
        + text.replace(/\r?\n/g, eol) + document.text.slice(range.end.offset);
    }
    document.version += 1;
    return true;
  }
}));
const { createPanelSessionController } = await import('../src/extension/panelSession');

for (const eol of ['\n', '\r\n']) {
  for (const [before, after] of [
    ['first\nsecond\nthird', 'first\nsecXond\nthird'],
    ['first\nsecond\nthird', 'first\nthird'],
    ['first\nsecond\nthird', 'first\nnew\nsecond\nthird'],
    ['first\nsecond\nthird', 'FIRST\nsecond\nTHIRD'],
    ['first\na😀z\nthird', 'first\na😁z\nthird'],
    ['first\na😀z\nthird', 'first\naz\nthird'],
    ['first\nsecond\nthird', '']
  ]) {
    document.text = before.replaceAll('\n', eol);
    document.version = 1;
    const messages: Array<Record<string, unknown>> = [];
    const panel = {
      active: true,
      webview: {
        postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; },
        onDidReceiveMessage: () => panelSessionDisposable()
      },
      onDidChangeViewState: () => panelSessionDisposable(),
      onDidDispose: () => panelSessionDisposable()
    };
    const controller = createPanelSessionController(createPanelSessionControllerParams({
      panel, document,
      pendingDraftRecovery: createPendingDraftRecovery({
        readCurrentText: () => document.text,
        applyDraft: async () => true
      }),
      readDiskText: () => document.text
    }) as never);
    try {
      const coordinator = createDocumentSessionCoordinator({
        documentId: document.uri.toString(),
        revision: { number: 1, text: before },
        savedRevision: { revisionNumber: 1, text: before }
      });
      coordinator.handle({ type: 'localDraftChanged', text: after });
      const action = coordinator.handle({ type: 'submitPendingDraft' })
        .find(action => action.type === 'applyTextChange');
      assert.ok(action);
      await controller.handleMessage({ type: 'applyChanges', baseVersion: action.baseVersion, changes: [...action.changes] });
      assert.equal(document.text, after.replaceAll('\n', eol), 'Host must apply normalized edit ranges without changing the surrounding line endings');
      assert.ok(messages.some(message => message.type === 'applied' && message.version === 2));
      assert.equal(appliedEdits.length, 1);
      const accepted = document.text;
      await controller.handleMessage({ type: 'applyChanges', baseVersion: 1, changes: [...action.changes] });
      assert.equal(document.text, accepted, 'a stale replacement must not be applied twice');
      assert.equal(document.version, 2);
    } finally {
      controller.dispose();
    }
  }
}
console.log('Document Session bounded replacement Host checks passed (LF, CRLF, Unicode, stale revisions)');
