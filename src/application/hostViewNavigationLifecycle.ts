export type ViewSelection = {
  readonly anchor: number;
  readonly head: number;
};

export type ViewNavigationReveal =
  | {
      readonly kind: 'selection';
      readonly anchor: number;
      readonly head: number;
      readonly focus: false | undefined;
      readonly preserveViewport: boolean;
    }
  | { readonly kind: 'fragment'; readonly href: string };

export type HostViewNavigationLifecycle = {
  hasPendingExplicitNavigation(): boolean;
  revealSelection(selection: ViewSelection): Promise<void>;
  revealFragment(href: string): Promise<void>;
  ready(): Promise<void>;
  flush(): Promise<void>;
  dispose(): void;
};

/** Host Session port; the concrete editor source is interpreted only by its Adapter. */
export type HostViewNavigationPort<TEditorSource> = {
  hasPendingExplicitNavigation(): boolean;
  ready(): Promise<void>;
  flush(): Promise<void>;
  revealSelectionForEditor(editor: TEditorSource | undefined): Promise<void>;
  revealCurrentEditorSelection(): Promise<void>;
  revealDocumentLink(href: string): Promise<boolean>;
  dispose(): void;
};

export type HostViewNavigationDependencies = {
  readonly initialSelection: ViewSelection | null;
  readonly initialFragment: string | null;
  readonly output: {
    reveal(reveal: ViewNavigationReveal): Promise<boolean>;
  };
};

const selectionKey = (selection: ViewSelection): string => `${selection.anchor}:${selection.head}`;

/** Owns Host-side reveal ordering; concrete editor and Protocol work stay in adapters. */
export function createHostViewNavigationLifecycle(
  dependencies: HostViewNavigationDependencies
): HostViewNavigationLifecycle {
  let pendingSelection = dependencies.initialSelection;
  let pendingFragment = dependencies.initialFragment;
  let lastSentSelectionKey: string | null = null;
  let deliveredInitialSelection = false;
  let ready = false;
  let disposed = false;
  let requestGeneration = 0;
  let flushRunning: Promise<void> | null = null;

  const flush = (): Promise<void> => {
    if (disposed || !ready) return Promise.resolve();
    if (flushRunning) return flushRunning;
    const running = (async () => {
      while (!disposed && ready) {
        if (pendingSelection) {
          const selection = pendingSelection;
          const key = selectionKey(selection);
          const attemptGeneration = requestGeneration;
          const preserveViewport = deliveredInitialSelection;
          const posted = await dependencies.output.reveal({
            kind: 'selection',
            anchor: selection.anchor,
            head: selection.head,
            focus: preserveViewport ? false : undefined,
            preserveViewport
          });
          if (disposed) return;
          if (!posted) {
            if (pendingFragment) {
              const fragment = pendingFragment;
              const fragmentPosted = await dependencies.output.reveal({ kind: 'fragment', href: fragment });
              if (disposed) return;
              if (fragmentPosted && pendingFragment === fragment) pendingFragment = null;
            }
            if (requestGeneration !== attemptGeneration) continue;
            return;
          }
          lastSentSelectionKey = key;
          deliveredInitialSelection = true;
          if (pendingSelection && selectionKey(pendingSelection) === key) pendingSelection = null;
          continue;
        }
        if (pendingFragment) {
          const fragment = pendingFragment;
          const attemptGeneration = requestGeneration;
          const posted = await dependencies.output.reveal({ kind: 'fragment', href: fragment });
          if (disposed) return;
          if (!posted) {
            if (requestGeneration !== attemptGeneration) continue;
            return;
          }
          if (pendingFragment === fragment) pendingFragment = null;
          continue;
        }
        return;
      }
    })().finally(() => {
      if (flushRunning === running) flushRunning = null;
    });
    flushRunning = running;
    return running;
  };

  return {
    hasPendingExplicitNavigation() {
      return pendingSelection !== null || pendingFragment !== null;
    },
    revealSelection(selection) {
      if (disposed || selectionKey(selection) === lastSentSelectionKey) return Promise.resolve();
      pendingSelection = selection;
      requestGeneration += 1;
      return flush();
    },
    revealFragment(href) {
      if (disposed || !href) return Promise.resolve();
      pendingFragment = href;
      requestGeneration += 1;
      return flush();
    },
    ready() {
      if (disposed) return Promise.resolve();
      ready = true;
      return flush();
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      ready = false;
      pendingSelection = null;
      pendingFragment = null;
      requestGeneration += 1;
    }
  };
}
