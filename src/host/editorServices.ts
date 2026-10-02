import MarkdownIt from 'markdown-it';
import { markdownHeadingCandidates } from '../application/markdownHeadingCandidates';
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { EditorServiceRequest, EditorServiceResponse, LinkCandidate } from '../protocol/editorServices';

const documentExtensions = /\.(?:md|markdown|mdx|mdc)$/i;
const safeGlobFragment = (value: string) => value.replace(/[\*?{}\[\]\\]/g, '?').slice(0, 200);
const relativePath = (folder: string, uri: vscode.Uri) => path.relative(folder, uri.fsPath).replaceAll('\\', '/');

export async function runEditorService(request: EditorServiceRequest, documentUri: vscode.Uri): Promise<EditorServiceResponse> {
  try {
    let value: { text: string } | { candidates: LinkCandidate[] };
    if (request.action === 'readClipboard') {
      const text = await vscode.env.clipboard.readText();
      if (text.length > 5_000_000) throw new Error('Clipboard text is too large');
      value = { text };
    } else if (request.action === 'writeClipboard') {
      await vscode.env.clipboard.writeText(request.text); value = { text: '' };
    } else {
      const candidates: LinkCandidate[] = [];
      const folder = path.dirname(documentUri.fsPath);
      const cancellation = new vscode.CancellationTokenSource();
      const timeout = setTimeout(() => cancellation.cancel(), 3000);
      try {
        let target = request.target;
        try { target = decodeURIComponent(target); } catch { /* A partially typed escape stays literal. */ }
        const wanted = target.replace(documentExtensions, '').replaceAll('\\', '/');
        const fragment = safeGlobFragment((request.kind === 'headings' ? wanted : request.query).split('/').at(-1) ?? '');
        const include = request.kind === 'paths' ? `**/*${fragment}*` : `**/*${fragment}*.{md,markdown,mdx,mdc}`;
        const uris = await vscode.workspace.findFiles(include, '**/{.git,node_modules,dist,.cache}/**', 2000, cancellation.token);
        if (cancellation.token.isCancellationRequested) throw new Error('Link lookup timed out');
        const query = request.query.toLocaleLowerCase();
        if (request.kind === 'headings') {
          // An exact relative target wins. A wiki basename is allowed only when unambiguous.
          const exact = uris.filter(uri => relativePath(folder, uri).replace(documentExtensions, '') === wanted);
          const basename = uris.filter(uri => path.basename(uri.fsPath).replace(documentExtensions, '') === wanted);
          const uri = exact.length === 1 ? exact[0] : !exact.length && basename.length === 1 ? basename[0] : null;
          if (uri) {
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (cancellation.token.isCancellationRequested) throw new Error('Link lookup timed out');
            if (bytes.byteLength <= 2_000_000) {
              const tokens = new MarkdownIt({ html: true }).parse(Buffer.from(bytes).toString('utf8'), {});
              const headings = tokens.flatMap((token, index) => {
                if (token.type !== 'heading_open') return [];
                const inline = tokens[index + 1];
                const label = (inline.children ?? []).map(child => ['text', 'code_inline', 'image'].includes(child.type) ? child.content : ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : '').join('').replace(/\s+/g, ' ').trim();
                return [{ text: label, source: inline.content, line: (token.map?.[0] ?? 0) + 1 }];
              });
              for (const heading of markdownHeadingCandidates(headings)) {
                if (heading.text.length <= 1000 && heading.anchor.length <= 1000 && heading.text.toLocaleLowerCase().includes(query)) candidates.push({ label: heading.text, insert: heading.text, anchor: heading.anchor, detail: relativePath(folder, uri).slice(0, 1000) });
                if (candidates.length === 50) break;
              }
            }
          }
        } else {
          for (const uri of uris) {
            const relative = relativePath(folder, uri);
            if (relative.length > 1000 || !relative.toLocaleLowerCase().includes(query)) continue;
            candidates.push({ label: path.basename(relative), insert: relative, detail: vscode.workspace.asRelativePath(uri, true).slice(0, 1000) });
            if (candidates.length === 50) break;
          }
        }
      } finally { clearTimeout(timeout); cancellation.dispose(); }
      value = { candidates };
    }
    return { type: 'editorServiceResult', requestId: request.requestId, result: { ok: true, value } };
  } catch (error) {
    return { type: 'editorServiceResult', requestId: request.requestId, result: { ok: false, error: { code: 'operation-failed', message: error instanceof Error ? error.message : 'Editor operation failed' } } };
  }
}
