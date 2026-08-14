import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createHostViewNavigationLifecycle,
  type HostViewNavigationLifecycle,
  type HostViewNavigationPort,
  type ViewSelection
} from '../application/hostViewNavigationLifecycle';
import type { HostEditorEvent } from '../protocol/hostEditorEvents';

type VscodeViewNavigationDependencies = {
  readonly document: vscode.TextDocument;
  readonly documentUri: vscode.Uri;
  readonly getDocumentFragmentHref: (href: string) => string | null;
  readonly resolveLocalLinkTarget: (href: string, documentUri: vscode.Uri) => Promise<vscode.Uri | null>;
  readonly post: (message: HostEditorEvent) => Promise<boolean>;
};

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

/** Adapts VS Code selection and Protocol output to Host view navigation. */
export function createVscodeViewNavigationAdapter(
  dependencies: VscodeViewNavigationDependencies
): HostViewNavigationPort<vscode.TextEditor> {
  const { document, documentUri } = dependencies;
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

  const lifecycle: HostViewNavigationLifecycle = createHostViewNavigationLifecycle({
    initialSelection,
    initialFragment,
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
    }
  });

  return {
    ready: lifecycle.ready,
    flush: lifecycle.flush,
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
