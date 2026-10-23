import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { parser as markdownParser } from '@lezer/markdown';
import * as vscode from 'vscode';
import { safeDecodeURIComponent } from '../agents/resourceMatching';
import { WIKI_IMAGE_SCHEME, WIKI_LINK_SCHEME, wikiTargetFromImageSrc } from '../foundation/wikiReference';
import { resolveWikiResource } from '../host/wikiResources';
import { canResolveImageFromRoot, getImagePathCandidates } from './imagePaths';
import { normalizeLinkDestination, isLikelyLocalLinkDestination } from '../foundation/linkDestination';
import { markdownPathTarget, resolveMarkdownReference } from '../host/markdownPathTargets';
import { isMarkdownDocumentPath, MARKDOWN_EDITOR_VIEW_TYPE } from './extensionConfig';

const ALLOWED_IMAGE_SRC_RE = /^(?:https?:|data:|blob:|vscode-webview:|vscode-webview-resource:|vscode-resource:)/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:[\\/]/i;
// Preview's Markdown renderer URI-encodes backslashes before requesting an
// image. Classify that drive path before interpreting the colon as a scheme;
// resolveLocalImageUri still decodes the filesystem path exactly once.
const WINDOWS_IMAGE_PATH_RE = /^[a-z]:(?:[\\/]|%5c|%2f)/i;

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
  const wikiTarget = wikiTargetFromImageSrc(rawUrl);
  const localImageUri = wikiTarget === null ? await resolveLocalImageTargetUri(rawUrl, documentUri)
    : (await resolveWikiResource(wikiTarget, documentUri)).uri;
  if (localImageUri) {
    await openLocalImageWithSystemApp(localImageUri);
    return;
  }
  if (wikiTarget !== null) return;
  if (isLikelyLocalLinkDestination(rawUrl)) {
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

export async function openLink(
  rawHref: string,
  documentUri: vscode.Uri
): Promise<void> {
  rawHref = normalizeLinkDestination(rawHref);
  if (await openWikiLink(rawHref, documentUri)) {
    return;
  }
  if (await openLocalLink(rawHref, documentUri)) {
    return;
  }
  if (isLikelyLocalLinkDestination(rawHref)) {
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

export async function openLocalLink(
  rawHref: string,
  documentUri: vscode.Uri
): Promise<boolean> {
  const targetUri = await resolveLocalLinkTargetUri(rawHref, documentUri);
  if (!targetUri) {
    return false;
  }

  const fragmentHref = getDocumentFragmentHref(rawHref);
  const navigationUri = fragmentHref
    ? targetUri.with({ fragment: safeDecodeURIComponent(fragmentHref.slice(1)) })
    : targetUri;

  await openDocumentLinkTarget(navigationUri);
  return true;
}

async function openDocumentLinkTarget(targetUri: vscode.Uri): Promise<void> {
  // Navigation inside MEO retains its editor even when the workspace associates
  // Markdown with another editor. Classify after resolution and extension fallback.
  if (isMarkdownDocumentPath(targetUri.path.toLowerCase())) {
    await vscode.commands.executeCommand('vscode.openWith', targetUri, MARKDOWN_EDITOR_VIEW_TYPE, {
      preview: false
    });
  } else {
    await vscode.commands.executeCommand('vscode.open', targetUri, {
      preview: false
    });
  }
}

export function getDocumentFragmentHref(rawHref: string): string {
  const hashIndex = rawHref.indexOf('#');
  if (hashIndex < 0 || hashIndex === rawHref.length - 1) {
    return '';
  }
  return rawHref.slice(hashIndex).trim();
}

export async function openWikiLink(rawHref: string, documentUri: vscode.Uri): Promise<boolean> {
  const scheme = rawHref.startsWith(WIKI_IMAGE_SCHEME) ? WIKI_IMAGE_SCHEME : WIKI_LINK_SCHEME;
  if (!rawHref.toLowerCase().startsWith(scheme)) {
    return false;
  }

  const decoded = safeDecodeURIComponent(rawHref.slice(scheme.length)).trim();
  if (!decoded) {
    return true;
  }

  const result = await resolveWikiResource(decoded, documentUri);
  const targetUri = result.uri;
  if (!targetUri) {
    if (result.issue) void vscode.window.showWarningMessage(result.issue);
    return true;
  }

  await openDocumentLinkTarget(targetUri);
  return true;
}

export async function resolveWikiLinkTargets(
  targets: string[],
  documentUri: vscode.Uri
): Promise<Array<{ target: string; exists: boolean; issue?: string }>> {
  const uniqueTargets = Array.from(new Set(targets
    .map((target) => normalizeWikiTarget(target))
    .filter((target) => target.length > 0)));

  const resolved = await Promise.all(uniqueTargets.map(async (target) => {
    const result = await resolveWikiResource(target, documentUri);
    return { target, exists: Boolean(result.uri), ...(result.issue ? { issue: result.issue } : {}) };
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
  if (!normalized || (SCHEME_RE.test(normalized) && !WINDOWS_ABSOLUTE_PATH_RE.test(normalized))) {
    return '';
  }
  return normalized;
}

export async function resolveWikiLinkTargetUri(target: string, documentUri: vscode.Uri): Promise<vscode.Uri | null> {
  return (await resolveWikiResource(target, documentUri)).uri ?? null;
}

export async function resolveLocalLinkTargetUri(rawHref: string, documentUri: vscode.Uri): Promise<vscode.Uri | null> {
  return resolveMarkdownReference(rawHref, documentUri);
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
  webview: vscode.Webview,
  options: { delivery?: 'embedded'; imageSearchRoots?: readonly string[] } = {}
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

  const wikiTarget = wikiTargetFromImageSrc(trimmed);
  if (wikiTarget === null && SCHEME_RE.test(trimmed) && !/^file:/i.test(trimmed) && !WINDOWS_IMAGE_PATH_RE.test(trimmed)) {
    return trimmed;
  }

  const wikiResult = wikiTarget === null ? null : await resolveWikiResource(wikiTarget, documentUri);
  if (wikiResult?.issue) throw new Error(wikiResult.issue);
  const imageUri = wikiResult ? wikiResult.uri : await resolveLocalImageTargetUri(trimmed, documentUri, options.imageSearchRoots);

  if (!imageUri) {
    return '';
  }

  if (options.delivery === 'embedded') {
    return readImageAsDataUri(imageUri);
  }

  const roots = webview.options.localResourceRoots ?? [];
  if (roots.some((root) => uriContainsResource(root, imageUri))) {
    return webview.asWebviewUri(imageUri).toString();
  }

  return readImageAsDataUri(imageUri);
}

export function collectWebviewImageResources(documentText: string, documentUri: vscode.Uri): {
  roots: vscode.Uri[];
  localImages: { src: string; filePath: string }[];
} {
  const roots = new Map<string, vscode.Uri>();
  const localImages: { src: string; filePath: string }[] = [];
  markdownParser.parse(documentText).iterate({
    enter(node) {
      if (node.name !== 'Image') {
        return;
      }
      const urlNode = node.node.getChild('URL');
      if (!urlNode) {
        return false;
      }
      const src = documentText.slice(urlNode.from, urlNode.to);
      const imageUri = resolveLocalImageUri(src, documentUri);
      if (imageUri) {
        if (imageUri.scheme === 'file') localImages.push({ src, filePath: imageUri.fsPath });
        const resourceRoot = imageUri.scheme === 'file'
          ? vscode.Uri.file(path.dirname(imageUri.fsPath))
          : imageUri.with({ path: path.posix.dirname(imageUri.path), query: '', fragment: '' });
        roots.set(resourceRoot.toString(), resourceRoot);
      }
      return false;
    }
  });
  return { roots: Array.from(roots.values()), localImages };
}

export function collectWebviewImageResourceRoots(documentText: string, documentUri: vscode.Uri): vscode.Uri[] {
  return collectWebviewImageResources(documentText, documentUri).roots;
}

function resolveLocalImageUri(rawUrl: string, documentUri: vscode.Uri): vscode.Uri | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || /^\/\//.test(trimmed) || ALLOWED_IMAGE_SRC_RE.test(trimmed)) {
    return null;
  }
  if (SCHEME_RE.test(trimmed) && !/^file:/i.test(trimmed) && !WINDOWS_IMAGE_PATH_RE.test(trimmed)) {
    return null;
  }

  const [pathPart = ''] = trimmed.split(/[?#]/, 1);
  if (!pathPart) return null;
  if (/^file:/i.test(trimmed)) {
    try {
      return vscode.Uri.parse(pathPart, true);
    } catch {
      return null;
    }
  }

  return markdownPathTarget(safeDecodeURIComponent(pathPart), documentUri);
}

/** A detected vault is authoritative; otherwise use only the document's owning workspace. */
export async function resolveImageSearchRoots(documentUri: vscode.Uri): Promise<string[]> {
  const paths = documentUri.scheme === 'file' ? path : path.posix;
  const documentPath = documentUri.scheme === 'file' ? documentUri.fsPath : documentUri.path;
  for (let directory = paths.dirname(documentPath); ; directory = paths.dirname(directory)) {
    try {
      const marker = toDocumentScopedUri(paths.join(directory, '.obsidian'), documentUri);
      const stat = await vscode.workspace.fs.stat(marker);
      if (stat.type & vscode.FileType.Directory) return [directory];
    } catch {
      // Missing markers are expected for ordinary Markdown documents.
    }
    if (paths.dirname(directory) === directory) break;
  }
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(documentUri)?.uri;
  return workspaceRoot ? [workspaceRoot.scheme === 'file' ? workspaceRoot.fsPath : workspaceRoot.path] : [];
}

export async function resolveLocalImageTargetUri(
  rawUrl: string,
  documentUri: vscode.Uri,
  imageSearchRoots?: readonly string[]
): Promise<vscode.Uri | null> {
  const local = resolveLocalImageUri(rawUrl, documentUri);
  if (!local) return null;
  if (await uriExists(local)) return local;
  const [pathPart = ''] = rawUrl.trim().split(/[?#]/, 1);
  if (/^file:/i.test(pathPart)) return null;
  const decodedPath = safeDecodeURIComponent(pathPart);
  const paths = documentUri.scheme === 'file' ? path : path.posix;
  if (!canResolveImageFromRoot(decodedPath, paths)) return null;
  const documentPath = documentUri.scheme === 'file' ? documentUri.fsPath : documentUri.path;
  const roots = imageSearchRoots ?? await resolveImageSearchRoots(documentUri);
  const candidates = getImagePathCandidates(decodedPath, documentPath, roots, paths);
  return findFirstExistingUri(candidates.slice(1).map(candidate => toDocumentScopedUri(candidate, documentUri)));
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

async function findFirstExistingUri(candidateUris: readonly vscode.Uri[]): Promise<vscode.Uri | null> {
  for (const uri of candidateUris) {
    if (await uriExists(uri)) {
      return uri;
    }
  }

  return null;
}
