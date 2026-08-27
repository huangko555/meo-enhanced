import { createDocumentSessionActionAdapter } from '../webview/src/adapters/documentSessionActions';
import {
  createDocumentSessionCoordinatorFromInit,
  createDocumentSessionTransport
} from '../webview/src/adapters/documentSessionTransport';
import { createEditor } from './test-editor-factory';
import { respondToDocumentSessionRequest } from '../src/host/documentSessionRequestHandler';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import type { DocumentSessionInput } from '../src/application/documentSession';
import type { ApplyChangesMessage } from '../src/protocol/documentSync';
import type { InitMessage } from '../src/protocol/readyInit';

type HostRevision = { version: number; text: string };

let coordinator: ReturnType<typeof createDocumentSessionCoordinatorFromInit> | null = null;
let actionAdapter: ReturnType<typeof createDocumentSessionActionAdapter> | null = null;
let transport: ReturnType<typeof createDocumentSessionTransport> | null = null;
let editor: ReturnType<typeof createEditor> | null = null;
let operation = Promise.resolve();
let hostRevision: HostRevision = { version: 0, text: '' };
let savedText = '';
let persistedDraft: string | null = null;
let holdApplyChanges = false;
let failNextSave = false;
let revisionFailuresRemaining = 0;
let coordinatorStarts = 0;
const legacyCoordinatorStarts = 0;
const heldApplyMessages: ApplyChangesMessage[] = [];
const pendingHostInputs: DocumentSessionInput[] = [];
const messages: unknown[] = [];
const notices: string[] = [];

function requireRuntime() {
  if (!coordinator || !actionAdapter || !transport || !editor) {
    throw new Error('Document Session candidate is not initialized');
  }
  return { coordinator, actionAdapter, transport, editor };
}

function applyChanges(message: ApplyChangesMessage): void {
  if (message.baseVersion !== hostRevision.version) {
    pendingHostInputs.push({
      type: 'hostRevisionChanged',
      version: hostRevision.version,
      text: hostRevision.text
    });
    return;
  }
  let nextText = hostRevision.text;
  for (const change of [...message.changes].sort((left, right) => right.from - left.from)) {
    nextText = nextText.slice(0, change.from) + change.insert + nextText.slice(change.to);
  }
  hostRevision = { version: hostRevision.version + 1, text: nextText };
  pendingHostInputs.push({ type: 'hostChangeApplied', version: hostRevision.version });
}

function postMessage(rawMessage: unknown): void {
  const message = decodeWebviewToHostMessage(rawMessage);
  if (!message) throw new Error('Candidate emitted an invalid Protocol message');
  messages.push(message);

  if (message.type === 'draftChanged') {
    persistedDraft = message.text;
    return;
  }
  if (message.type === 'applyChanges') {
    if (holdApplyChanges) heldApplyMessages.push(message);
    else applyChanges(message);
    return;
  }
  if (message.type !== 'saveDocumentRevision' && message.type !== 'requestDocumentRevision') {
    throw new Error(`Unexpected candidate message: ${message.type}`);
  }

  const { transport } = requireRuntime();
  void respondToDocumentSessionRequest(message, {
    readRevision: async () => {
      if (message.type === 'requestDocumentRevision' && revisionFailuresRemaining > 0) {
        revisionFailuresRemaining -= 1;
        throw new Error('forced revision request failure');
      }
      return hostRevision;
    },
    saveRevision: async (revision) => {
      if (failNextSave) {
        failNextSave = false;
        return {
          ok: false,
          error: { code: 'operation-failed', message: 'forced save failure' }
        };
      }
      savedText = revision.text;
      return { ok: true, value: { revision } };
    }
  }).then((response) => {
    const decoded = decodeHostToWebviewMessage(response);
    if (!decoded
      || (decoded.type !== 'saveDocumentRevisionResult'
        && decoded.type !== 'documentRevisionResult')) {
      throw new Error('Host emitted an invalid Document Session response');
    }
    transport.accept(decoded);
  });
}

async function processInput(input: DocumentSessionInput): Promise<void> {
  const runtime = requireRuntime();
  await runtime.actionAdapter.execute(runtime.coordinator.handle(input));
  while (pendingHostInputs.length > 0) {
    const nextInput = pendingHostInputs.shift();
    if (nextInput) {
      await runtime.actionAdapter.execute(runtime.coordinator.handle(nextInput));
    }
  }
}

function enqueueInput(input: DocumentSessionInput): Promise<void> {
  operation = operation.then(() => processInput(input));
  return operation;
}

function enqueueLocalText(text: string): void {
  operation = operation.then(async () => {
    await processInput({ type: 'localDraftChanged', text });
    await processInput({ type: 'submitPendingDraft' });
  });
}

const candidate = {
  initialize(rawInit: unknown) {
    const decoded = decodeHostToWebviewMessage(rawInit);
    if (!decoded || decoded.type !== 'init') {
      throw new Error('Document Session candidate requires a decoded Init message');
    }
    const init: InitMessage = decoded;
    if (coordinator !== null) throw new Error('Document Session coordinator already started');
    coordinatorStarts += 1;
    coordinator = createDocumentSessionCoordinatorFromInit(init);
    hostRevision = { version: init.version, text: init.text.replace(/\r\n/g, '\n') };
    savedText = init.savedRevision?.text ?? '';
    transport = createDocumentSessionTransport(postMessage);
    actionAdapter = createDocumentSessionActionAdapter({
      uiLanguage: 'en',
      postMessage,
      presentText: (text) => {
        requireRuntime().editor.setText(text);
        return true;
      },
      executeRemote: (action) => requireRuntime().transport.execute(action),
      handleInput: (input) => requireRuntime().coordinator.handle(input),
      showFailureNotice: (message) => notices.push(message)
    });
    const parent = document.querySelector<HTMLElement>('#editor');
    if (!parent) throw new Error('Missing editor host');
    editor = createEditor({
      parent,
      text: init.text,
      initialMode: 'source',
      initialGitGutter: false,
      onApplyChanges: enqueueLocalText,
      onOpenLink: () => undefined,
      onSelectionChange: () => undefined,
    });
  },
  async whenIdle() {
    await operation;
  },
  holdApplyChanges(value: boolean) {
    holdApplyChanges = value;
  },
  async releaseApplyChanges() {
    holdApplyChanges = false;
    for (const message of heldApplyMessages.splice(0)) applyChanges(message);
    operation = operation.then(async () => {
      while (pendingHostInputs.length > 0) {
        const input = pendingHostInputs.shift();
        if (input) await processInput(input);
      }
    });
    await operation;
  },
  externalChange(text: string) {
    hostRevision = { version: hostRevision.version + 1, text };
    return enqueueInput({ type: 'hostRevisionChanged', ...hostRevision });
  },
  setMode(mode: 'live' | 'source') {
    requireRuntime().editor.setMode(mode);
  },
  undo() {
    return requireRuntime().editor.undo();
  },
  redo() {
    return requireRuntime().editor.redo();
  },
  replay(version: number, text: string) {
    return enqueueInput({ type: 'hostRevisionChanged', version, text });
  },
  save() {
    return enqueueInput({ type: 'saveRequested' });
  },
  failNextSave() {
    failNextSave = true;
  },
  failRevisionRequests(count: number) {
    revisionFailuresRemaining = Math.max(0, Math.floor(count));
  },
  discard() {
    hostRevision = { version: hostRevision.version + 1, text: savedText };
    return enqueueInput({ type: 'hostReloadedFromDisk', ...hostRevision });
  },
  snapshot() {
    const runtime = requireRuntime();
    return {
      syncOwner: 'document-session',
      coordinatorStarts,
      legacyCoordinatorStarts,
      editorText: runtime.editor.getText(),
      focused: runtime.editor.hasFocus(),
      viewport: runtime.editor.getTopVisiblePosition(),
      hostRevision: { ...hostRevision },
      savedText,
      persistedDraft,
      messages: [...messages],
      notices: [...notices]
    };
  },
  destroy() {
    transport?.cancelAll('Candidate trace closed');
    editor?.destroy();
  }
};

(window as typeof window & { __documentSessionCandidate: typeof candidate }).__documentSessionCandidate = candidate;
