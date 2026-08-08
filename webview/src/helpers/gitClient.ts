import type { GitBaselineChangedEvent, GitBlameLineResult, GitBlameResponse } from '../../../src/protocol/git';
import { createGitBlameTransport } from '../adapters/gitBlameTransport';

interface GitClientOptions {
  vscode: any;
  getCurrentEditorText?: () => string | undefined;
  clearTransientUi?: () => void;
  maxBlameSnapshotChars?: number;
  blameTimeoutMs?: number;
}

interface GitClient {
  clearBlameCache: (options?: { hideTooltip?: boolean }) => void;
  bumpLocalEditGeneration: () => void;
  resetForInit: (options?: { hideTooltip?: boolean }) => void;
  requestBlameForLine: (options: { lineNumber: number }) => Promise<GitBlameLineResult>;
  openRevisionForLine: (options: { lineNumber: number }) => void;
  openWorktreeForLine: (options: { lineNumber: number }) => void;
  applyBaselineToEditor: (editor: any) => void;
  handleMessage: (message: any, options?: { editor?: any }) => boolean;
}

const defaultMaxBlameSnapshotChars = 500 * 1024;
const defaultBlameTimeoutMs = 8000;

const normalizeLineNumber = (lineNumber: number): number => (
  Number.isFinite(lineNumber) ? Math.max(1, Math.floor(lineNumber)) : 1
);

function shouldIncludeBlameSnapshotText(currentText: string | undefined, maxChars: number): boolean {
  if (typeof currentText !== 'string') {
    return false;
  }
  return currentText.length > 0 && currentText.length <= maxChars;
}

export function createGitClient({
  vscode,
  getCurrentEditorText,
  clearTransientUi,
  maxBlameSnapshotChars = defaultMaxBlameSnapshotChars,
  blameTimeoutMs = defaultBlameTimeoutMs
}: GitClientOptions): GitClient {
  let gitBaselineSnapshot: any = null;
  let pendingGitBaselineBeforeEditorMount: any = null;
  let baselineGeneration = -1;
  let localEditGeneration = 0;
  const gitBlameCache = new Map<string, GitBlameLineResult>();
  const inFlightGitBlameRequests = new Map<string, Promise<GitBlameLineResult>>();
  const gitBlameTransport = createGitBlameTransport(
    (message) => vscode.postMessage(message),
    { timeoutMs: blameTimeoutMs }
  );

  const clearBlameCache = ({ hideTooltip = true }: { hideTooltip?: boolean } = {}) => {
    gitBlameCache.clear();
    inFlightGitBlameRequests.clear();
    gitBlameTransport.cancelAll();
    if (hideTooltip) {
      clearTransientUi?.();
    }
  };

  const bumpLocalEditGeneration = () => {
    localEditGeneration += 1;
    clearBlameCache();
  };

  const resetForInit = ({ hideTooltip = false }: { hideTooltip?: boolean } = {}) => {
    localEditGeneration = 0;
    clearBlameCache({ hideTooltip });
  };

  const requestBlameForLine = ({ lineNumber }: { lineNumber: number }): Promise<GitBlameLineResult> => {
    const normalizedLine = normalizeLineNumber(lineNumber);
    const cacheKey = `${localEditGeneration}:${normalizedLine}`;
    const cached = gitBlameCache.get(cacheKey);
    if (cached) {
      return Promise.resolve(cached);
    }
    const inFlight = inFlightGitBlameRequests.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const currentText = getCurrentEditorText?.();
    const request: { lineNumber: number; localEditGeneration: number; text?: string } = {
      lineNumber: normalizedLine,
      localEditGeneration
    };

    if (shouldIncludeBlameSnapshotText(currentText, maxBlameSnapshotChars)) {
      request.text = currentText;
    }

    const requestPromise = gitBlameTransport.request(request).then((resolution): GitBlameLineResult => {
      if (resolution.ok === false) return { kind: 'unavailable', reason: 'error' };
      gitBlameCache.set(cacheKey, resolution.value);
      return resolution.value;
    }).finally(() => {
      if (inFlightGitBlameRequests.get(cacheKey) === requestPromise) {
        inFlightGitBlameRequests.delete(cacheKey);
      }
    });

    inFlightGitBlameRequests.set(cacheKey, requestPromise);
    return requestPromise;
  };

  const openRevisionForLine = ({ lineNumber }: { lineNumber: number }) => {
    const normalizedLine = normalizeLineNumber(lineNumber);
    const currentText = getCurrentEditorText?.();
    const message: any = {
      type: 'openGitRevisionForLine',
      lineNumber: normalizedLine
    };
    if (shouldIncludeBlameSnapshotText(currentText, maxBlameSnapshotChars)) {
      message.text = currentText;
    }
    vscode.postMessage(message);
  };

  const openWorktreeForLine = ({ lineNumber }: { lineNumber: number }) => {
    const normalizedLine = normalizeLineNumber(lineNumber);
    const currentText = getCurrentEditorText?.();
    const message: any = {
      type: 'openGitWorktreeForLine',
      lineNumber: normalizedLine
    };
    if (shouldIncludeBlameSnapshotText(currentText, maxBlameSnapshotChars)) {
      message.text = currentText;
    }
    vscode.postMessage(message);
  };

  const applyBaselineToEditor = (editor: any) => {
    if (!editor) {
      return;
    }
    if (pendingGitBaselineBeforeEditorMount) {
      editor.setGitBaseline(pendingGitBaselineBeforeEditorMount);
      pendingGitBaselineBeforeEditorMount = null;
      return;
    }
    if (gitBaselineSnapshot) {
      editor.setGitBaseline(gitBaselineSnapshot);
    }
  };

  const handleMessage = (
    message: GitBaselineChangedEvent | GitBlameResponse,
    { editor }: { editor?: any } = {}
  ): boolean => {
    if (message.type === 'gitBaselineChanged') {
      const incomingGeneration = Number.isFinite(message.payload?.generation)
        ? Number(message.payload.generation)
        : 0;
      if (incomingGeneration < baselineGeneration) {
        return true;
      }
      baselineGeneration = incomingGeneration;
      gitBaselineSnapshot = message.payload ?? null;
      if (editor) {
        editor.setGitBaseline(gitBaselineSnapshot);
      } else {
        pendingGitBaselineBeforeEditorMount = gitBaselineSnapshot;
      }
      return true;
    }

    if (message.type === 'gitBlameResult') {
      gitBlameTransport.accept(message);
      return true;
    }

    return false;
  };

  return {
    clearBlameCache,
    bumpLocalEditGeneration,
    resetForInit,
    requestBlameForLine,
    openRevisionForLine,
    openWorktreeForLine,
    applyBaselineToEditor,
    handleMessage
  };
}
