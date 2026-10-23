import * as vscode from 'vscode';
import { posix } from 'node:path';
import { markdownFileExtensions } from '../foundation/markdownFileExtensions';
import { normalizeLinkDestination } from '../foundation/linkDestination';

/** A leading slash belongs to the document's workspace, including remote providers. */
export function markdownPathTarget(decodedPath: string, document: vscode.Uri): vscode.Uri {
  const normalized = decodedPath.replaceAll('\\', '/');
  if (/^[a-z]:\//i.test(normalized)) return document.scheme === 'file' ? vscode.Uri.file(normalized)
    : document.with({ path: '/' + normalized, query: '', fragment: '' });
  const root = normalized.startsWith('/') ? vscode.workspace.getWorkspaceFolder(document)?.uri : undefined;
  const basePath = root?.path ?? posix.dirname(document.path);
  return (root ?? document).with({ path: posix.resolve(basePath, normalized.startsWith('/') ? normalized.slice(1) : normalized), query: '', fragment: '' });
}

/** Ordered candidates are shared by navigation, heading lookup and resource watching. */
export function markdownReferenceCandidates(rawHref: string, document: vscode.Uri): vscode.Uri[] {
  const href = normalizeLinkDestination(rawHref);
  if (!href || href.startsWith('#') || href.startsWith('//')) return [];
  const rawPath = href.split(/[?#]/, 1)[0];
  if (/^file:/i.test(rawPath)) {
    try { return [vscode.Uri.parse(rawPath, true)]; } catch { return []; }
  }
  let decoded = rawPath;
  try { decoded = decodeURIComponent(rawPath); } catch { /* Keep partially encoded destinations literal. */ }
  decoded = decoded.replaceAll('\\', '/');
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath) && !/^[a-z]:\//i.test(decoded)) return [];
  const expand = (base: vscode.Uri) => {
    const paths = posix.extname(decoded) ? [base.path] : [base.path, ...markdownFileExtensions.map(extension => base.path + extension)];
    return paths.map(path => base.with({ path }));
  };
  const candidates = expand(markdownPathTarget(decoded, document));
  if (decoded.startsWith('/') || /^\.\.?\//.test(decoded) || /^[a-z]:\//i.test(decoded)) return candidates;
  const root = vscode.workspace.getWorkspaceFolder(document)?.uri;
  if (root) candidates.push(...expand(root.with({ path: posix.resolve(root.path, decoded), query: '', fragment: '' })));
  return [...new Map(candidates.map(uri => [uri.toString(), uri])).values()];
}

export async function resolveMarkdownReference(rawHref: string, document: vscode.Uri): Promise<vscode.Uri | null> {
  for (const uri of markdownReferenceCandidates(rawHref, document)) {
    try { await vscode.workspace.fs.stat(uri); return uri; } catch { /* Try the next candidate. */ }
  }
  return null;
}
