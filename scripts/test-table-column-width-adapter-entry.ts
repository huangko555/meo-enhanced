import { EditorState, StateField, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, redo, undo } from '@codemirror/commands';
import { createCodeMirrorDomTableColumnWidthAdapter } from '../webview/src/editor/tableColumnWidthAdapter';
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
        destroy(): void;
      };
      createControlled(parent: HTMLElement): {
        adapter: ReturnType<typeof createCodeMirrorDomTableColumnWidthAdapter>['adapter'];
        notifyResize(): void;
        drainScheduler(): void;
        destroy(): void;
      };
    };
  }
}

window.TableColumnWidthAdapterCandidate = {
  create(parent, text) {
    const adapterRoot = document.createElement('div');
    adapterRoot.className = 'table-column-width-candidate-root';
    parent.append(adapterRoot);
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
    const candidate = createCodeMirrorDomTableColumnWidthAdapter({ root: adapterRoot });
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
      destroy() {
        candidate.adapter.dispose();
        view.destroy();
        adapterRoot.remove();
      }
    };
  },
  createControlled(parent) {
    const adapterRoot = document.createElement('div');
    adapterRoot.className = 'table-column-width-candidate-root';
    parent.append(adapterRoot);
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    const originalResizeObserver = window.ResizeObserver;
    const callbacks = new Map<number, FrameRequestCallback>();
    const observers = new Set<{
      readonly callback: ResizeObserverCallback;
      readonly targets: Set<Element>;
    }>();
    let nextFrameId = 1;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      callbacks.set(frameId, callback);
      return frameId;
    }) as typeof requestAnimationFrame;
    window.cancelAnimationFrame = ((frameId: number) => {
      callbacks.delete(frameId);
    }) as typeof cancelAnimationFrame;
    window.ResizeObserver = class ControlledResizeObserver {
      readonly record: { readonly callback: ResizeObserverCallback; readonly targets: Set<Element> };
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: new Set() };
        observers.add(this.record);
      }
      observe(target: Element) { this.record.targets.add(target); }
      unobserve(target: Element) { this.record.targets.delete(target); }
      disconnect() {
        this.record.targets.clear();
        observers.delete(this.record);
      }
    } as unknown as typeof ResizeObserver;

    const candidate = createCodeMirrorDomTableColumnWidthAdapter({ root: adapterRoot });
    const restoreEnvironment = () => {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
      window.ResizeObserver = originalResizeObserver;
    };
    return {
      adapter: candidate.adapter,
      notifyResize() {
        for (const observer of observers) {
          const entries = [...observer.targets].map((target) => ({
            target,
            contentRect: { width: (target as HTMLElement).clientWidth }
          })) as ResizeObserverEntry[];
          observer.callback(entries, {} as ResizeObserver);
        }
      },
      drainScheduler() {
        while (callbacks.size > 0) {
          const batch = [...callbacks.values()];
          callbacks.clear();
          for (const callback of batch) {
            callback(0);
          }
        }
      },
      destroy() {
        try {
          candidate.adapter.dispose();
          adapterRoot.remove();
        } finally {
          callbacks.clear();
          restoreEnvironment();
        }
      }
    };
  }
};
