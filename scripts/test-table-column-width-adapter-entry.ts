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
      createControlled(parent: HTMLElement): {
        adapter: ReturnType<typeof createCodeMirrorDomTableColumnWidthAdapter>['adapter'];
        notifyResize(): void;
        drainScheduler(): number;
        pendingCallbacks(): number;
        resetProjectCalls(): void;
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

    let projectCalls = 0;
    const projectRequests: unknown[] = [];
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
    const restoreEnvironment = () => {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
      window.ResizeObserver = originalResizeObserver;
    };
    instances += 1;
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
        let executed = 0;
        while (callbacks.size > 0) {
          const batch = [...callbacks.values()];
          callbacks.clear();
          for (const callback of batch) {
            executed += 1;
            callback(0);
          }
        }
        return executed;
      },
      pendingCallbacks: () => callbacks.size,
      resetProjectCalls() {
        projectCalls = 0;
        projectRequests.splice(0, projectRequests.length);
      },
      projectRequests: () => structuredClone(projectRequests),
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
  },
  get instances() {
    return instances;
  },
  legacyInstances: 0,
  policyInstances: 1
};
