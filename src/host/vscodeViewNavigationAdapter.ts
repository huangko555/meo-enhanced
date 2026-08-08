import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createHostViewNavigationLifecycle,
  type HostViewNavigationLifecycle,
  type RememberedViewport,
  type ViewSelection
} from '../application/hostViewNavigationLifecycle';
import type { HostEditorEvent } from '../protocol/hostEditorEvents';

const REMEMBERED_VIEW_POSITIONS_STATE_KEY = 'rememberedViewPositionsByDocument';
const MAX_REMEMBERED_VIEW_POSITIONS = 300;

export type VscodeViewNavigationAdapter = {
  getInitialRestore(): { readonly line: number; readonly lineOffset: number } | null;
  ready(): Promise<void>;
  flush(): Promise<void>;
  rememberViewport(line: number, lineOffset?: number): Promise<void>;
  revealSelectionForEditor(editor: vscode.TextEditor | undefined): Promise<void>;
  revealCurrentEditorSelection(): Promise<void>;
  revealDocumentLink(href: string): Promise<boolean>;
  dispose(): void;
};

type VscodeViewNavigationDependencies = {
  readonly document: vscode.TextDocument;
  readonly documentUri: vscode.Uri;
  readonly context: vscode.ExtensionContext;
  readonly readMinimumRememberedLines: () => number;
  readonly getDocumentFragmentHref: (href: string) => string | null;
  readonly resolveLocalLinkTarget: (href: string, documentUri: vscode.Uri) => Promise<vscode.Uri | null>;
  readonly post: (message: HostEditorEvent) => Promise<boolean>;
  readonly reportFailure: (context: string, error: unknown) => void;
};

const normalizeLineOffset = (value: number | undefined): number => {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.round(numeric * 100) / 100);
};

const readRememberedMap = (workspaceState: vscode.Memento): Record<string, RememberedViewport> => {
  const stored = workspaceState.get<unknown>(REMEMBERED_VIEW_POSITIONS_STATE_KEY);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const entries: Record<string, RememberedViewport> = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!key || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Partial<RememberedViewport>;
    const line = Number(record.line);
    const updatedAt = Number(record.updatedAt);
    if (!Number.isFinite(line) || !Number.isFinite(updatedAt)) continue;
    entries[key] = {
      line: Math.max(1, Math.floor(line)),
      lineOffset: normalizeLineOffset(Number(record.lineOffset)),
      updatedAt: Math.floor(updatedAt)
    };
  }
  return entries;
};

const pruneRememberedMap = (
  entries: Record<string, RememberedViewport>
): Record<string, RememberedViewport> => Object.fromEntries(
  Object.entries(entries)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_REMEMBERED_VIEW_POSITIONS)
);

const isSameResource = (left: vscode.Uri, right: vscode.Uri): boolean => {
  if (left.scheme === 'file' && right.scheme === 'file') {
    const leftPath = path.normalize(left.fsPath);
    const rightPath = path.normalize(right.fsPath);
    return process.platform === 'win32'
      ? leftPath.toLowerCase() === rightPath.toLowerCase()
      : leftPath === rightPath;
  }
  return left.with({ query: '', fragment: '' }).toString() === right.with({ query: '', fragment: '' }).toString();
};

const parseLineFragmentSelection = (document: vscode.TextDocument): ViewSelection | null => {
  const fragment = document.uri.fragment?.trim() ?? '';
  const match = /^(?:L)?(\d+)(?:(?:,|:|C)(\d+))?$/i.exec(fragment);
  if (!match) return null;
  const lineNumber = Number.parseInt(match[1], 10);
  if (!Number.isFinite(lineNumber) || lineNumber < 1) return null;
  const clampedLine = Math.min(lineNumber, document.lineCount);
  const line = document.lineAt(clampedLine - 1);
  const oneBasedColumn = match[2] ? Number.parseInt(match[2], 10) : 1;
  const zeroBasedColumn = Number.isFinite(oneBasedColumn) && oneBasedColumn > 0 ? oneBasedColumn - 1 : 0;
  const character = Math.min(line.range.end.character, Math.max(0, zeroBasedColumn));
  const offset = document.offsetAt(new vscode.Position(clampedLine - 1, character));
  return { anchor: offset, head: offset };
};

/** Adapts VS Code selection, workspace persistence and Protocol output to Host view navigation. */
export function createVscodeViewNavigationAdapter(
  dependencies: VscodeViewNavigationDependencies
): VscodeViewNavigationAdapter {
  const { document, documentUri, context } = dependencies;
  const documentKey = document.uri.toString();
  const isEditorForDocument = (editor: vscode.TextEditor | undefined): editor is vscode.TextEditor =>
    editor?.document.uri.toString() === documentKey;
  const findEditor = (): vscode.TextEditor | undefined => {
    if (isEditorForDocument(vscode.window.activeTextEditor)) return vscode.window.activeTextEditor;
    return vscode.window.visibleTextEditors.find(isEditorForDocument);
  };
  const readSelection = (editor: vscode.TextEditor): ViewSelection => ({
    anchor: editor.document.offsetAt(editor.selection.start),
    head: editor.document.offsetAt(editor.selection.end)
  });

  const initialEditor = findEditor();
  const initialSelection = initialEditor ? readSelection(initialEditor) : parseLineFragmentSelection(document);
  const rawInitialFragment = document.uri.fragment?.trim() ?? '';
  const initialFragment = initialSelection === null && rawInitialFragment ? `#${rawInitialFragment}` : null;

  const persistence = {
    read(): RememberedViewport | null {
      return readRememberedMap(context.workspaceState)[documentKey] ?? null;
    },
    async write(value: RememberedViewport | null): Promise<void> {
      const entries = readRememberedMap(context.workspaceState);
      if (value) entries[documentKey] = value;
      else delete entries[documentKey];
      await context.workspaceState.update(REMEMBERED_VIEW_POSITIONS_STATE_KEY, pruneRememberedMap(entries));
    }
  };

  const lifecycle: HostViewNavigationLifecycle = createHostViewNavigationLifecycle({
    readLineCount: () => document.lineCount,
    readMinimumRememberedLines: dependencies.readMinimumRememberedLines,
    initialSelection,
    initialFragment,
    persistence,
    output: {
      reveal: (reveal) => dependencies.post(reveal.kind === 'selection'
        ? {
            type: 'revealSelection',
            anchor: reveal.anchor,
            head: reveal.head,
            focus: reveal.focus,
            preserveViewport: reveal.preserveViewport
          }
        : { type: 'revealDocumentFragment', href: reveal.href })
    },
    reportFailure: dependencies.reportFailure
  });

  return {
    getInitialRestore: lifecycle.getInitialRestore,
    ready: lifecycle.ready,
    flush: lifecycle.flush,
    rememberViewport: lifecycle.rememberViewport,
    async revealSelectionForEditor(editor) {
      if (isEditorForDocument(editor)) await lifecycle.revealSelection(readSelection(editor));
    },
    async revealCurrentEditorSelection() {
      const editor = findEditor();
      if (editor) await lifecycle.revealSelection(readSelection(editor));
    },
    async revealDocumentLink(href) {
      const fragment = dependencies.getDocumentFragmentHref(href);
      if (!fragment) return false;
      const target = await dependencies.resolveLocalLinkTarget(href, documentUri);
      if (!target || !isSameResource(target, documentUri)) return false;
      await lifecycle.revealFragment(fragment);
      return true;
    },
    dispose: lifecycle.dispose
  };
}
