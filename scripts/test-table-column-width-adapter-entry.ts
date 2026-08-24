import { EditorState, StateField, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, redo, undo } from '@codemirror/commands';
import { createCodeMirrorDomTableColumnWidthAdapter } from '../webview/src/editor/tableColumnWidthAdapter';
import { tableColumnWidthPolicy } from '../webview/src/editor/tableColumnWidthPolicy';
import {
  isLiveInputDerivedWorkRefresh,
  liveInputDerivedWorkExtensions
} from '../webview/src/editor/liveInputDerivedWork';

declare global {
  interface Window {
    TableColumnWidthAdapterCandidate?: {
      create(parent: HTMLElement, text: string): {
        adapter: ReturnType<typeof createCodeMirrorDomTableColumnWidthAdapter>['adapter'];
        view: EditorView;
        undo(): boolean;
        redo(): boolean;
        dispatchInput(from: number, insert: string): void;
        failNextRefresh(): void;
        resetProjectCalls(): void;
        projectCalls(): number;
        projectRequests(): readonly unknown[];
        destroy(): void;
      };
      instances: number;
      legacyInstances: number;
      policyInstances: number;
    };
  }
}

let instances = 0;

window.TableColumnWidthAdapterCandidate = {
  create(parent, text) {
    const adapterRoot = document.createElement('div');
    adapterRoot.className = 'table-column-width-candidate-root';
    parent.append(adapterRoot);
    let projectCalls = 0;
    const projectRequests: unknown[] = [];
    let throwNextRefresh = false;
    const throwingRefreshField = StateField.define<boolean>({
      create: () => false,
      update(value, transaction) {
        if (throwNextRefresh && isLiveInputDerivedWorkRefresh(transaction)) {
          throwNextRefresh = false;
          throw new Error('controlled table refresh failure');
        }
        return value;
      }
    });
    const candidate = createCodeMirrorDomTableColumnWidthAdapter({
      root: adapterRoot,
      policy: {
        resize: (request) => tableColumnWidthPolicy.resize(request),
        project(request) {
          projectCalls += 1;
          projectRequests.push(structuredClone(request));
          return tableColumnWidthPolicy.project(request);
        }
      }
    });
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          ...liveInputDerivedWorkExtensions(),
          candidate.extension,
          throwingRefreshField
        ]
      })
    });
    instances += 1;
    return {
      adapter: candidate.adapter,
      view,
      undo: () => undo(view),
      redo: () => redo(view),
      dispatchInput(from, insert) {
        view.dispatch({
          changes: { from, insert },
          annotations: Transaction.userEvent.of('input.type')
        });
      },
      failNextRefresh() { throwNextRefresh = true; },
      resetProjectCalls() {
        projectCalls = 0;
        projectRequests.splice(0, projectRequests.length);
      },
      projectCalls: () => projectCalls,
      projectRequests: () => structuredClone(projectRequests),
      destroy() {
        candidate.adapter.dispose();
        view.destroy();
        adapterRoot.remove();
      }
    };
  },
  get instances() {
    return instances;
  },
  legacyInstances: 0,
  policyInstances: 1
};
