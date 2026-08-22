import { createEditor } from './test-editor-factory';
import { Compartment, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { getDetailsBlocks, toggleDetailsBlock } from '../webview/src/helpers/detailsBlocks';
import {
  detailsBlockLiveExtensions,
  detailsBlockStateExtensions
} from '../webview/src/helpers/detailsBlocks';
import {
  isLiveInputDerivedWorkRefresh,
  liveInputDerivedWorkExtensions,
  requestLiveInputDerivedWork
} from '../webview/src/editor/liveInputDerivedWork';
import { refreshLiveDecorationsAfterSearchEffect } from '../webview/src/liveMode';

(window as typeof window & {
  __createInputCursorEditor?: typeof createEditor;
  __dispatchProductionInput?: (editor: ReturnType<typeof createEditor>, from: number, insert: string, to?: number) => void;
  __toggleFirstDetails?: (editor: ReturnType<typeof createEditor>) => boolean;
  __createDetailsOperationProbe?: (parent: HTMLElement, text: string) => {
    view: EditorView;
    input(from: number, insert: string): void;
    toggle(): boolean;
    iterations(): number;
    reset(): void;
    destroy(): void;
  };
}).__createInputCursorEditor = createEditor;

(window as any).__observeLiveSearchRefresh = (editor: ReturnType<typeof createEditor>) => {
  const compartment = new Compartment();
  let refreshes = 0;
  editor.view.dispatch({
    effects: StateEffect.appendConfig.of(compartment.of(EditorView.updateListener.of((update) => {
      for (const transaction of update.transactions) {
        if (transaction.effects.some((effect) => effect.is(refreshLiveDecorationsAfterSearchEffect))) {
          refreshes += 1;
        }
      }
    })))
  });
  return {
    count: () => refreshes,
    reset: () => { refreshes = 0; },
    destroy: () => editor.view.dispatch({ effects: compartment.reconfigure([]) })
  };
};

(window as any).__createLiveInputConsumerProbe = (parent: HTMLElement) => {
  let throwNextRefresh = false;
  let throwNextSettle = false;
  let refreshAccepted = false;
  const throwingRefreshField = StateField.define<boolean>({
    create: () => false,
    update(value, transaction) {
      if (throwNextRefresh && isLiveInputDerivedWorkRefresh(transaction)) {
        throwNextRefresh = false;
        throw new Error('controlled live-input refresh failure');
      }
      if (isLiveInputDerivedWorkRefresh(transaction)) {
        refreshAccepted = true;
        return value;
      }
      if (throwNextSettle && refreshAccepted && !transaction.docChanged) {
        throwNextSettle = false;
        refreshAccepted = false;
        throw new Error('controlled live-input settle failure');
      }
      return value;
    }
  });
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: 'probe',
      extensions: [
        ...liveInputDerivedWorkExtensions(),
        throwingRefreshField
      ]
    })
  });
  return {
    view,
    input(insert: string) {
      view.dispatch({
        changes: { from: view.state.doc.length, insert },
        annotations: Transaction.userEvent.of('input.type')
      });
    },
    request(key: object, operation: () => void) {
      requestLiveInputDerivedWork(view, key, operation);
    },
    failNextRefresh() {
      throwNextRefresh = true;
    },
    failNextSettle() {
      throwNextSettle = true;
    },
    destroy() {
      view.destroy();
    }
  };
};

(window as typeof window & {
  __dispatchProductionInput?: (editor: ReturnType<typeof createEditor>, from: number, insert: string, to?: number) => void;
}).__dispatchProductionInput = (editor, from, insert, to = from) => {
  editor.view.dispatch({
    changes: { from, to, insert },
    annotations: Transaction.userEvent.of('input.type')
  });
};

(window as typeof window & {
  __toggleFirstDetails?: (editor: ReturnType<typeof createEditor>) => boolean;
}).__toggleFirstDetails = (editor) => {
  const block = getDetailsBlocks(editor.view.state)[0];
  return block ? toggleDetailsBlock(editor.view, block.anchorFrom) : false;
};

(window as any).__createDetailsOperationProbe = (parent: HTMLElement, text: string) => {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        markdown(),
        ...detailsBlockStateExtensions(),
        ...detailsBlockLiveExtensions(),
        ...liveInputDerivedWorkExtensions()
      ]
    })
  });
  const treePrototype = Object.getPrototypeOf(syntaxTree(view.state)) as { iterate: (...args: any[]) => unknown };
  const originalIterate = treePrototype.iterate;
  let iterations = 0;
  treePrototype.iterate = function(...args: any[]) {
    iterations += 1;
    return originalIterate.apply(this, args);
  };
  return {
    view,
    input(from: number, insert: string) {
      view.dispatch({
        changes: { from, insert },
        annotations: Transaction.userEvent.of('input.type')
      });
    },
    toggle() {
      const block = getDetailsBlocks(view.state)[0];
      return block ? toggleDetailsBlock(view, block.anchorFrom) : false;
    },
    iterations: () => iterations,
    reset() { iterations = 0; },
    destroy() {
      treePrototype.iterate = originalIterate;
      view.destroy();
    }
  };
};
