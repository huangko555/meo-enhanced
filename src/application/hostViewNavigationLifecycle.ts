export type ViewSelection = {
  readonly anchor: number;
  readonly head: number;
};

export type RememberedViewport = {
  readonly line: number;
  readonly lineOffset: number;
  readonly updatedAt: number;
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
  getInitialRestore(): { readonly line: number; readonly lineOffset: number } | null;
  rememberViewport(line: number, lineOffset?: number): Promise<void>;
  revealSelection(selection: ViewSelection): Promise<void>;
  revealFragment(href: string): Promise<void>;
  ready(): Promise<void>;
  flush(): Promise<void>;
  dispose(): void;
};

/** Host Session port; the concrete editor source is interpreted only by its Adapter. */
export type HostViewNavigationPort<TEditorSource> = {
  getInitialRestore(): { readonly line: number; readonly lineOffset: number } | null;
  ready(): Promise<void>;
  flush(): Promise<void>;
  rememberViewport(line: number, lineOffset?: number): Promise<void>;
  revealSelectionForEditor(editor: TEditorSource | undefined): Promise<void>;
  revealCurrentEditorSelection(): Promise<void>;
  revealDocumentLink(href: string): Promise<boolean>;
  dispose(): void;
};

export type HostViewNavigationDependencies = {
  readonly readLineCount: () => number;
  readonly readMinimumRememberedLines: () => number;
  readonly initialSelection: ViewSelection | null;
  readonly initialFragment: string | null;
  readonly persistence: {
    read(): RememberedViewport | null;
    write(value: RememberedViewport | null): Promise<void>;
  };
  readonly output: {
    reveal(reveal: ViewNavigationReveal): Promise<boolean>;
  };
  readonly reportFailure: (context: string, error: unknown) => void;
  readonly now?: () => number;
};

const EOF_NEAR_THRESHOLD_LINES = 10;
const EOF_BACKOFF_LINES = 10;

const clampLine = (line: number, lineCount: number): number => {
  const numeric = Number.isFinite(line) ? Math.floor(line) : 1;
  return Math.max(1, Math.min(numeric, Math.max(1, Math.floor(lineCount))));
};

const normalizeOffset = (offset: number | undefined): number => {
  const numeric = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0;
  return Math.max(0, Math.round(numeric * 100) / 100);
};

const normalizeViewport = (
  line: number,
  lineOffset: number | undefined,
  lineCount: number
): { readonly line: number; readonly lineOffset: number; readonly adjustedForEof: boolean } => {
  const clampedLine = clampLine(line, lineCount);
  const normalizedOffset = normalizeOffset(lineOffset);
  const nearEndLine = Math.max(1, lineCount - EOF_NEAR_THRESHOLD_LINES + 1);
  if (clampedLine < nearEndLine) {
    return { line: clampedLine, lineOffset: normalizedOffset, adjustedForEof: false };
  }
  return {
    line: Math.max(1, clampedLine - EOF_BACKOFF_LINES),
    lineOffset: 0,
    adjustedForEof: true
  };
};

const selectionKey = (selection: ViewSelection): string => `${selection.anchor}:${selection.head}`;

/** Owns Host-side remembered viewport and reveal ordering; concrete editor and Protocol work stay in adapters. */
export function createHostViewNavigationLifecycle(
  dependencies: HostViewNavigationDependencies
): HostViewNavigationLifecycle {
  let pendingSelection = dependencies.initialSelection;
  let pendingFragment = dependencies.initialFragment;
  let lastSentSelectionKey: string | null = null;
  let deliveredInitialSelection = false;
  let lastRemembered: { readonly line: number; readonly lineOffset: number } | null = null;
  let ready = false;
  let disposed = false;
  let requestGeneration = 0;
  let flushRunning: Promise<void> | null = null;

  const persistInBackground = (value: RememberedViewport | null, context: string): void => {
    void dependencies.persistence.write(value).catch((error) => {
      if (!disposed) dependencies.reportFailure(context, error);
    });
  };

  const resolveInitialRestore = (): { readonly line: number; readonly lineOffset: number } | null => {
    const lineCount = dependencies.readLineCount();
    const remembered = dependencies.persistence.read();
    if (lineCount < dependencies.readMinimumRememberedLines()) {
      if (remembered) persistInBackground(null, 'clearRememberedViewport.initThreshold');
      return null;
    }
    if (pendingSelection) return null;
    if (!remembered) return null;
    const normalized = normalizeViewport(remembered.line, remembered.lineOffset, lineCount);
    lastRemembered = { line: normalized.line, lineOffset: normalized.lineOffset };
    if (normalized.adjustedForEof
      && (remembered.line !== normalized.line || normalizeOffset(remembered.lineOffset) !== normalized.lineOffset)) {
      persistInBackground({
        line: normalized.line,
        lineOffset: normalized.lineOffset,
        updatedAt: (dependencies.now ?? Date.now)()
      }, 'saveRememberedViewport.eofBackoff');
    }
    return { line: normalized.line, lineOffset: normalized.lineOffset };
  };

  const initialRestore = resolveInitialRestore();

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
    getInitialRestore: () => initialRestore,
    async rememberViewport(line, lineOffset) {
      if (disposed) return;
      const existing = dependencies.persistence.read();
      if (dependencies.readLineCount() < dependencies.readMinimumRememberedLines()) {
        if (!existing) return;
        await dependencies.persistence.write(null);
        if (!disposed) lastRemembered = null;
        return;
      }
      const normalized = normalizeViewport(line, lineOffset, dependencies.readLineCount());
      if (lastRemembered?.line === normalized.line && lastRemembered.lineOffset === normalized.lineOffset) return;
      if (existing?.line === normalized.line && normalizeOffset(existing.lineOffset) === normalized.lineOffset) {
        lastRemembered = { line: normalized.line, lineOffset: normalized.lineOffset };
        return;
      }
      await dependencies.persistence.write({
        line: normalized.line,
        lineOffset: normalized.lineOffset,
        updatedAt: (dependencies.now ?? Date.now)()
      });
      if (!disposed) lastRemembered = { line: normalized.line, lineOffset: normalized.lineOffset };
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
