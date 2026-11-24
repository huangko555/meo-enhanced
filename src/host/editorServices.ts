import MarkdownIt from 'markdown-it';
import { markdownHeadingCandidates } from '../application/markdownHeadingCandidates';
import { blankMarkdownFrontmatter } from '../foundation/markdownFrontmatter';
import { candidateTextMatch } from '../foundation/candidateText';
import * as vscode from 'vscode';
import * as os from 'node:os';
import type { EditorServiceRequest, EditorServiceResponse, EditorServiceValue, LinkCandidate } from '../protocol/editorServices';
import { markdownPathTarget, resolveMarkdownReference } from './markdownPathTargets';
import { resolveWikiResource, wikiLinkCandidates, wikiPathDirectory } from './wikiResources';

async function pathCandidates(query: string, document: vscode.Uri, wiki: boolean): Promise<LinkCandidate[]> {
  const normalized = query.replaceAll('\\', '/'), slash = normalized.lastIndexOf('/');
  let parent = normalized.slice(0, slash + 1), name = normalized.slice(slash + 1);
  try { parent = decodeURIComponent(parent); } catch { /* Partial escapes stay literal. */ }
  try { name = decodeURIComponent(name); } catch { /* Partial escapes stay literal. */ }
  const directory = wiki ? await wikiPathDirectory(parent || '.', document) : markdownPathTarget(parent || '.', document);
  const ignored = new Set(['.git', 'node_modules', 'dist', '.cache', '.obsidian']);
  const rows = (await vscode.workspace.fs.readDirectory(directory)).flatMap(([filename, type]) => {
    if (filename.length > 1000 || ignored.has(filename) || wiki && /[\r\n|#]|\[\[|\]\]/.test(filename)) return [];
    const match = candidateTextMatch(filename, name);
    if (!match) return [];
    const folder = Boolean(type & vscode.FileType.Directory);
    return [{ filename, folder, rank: match.rank }];
  }).sort((a, b) => Number(b.folder) - Number(a.folder) || a.rank - b.rank || (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return rows.slice(0, 50).map(row => ({ label: row.filename + (row.folder ? '/' : ''), insert: row.filename + (row.folder ? '/' : ''),
    detail: vscode.workspace.asRelativePath(vscode.Uri.joinPath(directory, row.filename), false).slice(0, 1000), kind: row.folder ? 'directory' : 'file' }));
}

async function headingCandidates(target: string, query: string, document: vscode.Uri, wiki: boolean): Promise<LinkCandidate[]> {
  const uri = wiki ? (await resolveWikiResource(target, document)).uri : await resolveMarkdownReference(target, document);
  if (!uri) return [];
  const open = vscode.workspace.textDocuments?.find(document => document.uri.toString() === uri.toString());
  if (!open && (await vscode.workspace.fs.stat(uri)).size > 2_000_000) return [];
  const text = open?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  if (Buffer.byteLength(text) > 2_000_000) return [];
  const tokens = new MarkdownIt({ html: true }).parse(blankMarkdownFrontmatter(text), {});
  const headings = tokens.flatMap((token, index) => {
    if (token.type !== 'heading_open') return [];
    const inline = tokens[index + 1];
    const label = (inline.children ?? []).map(child => ['text', 'code_inline', 'image'].includes(child.type) ? child.content : ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : '').join('').replace(/\s+/g, ' ').trim();
    return [{ text: label, source: inline.content, line: (token.map?.[0] ?? 0) + 1 }];
  });
  return markdownHeadingCandidates(headings).filter(heading => heading.text.length <= 1000 && heading.anchor.length <= 1000 && candidateTextMatch(heading.text, query))
    .slice(0, 50).map(heading => ({ label: heading.text, insert: heading.anchor, anchor: heading.anchor, detail: vscode.workspace.asRelativePath(uri, false).slice(0, 1000) }));
}

export async function runEditorService(request: EditorServiceRequest, documentUri: vscode.Uri): Promise<EditorServiceResponse> {
  try {
    let value: EditorServiceValue;
    if (request.action === 'readClipboard') {
      const text = await vscode.env.clipboard.readText();
      if (text.length > 5_000_000) throw new Error('Clipboard text is too large');
      value = { text };
    } else if (request.action === 'writeClipboard') {
      await vscode.env.clipboard.writeText(request.text); value = { text: '' };
    } else if (request.action === 'environment') {
      value = { environment: { appName: vscode.env.appName, appVersion: vscode.version,
        system: process.platform === 'win32' ? `${os.version()} (${os.release()})` : `${os.type()} ${os.release()}`,
        architecture: os.arch(), remoteName: vscode.env.remoteName ?? '' } };
    } else {
      const lookup = request.kind === 'documents' ? wikiLinkCandidates(request.query, documentUri)
        : request.kind === 'paths' ? pathCandidates(request.query, documentUri, request.wiki === true)
        : headingCandidates(request.target, request.query, documentUri, request.wiki === true);
      let timer: ReturnType<typeof setTimeout>;
      try {
        value = { candidates: await Promise.race([lookup, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Link lookup timed out')), 4000); })]) };
      } finally { clearTimeout(timer!); }
    }
    return { type: 'editorServiceResult', requestId: request.requestId, result: { ok: true, value } };
  } catch (error) {
    return { type: 'editorServiceResult', requestId: request.requestId, result: { ok: false, error: { code: 'operation-failed', message: error instanceof Error ? error.message : 'Editor operation failed' } } };
  }
}
