import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { DiagnosticSuggestionsResult } from '../src/protocol/diagnosticSuggestions';
import {
  createDiagnosticSuggestionApplication,
  type DiagnosticSuggestion
} from '../webview/src/application/diagnosticSuggestion';
import { createDiagnosticSuggestionRuntime } from '../webview/src/adapters/diagnosticSuggestionRuntime';
import { createCodeMirrorDiagnosticSuggestionAdapter } from '../webview/src/editor/diagnosticSuggestionAdapter';
import {
  diagnosticDataField,
  diagnosticField,
  setDiagnosticsEffect,
  type EditorDiagnostic
} from '../webview/src/helpers/diagnostics';
import { createSelectionMenu, createSelectionMenuController } from '../webview/src/helpers/selectionMenu';

type CandidateHandle = {
  setDiagnostics(diagnostics: readonly EditorDiagnostic[]): void;
  externalDocumentPresented(): void;
  presentationChanged(): void;
  acceptSuccess(index: number, suggestions: readonly string[]): boolean;
  acceptFailure(index: number): boolean;
  requests(): readonly { requestId: string; from: number; to: number; message: string }[];
  counts(): { applications: number; runtimes: number; adapters: number; legacyCoordinators: number; presented: number; hidden: number };
  state(): ReturnType<ReturnType<typeof createDiagnosticSuggestionApplication>['getState']>;
  whenIdle(): Promise<void>;
  dispose(): void;
};

type Harness = {
  create(parent: HTMLElement, text: string): CandidateHandle;
};

(globalThis as typeof globalThis & { DiagnosticSuggestionCandidate?: Harness }).DiagnosticSuggestionCandidate = {
  create(parent, text) {
    const application = createDiagnosticSuggestionApplication();
    const requests: Array<{ requestId: string; from: number; to: number; message: string }> = [];
    const menuElements = createSelectionMenu();
    parent.ownerDocument.body.appendChild(menuElements.menu);
    const menuController = createSelectionMenuController(menuElements, () => null);
    let presented = 0;
    let hidden = 0;
    let disposed = false;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        extensions: [diagnosticDataField, diagnosticField]
      })
    });
    const adapter = createCodeMirrorDiagnosticSuggestionAdapter({
      view,
      resolveDiagnostic: (position, selectedRange) => application.resolveDiagnostic(position, selectedRange),
      postMessage(message) {
        requests.push({
          requestId: message.requestId,
          from: message.from,
          to: message.to,
          message: message.message
        });
      },
      presentSuggestions(effect) {
        presented += 1;
        menuController.update({
          visible: true,
          from: effect.from,
          to: effect.to,
          align: 'start',
          anchorX: effect.anchor.x,
          anchorY: effect.anchor.y,
          anchorBottomY: effect.anchor.bottomY,
          diagnosticSuggestions: [...effect.suggestions]
        });
      },
      hideSuggestions() {
        hidden += 1;
        menuController.hide();
      },
      transportOptions: { timeoutMs: 30 }
    });
    const runtime = createDiagnosticSuggestionRuntime({ application, executor: adapter });

    const onClick = (event: MouseEvent): void => {
      const input = adapter.inputFromPointer('click', event);
      if (input) runtime.dispatch(input);
    };
    const onContextMenu = (event: MouseEvent): void => {
      const input = adapter.inputFromPointer('request', event);
      if (!input) return;
      event.preventDefault();
      runtime.dispatch(input);
    };
    view.dom.addEventListener('click', onClick);
    view.dom.addEventListener('contextmenu', onContextMenu);

    const accept = (index: number, result: DiagnosticSuggestionsResult['result']): boolean => {
      const request = requests[index];
      if (!request) return false;
      return adapter.accept({
        type: 'diagnosticSuggestionsResult',
        requestId: request.requestId,
        from: request.from,
        to: request.to,
        result
      });
    };

    return {
      setDiagnostics(diagnostics) {
        const applicationDiagnostics: DiagnosticSuggestion[] = diagnostics.map((diagnostic) => ({
          from: diagnostic.from,
          to: diagnostic.to,
          message: diagnostic.message,
          source: diagnostic.source,
          code: diagnostic.code
        }));
        runtime.dispatch({ type: 'diagnosticsChanged', diagnostics: applicationDiagnostics });
        view.dispatch({ effects: setDiagnosticsEffect.of([...diagnostics]) });
      },
      externalDocumentPresented() {
        runtime.dispatch({ type: 'externalDocumentPresented' });
      },
      presentationChanged() {
        runtime.dispatch({ type: 'presentationChanged' });
      },
      acceptSuccess(index, suggestions) {
        return accept(index, { ok: true, value: { suggestions } });
      },
      acceptFailure(index) {
        return accept(index, { ok: false, error: { code: 'operation-failed', message: 'failed' } });
      },
      requests: () => requests,
      counts: () => ({ applications: 1, runtimes: 1, adapters: 1, legacyCoordinators: 0, presented, hidden }),
      state: () => application.getState(),
      whenIdle: () => runtime.whenIdle(),
      dispose() {
        if (disposed) return;
        disposed = true;
        view.dom.removeEventListener('click', onClick);
        view.dom.removeEventListener('contextmenu', onContextMenu);
        runtime.dispose();
        view.destroy();
        menuElements.menu.remove();
      }
    };
  }
};
