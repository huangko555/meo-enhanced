import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { parser as markdownParser } from '@lezer/markdown';
import * as vscode from 'vscode';
import { safeDecodeURIComponent } from '../agents/resourceMatching';
import { withMarkdownExtensions } from './extensionConfig';

const WIKI_LINK_SCHEME = 'meo-wiki:';
const ALLOWED_IMAGE_SRC_RE = /^(?:https?:|data:|blob:|vscode-webview:|vscode-webview-resource:|vscode-resource:)/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const HOSTNAME_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:[\\/]/i;

export async function openExternalLink(rawHref: string): Promise<void> {
  try {
    const href = normalizeExternalHref(rawHref);
    if (!href) {
      return;
    }
    const uri = vscode.Uri.parse(href, true);
    await vscode.env.openExternal(uri);
  } catch {
    // Ignore invalid URIs emitted by the webview.
  }
}

export async function openImageExternally(rawUrl: string, documentUri: vscode.Uri): Promise<void> {
  const localImageUri = await resolveLocalLinkTargetUri(rawUrl, documentUri);
  if (localImageUri) {
    await openLocalImageWithSystemApp(localImageUri);
    return;
  }
  if (looksLikeLocalHref(rawUrl)) {
    console.warn('[meo] Local image target not found', { url: rawUrl });
    return;
  }
  await openExternalLink(rawUrl);
}

async function openLocalImageWithSystemApp(uri: vscode.Uri): Promise<void> {
  if (process.platform !== 'win32' || uri.scheme !== 'file') {
    await vscode.env.openExternal(uri);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn('explorer.exe', [uri.fsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function openLink(rawHref: string, documentUri: vscode.Uri): Promise<void> {
  if (await openWikiLink(rawHref, documentUri)) {
    return;
  }
  if (await openLocalLink(rawHref, documentUri)) {
    return;
  }
  if (looksLikeLocalHref(rawHref)) {
    console.warn('[meo] Local link target not found', {
      href: rawHref,
      documentUri: documentUri.toString(),
      documentScheme: documentUri.scheme,
      documentFsPath: documentUri.fsPath
    });
    return;
  }
  await openExternalLink(rawHref);
}

export async function openLocalLink(rawHref: string, documentUri: vscode.Uri): Promise<boolean> {
  const targetUri = await resolveLocalLinkTargetUri(rawHref, documentUri);
  if (!targetUri) {
    return false;
  }

  await vscode.commands.executeCommand('vscode.open', targetUri, {
    preview: false
  });
  return true;
}

export async function openWikiLink(rawHref: string, documentUri: vscode.Uri): Promise<boolean> {
  if (!rawHref.toLowerCase().startsWith(WIKI_LINK_SCHEME)) {
    return false;
  }

  const decoded = safeDecodeURIComponent(rawHref.slice(WIKI_LINK_SCHEME.length)).trim();
  if (!decoded) {
    return true;
  }

  const target = decoded.split('#', 1)[0]?.trim() ?? '';
  if (!target) {
    return true;
  }

  const targetUri = await resolveWikiLinkTargetUri(target, documentUri);
  if (!targetUri) {
    return true;
  }

  const targetDoc = await vscode.workspace.openTextDocument(targetUri);
  await vscode.window.showTextDocument(targetDoc, { preview: false });
  return true;
}

export async function resolveWikiLinkTargets(
  targets: string[],
  documentUri: vscode.Uri
): Promise<Array<{ target: string; exists: boolean }>> {
  const uniqueTargets = Array.from(new Set(targets
    .map((target) => normalizeWikiTarget(target))
    .filter((target) => target.length > 0)));

  const resolved = await Promise.all(uniqueTargets.map(async (target) => {
    const targetUri = await resolveWikiLinkTargetUri(target, documentUri);
    return { target, exists: Boolean(targetUri) };
  }));

  return resolved;
}

export async function resolveLocalLinkTargets(
  targets: string[],
  documentUri: vscode.Uri
): Promise<Array<{ target: string; exists: boolean }>> {
  const uniqueTargets = Array.from(new Set(targets
    .map((target) => `${target ?? ''}`.trim())
    .filter((target) => target.length > 0)));

  const resolved = await Promise.all(uniqueTargets.map(async (target) => {
    const targetUri = await resolveLocalLinkTargetUri(target, documentUri);
    return { target, exists: Boolean(targetUri) };
  }));

  return resolved;
}

export function normalizeWikiTarget(target: string): string {
  const normalized = target.split('#', 1)[0]?.trim() ?? '';
  if (!normalized || SCHEME_RE.test(normalized)) {
    return '';
  }
  return normalized;
}

export async function resolveWikiLinkTargetUri(target: string, documentUri: vscode.Uri): Promise<vscode.Uri | null> {
  const normalized = target.replace(/\\/g, path.sep);
  const basePath = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(path.dirname(documentUri.fsPath), normalized);
  const ext = path.extname(normalized);
  const candidates = ext ? [basePath] : withMarkdownExtensions(basePath);
  const resolvedFromDocumentDir = await findFirstExistingUri(candidates.map((candidate) => toDocumentScopedUri(candidate, documentUri)));
  if (resolvedFromDocumentDir) {
    return resolvedFromDocumentDir;
  }

  if (path.isAbsolute(normalized)) {
    return null;
  }

  const workspaceRoot = vscode.workspace.getWorkspaceFolder(documentUri)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceRoot?.fsPath) {
    return null;
  }

  const workspaceBasePath = path.resolve(workspaceRoot.fsPath, normalized);
  const workspaceCandidates = ext ? [workspaceBasePath] : withMarkdownExtensions(workspaceBasePath);
  return findFirstExistingUri(workspaceCandidates.map((candidate) => toDocumentScopedUri(candidate, workspaceRoot)));
}

export async function resolveLocalLinkTargetUri(rawHref: string, documentUri: vscode.Uri): Promise<vscode.Uri | null> {
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  if (/^\/\//.test(trimmed)) {
    return null;
  }

  const [targetPath = ''] = trimmed.split(/[?#]/, 1);
  if (!targetPath) {
    return null;
  }

  if (/^file:/i.test(targetPath)) {
    try {
      const fileUri = vscode.Uri.parse(targetPath, true);
      return (await uriExists(fileUri)) ? fileUri : null;
    } catch {
      return null;
    }
  }

  const decodedPath = safeDecodeURIComponent(targetPath).replace(/\\/g, path.sep);
  if (SCHEME_RE.test(targetPath) && !WINDOWS_ABSOLUTE_PATH_RE.test(decodedPath)) {
    return null;
  }

  const basePath = path.isAbsolute(decodedPath)
    ? decodedPath
    : path.resolve(path.dirname(documentUri.fsPath), decodedPath);
  const ext = path.extname(decodedPath);
  const candidates = ext ? [basePath] : withMarkdownExtensions(basePath, true);
  const resolvedFromDocumentDir = await findFirstExistingUri(candidates.map((candidate) => toDocumentScopedUri(candidate, documentUri)));
  if (resolvedFromDocumentDir) {
    return resolvedFromDocumentDir;
  }

  if (path.isAbsolute(decodedPath)) {
    return null;
  }

  const workspaceRoot = vscode.workspace.getWorkspaceFolder(documentUri)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceRoot?.fsPath) {
    return null;
  }

  const workspaceBasePath = path.resolve(workspaceRoot.fsPath, decodedPath);
  const workspaceCandidates = ext ? [workspaceBasePath] : withMarkdownExtensions(workspaceBasePath, true);
  return findFirstExistingUri(workspaceCandidates.map((candidate) => toDocumentScopedUri(candidate, workspaceRoot)));
}

export async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function resolveWebviewImageSrc(
  rawUrl: string,
  documentUri: vscode.Uri,
  webview: vscode.Webview
): Promise<string> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return '';
  }
  if (/^\/\//.test(trimmed)) {
    return `https:${trimmed}`;
  }

  if (ALLOWED_IMAGE_SRC_RE.test(trimmed)) {
    return trimmed;
  }

  if (SCHEME_RE.test(trimmed) && !/^file:/i.test(trimmed) && !WINDOWS_ABSOLUTE_PATH_RE.test(trimmed)) {
    return trimmed;
  }

  const imageUri = resolveLocalImageUri(trimmed, documentUri);

  if (!imageUri || !(await uriExists(imageUri))) {
    return '';
  }

  const roots = webview.options.localResourceRoots ?? [];
  if (roots.some((root) => uriContainsResource(root, imageUri))) {
    return webview.asWebviewUri(imageUri).toString();
  }

  return readImageAsDataUri(imageUri);
}

export function collectWebviewImageResourceRoots(documentText: string, documentUri: vscode.Uri): vscode.Uri[] {
  const roots = new Map<string, vscode.Uri>();
  markdownParser.parse(documentText).iterate({
    enter(node) {
      if (node.name !== 'Image') {
        return;
      }
      const urlNode = node.node.getChild('URL');
      if (!urlNode) {
        return false;
      }
      const imageUri = resolveLocalImageUri(documentText.slice(urlNode.from, urlNode.to), documentUri);
      if (imageUri) {
        const resourceRoot = imageUri.scheme === 'file'
          ? vscode.Uri.file(path.dirname(imageUri.fsPath))
          : imageUri.with({ path: path.posix.dirname(imageUri.path), query: '', fragment: '' });
        roots.set(resourceRoot.toString(), resourceRoot);
      }
      return false;
    }
  });
  return Array.from(roots.values());
}

function resolveLocalImageUri(rawUrl: string, documentUri: vscode.Uri): vscode.Uri | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || /^\/\//.test(trimmed) || ALLOWED_IMAGE_SRC_RE.test(trimmed)) {
    return null;
  }
  if (SCHEME_RE.test(trimmed) && !/^file:/i.test(trimmed) && !WINDOWS_ABSOLUTE_PATH_RE.test(trimmed)) {
    return null;
  }

  const [pathPart = ''] = trimmed.split(/[?#]/, 1);
  if (/^file:/i.test(trimmed)) {
    try {
      return vscode.Uri.parse(pathPart, true);
    } catch {
      return null;
    }
  }

  const decodedPath = safeDecodeURIComponent(pathPart).replace(/\\/g, path.sep);
  const filePath = path.isAbsolute(decodedPath)
    ? decodedPath
    : path.resolve(path.dirname(documentUri.fsPath), decodedPath);
  return toDocumentScopedUri(filePath, documentUri);
}

async function readImageAsDataUri(imageUri: vscode.Uri): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(imageUri);
    const mediaType = getImageMediaType(imageUri.path);
    return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return '';
  }
}

function getImageMediaType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg':
    case '.jfif': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.bmp': return 'image/bmp';
    case '.ico': return 'image/x-icon';
    case '.avif': return 'image/avif';
    case '.apng': return 'image/apng';
    case '.tif':
    case '.tiff': return 'image/tiff';
    default: return 'application/octet-stream';
  }
}

function uriContainsResource(root: vscode.Uri, resource: vscode.Uri): boolean {
  if (root.scheme !== resource.scheme || root.authority !== resource.authority) {
    return false;
  }
  const relative = path.relative(root.fsPath, resource.fsPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function normalizeExternalHref(rawHref: string): string {
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return '';
  }
  if (/^\/\//.test(trimmed)) {
    return `https:${trimmed}`;
  }
  if (SCHEME_RE.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function toDocumentScopedUri(candidatePath: string, baseUri: vscode.Uri): vscode.Uri {
  if (baseUri.scheme === 'file') {
    return vscode.Uri.file(candidatePath);
  }
  return baseUri.with({
    path: candidatePath,
    query: '',
    fragment: ''
  });
}

function looksLikeLocalHref(rawHref: string): boolean {
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return false;
  }
  if (/^\/\//.test(trimmed)) {
    return false;
  }
  if (/^file:/i.test(trimmed)) {
    return true;
  }
  const [targetPath = ''] = trimmed.split(/[?#]/, 1);
  if (!targetPath) {
    return false;
  }
  const decodedTargetPath = safeDecodeURIComponent(targetPath);
  if (SCHEME_RE.test(targetPath) && !WINDOWS_ABSOLUTE_PATH_RE.test(decodedTargetPath)) {
    return false;
  }

  const normalized = decodedTargetPath.trim().replace(/\\/g, '/');
  if (!normalized) {
    return false;
  }
  if (
    normalized.startsWith('./') ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized.startsWith('~')
  ) {
    return true;
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return true;
  }
  if (normalized.toLowerCase().startsWith('www.')) {
    return false;
  }

  const firstSegment = normalized.split('/', 1)[0] ?? '';
  const hostPart = firstSegment.includes(':') ? firstSegment.split(':', 1)[0] : firstSegment;
  if (hostPart === 'localhost') {
    return false;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostPart)) {
    return false;
  }
  if (HOSTNAME_RE.test(hostPart)) {
    return false;
  }

  return true;
}

async function findFirstExistingUri(candidateUris: readonly vscode.Uri[]): Promise<vscode.Uri | null> {
  for (const uri of candidateUris) {
    if (await uriExists(uri)) {
      return uri;
    }
  }

  return null;
}
