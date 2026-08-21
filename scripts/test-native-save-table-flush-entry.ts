import { createEditor } from './test-editor-factory';
import { createDocumentSessionWebviewAdapter } from '../webview/src/adapters/documentSessionWebviewAdapter';
import { createDocumentSaveFlushWebviewAdapter } from '../webview/src/adapters/documentSaveFlushWebviewAdapter';
import { decodeWebviewToHostMessage } from '../src/protocol/messages';
import type { ApplyChangesMessage } from '../src/protocol/documentSync';
import type { FlushDocumentEditsResponse } from '../src/protocol/documentSaveFlush';

type HostRevision = { version: number; text: string };

let hostRevision: HostRevision = { version: 0, text: '' };
let diskText = '';
let persistedDraft: string | null = null;
let editor: ReturnType<typeof createEditor> | null = null;
let nextRequestId = 0;
let pendingSave: {
  readonly requestId: string;
  readonly resolve: (response: FlushDocumentEditsResponse) => void;
} | null = null;

const documentSession = createDocumentSessionWebviewAdapter({
  postMessage: handleWebviewMessage,
  presentText: (text) => {
    editor?.setText(text);
    return true;
  },
  restoreReloadedView: () => undefined,
  showFailureNotice: (message) => { throw new Error(message); },
  reportUnexpectedError: (context, error) => { throw new Error(`${context}: ${String(error)}`); }
});

const saveFlush = createDocumentSaveFlushWebviewAdapter({
  postMessage: handleWebviewMessage,
  commitTransientEdits: () => { editor?.commitTransientEdits(); },
  getCurrentText: () => editor?.getText() ?? '',
  whenDocumentIdle: () => documentSession.whenIdle()
});

function applyChanges(message: ApplyChangesMessage): void {
  if (message.baseVersion !== hostRevision.version) {
    documentSession.accept({ type: 'docChanged', ...hostRevision });
    return;
  }
  let nextText = hostRevision.text;
  for (const change of [...message.changes].sort((left, right) => right.from - left.from)) {
    nextText = nextText.slice(0, change.from) + change.insert + nextText.slice(change.to);
  }
  hostRevision = { version: hostRevision.version + 1, text: nextText };
  documentSession.accept({ type: 'applied', version: hostRevision.version });
}

function handleWebviewMessage(raw: unknown): void {
  const message = decodeWebviewToHostMessage(raw);
  if (!message) throw new Error('Webview emitted an invalid Protocol message');
  if (message.type === 'draftChanged') {
    persistedDraft = message.text;
    return;
  }
  if (message.type === 'applyChanges') {
    applyChanges(message);
    return;
  }
  if (message.type === 'flushDocumentEditsResult') {
    if (pendingSave?.requestId !== message.requestId) return;
    if (message.result.ok && message.result.value.text === hostRevision.text) {
      diskText = hostRevision.text;
    }
    const save = pendingSave;
    pendingSave = null;
    save.resolve(message);
    return;
  }
  throw new Error(`Unexpected Webview message: ${message.type}`);
}

const harness = {
  initialize(text: string) {
    hostRevision = { version: 1, text };
    diskText = text;
    documentSession.start({
      type: 'init',
      documentId: 'file:///native-save-table.md',
      text,
      version: 1,
      savedRevision: { version: 1, text }
    } as never);
    const parent = document.querySelector<HTMLElement>('#editor');
    if (!parent) throw new Error('Missing editor host');
    editor = createEditor({
      parent,
      text,
      initialMode: 'live',
      initialGitGutter: false,
      onApplyChanges: (nextText) => documentSession.localDraftChanged(nextText),
      onOpenLink: () => undefined,
      onSelectionChange: () => undefined
    });
  },
  nativeSave() {
    if (pendingSave) throw new Error('Native save already pending');
    const requestId = `native-save-${nextRequestId++}`;
    const response = new Promise<FlushDocumentEditsResponse>((resolve) => {
      pendingSave = { requestId, resolve };
    });
    saveFlush.accept({ type: 'flushDocumentEdits', requestId });
    return response;
  },
  snapshot() {
    if (!editor) throw new Error('Editor not initialized');
    const active = document.activeElement;
    return {
      hostRevision: { ...hostRevision },
      diskText,
      persistedDraft,
      mode: editor.view.dom.classList.contains('meo-mode-live') ? 'live' : 'source',
      top: editor.getTopVisiblePosition(),
      history: editor.getHistoryDepth(),
      activeTableInput: active instanceof HTMLTextAreaElement
        && active.closest('.meo-md-html-table') !== null,
      tableValue: document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea[data-table-col="1"]'
      )?.value ?? null
    };
  },
  destroy() {
    saveFlush.dispose();
    documentSession.dispose();
    editor?.destroy();
    editor = null;
  }
};

(window as typeof window & { __nativeSaveTableFlush: typeof harness }).__nativeSaveTableFlush = harness;
