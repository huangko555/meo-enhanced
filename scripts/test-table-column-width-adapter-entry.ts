import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, redo, undo } from '@codemirror/commands';
import { createCodeMirrorDomTableColumnWidthAdapter } from '../webview/src/editor/tableColumnWidthAdapter';

declare global {
  interface Window {
    TableColumnWidthAdapterCandidate?: {
      create(parent: HTMLElement, text: string): {
        adapter: ReturnType<typeof createCodeMirrorDomTableColumnWidthAdapter>['adapter'];
        view: EditorView;
        undo(): boolean;
        redo(): boolean;
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
    const candidate = createCodeMirrorDomTableColumnWidthAdapter({ root: adapterRoot });
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: text, extensions: [history(), candidate.extension] })
    });
    instances += 1;
    return {
      adapter: candidate.adapter,
      view,
      undo: () => undo(view),
      redo: () => redo(view),
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
