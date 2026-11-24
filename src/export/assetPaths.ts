import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WIKI_IMAGE_SCHEME } from '../foundation/wikiReference';
import { normalizeLinkDestination } from '../foundation/linkDestination';
import { getImagePathCandidates } from '../shared/imagePaths';

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const REMOTE_OR_INLINE_RE = /^(?:https?:|data:|blob:)/i;

type ExportImageTarget = 'html' | 'pdf' | 'docx';

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.css': 'text/css',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.vtt': 'text/vtt',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp'
};

export type RewriteExportImageSrcOptions = {
  markdownFilePath: string;
  target: ExportImageTarget;
  outputFilePath?: string;
  embeddedImageDataUrlCache?: Map<string, string | null>;
  imageSearchRoots?: readonly string[];
  workspaceRootPath?: string;
};

/** Standalone links must retain the workspace root outside the editor. */
export function rewriteExportLinkHref(rawHref: string, options: { markdownFilePath: string; workspaceRootPath?: string }): string {
  const href = normalizeLinkDestination(rawHref);
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const { pathPart, suffix } = splitPathAndSuffix(href);
  const filePath = resolveLocalLikePath(pathPart, options.markdownFilePath, [], options.workspaceRootPath);
  return filePath ? `${toFileUrlString(filePath)}${suffix}` : href;
}

export function isLocalImageSrc(rawSrc: string): boolean {
  const input = (rawSrc ?? '').trim();
  if (input.startsWith(WIKI_IMAGE_SCHEME)) return true;
  if (!input || REMOTE_OR_INLINE_RE.test(input) || /^\/\//.test(input)) {
    return false;
  }
  const { pathPart } = splitPathAndSuffix(input);
  return Boolean(pathPart) && (
    !SCHEME_RE.test(pathPart) || /^file:/i.test(pathPart) || hasWindowsDrivePrefix(pathPart)
  );
}

export function rewriteExportImageSrc(rawSrc: string, options: RewriteExportImageSrcOptions): string {
  const input = (rawSrc ?? '').trim();
  if (!input) {
    return '';
  }

  if (REMOTE_OR_INLINE_RE.test(input)) {
    return input;
  }

  // An exported file has no network scheme to inherit. Preview uses HTTPS too.
  if (input.startsWith('//')) {
    return `https:${input}`;
  }

  const { pathPart, suffix, hash } = splitPathAndSuffix(input);
  if (!pathPart) {
    return input;
  }

  if (SCHEME_RE.test(pathPart) && !/^file:/i.test(pathPart) && !hasWindowsDrivePrefix(pathPart)) {
    return input;
  }

  const filePath = resolveLocalLikePath(pathPart, options.markdownFilePath, options.imageSearchRoots, options.workspaceRootPath);
  if (!filePath) {
    return input;
  }

  if (options.target === 'pdf') {
    return `${toFileUrlString(filePath)}${suffix}`;
  }

  const embedded = toEmbeddedImageDataUrl(filePath, options.embeddedImageDataUrlCache);
  if (embedded) {
    // Preserve hash fragments (e.g. SVG fragment refs), but skip query args for data URLs.
    return `${embedded}${hash}`;
  }

  const outputDir = options.outputFilePath ? path.dirname(options.outputFilePath) : path.dirname(options.markdownFilePath);
  const relative = path.relative(outputDir, filePath);
  if (!relative || path.isAbsolute(relative) || hasWindowsDrivePrefix(relative)) {
    return `${toFileUrlString(filePath)}${suffix}`;
  }

  return `${toPosixPath(relative)}${suffix}`;
}

export function toFileUrlString(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

function resolveLocalLikePath(rawPath: string, markdownFilePath: string, imageSearchRoots: readonly string[] = [], workspaceRootPath?: string): string | null {
  if (/^file:/i.test(rawPath)) {
    try {
      return fileURLToPath(rawPath);
    } catch {
      return null;
    }
  }

  const decoded = safeDecodeURIComponent(rawPath).replace(/\\/g, path.sep);
  if (!decoded) {
    return null;
  }

  const candidates = getImagePathCandidates(decoded, markdownFilePath, imageSearchRoots, path, workspaceRootPath);
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
}

function splitPathAndSuffix(value: string): { pathPart: string; suffix: string; hash: string } {
  const queryIndex = value.indexOf('?');
  const hashIndex = value.indexOf('#');
  const hasQuery = queryIndex >= 0;
  const hasHash = hashIndex >= 0;
  const index = hasQuery && hasHash
    ? Math.min(queryIndex, hashIndex)
    : (hasQuery ? queryIndex : hashIndex);
  if (index < 0) {
    return { pathPart: value, suffix: '', hash: '' };
  }
  const hash = hasHash ? value.slice(hashIndex) : '';
  return {
    pathPart: value.slice(0, index),
    suffix: value.slice(index),
    hash
  };
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function hasWindowsDrivePrefix(value: string): boolean {
  return /^[a-z]:/i.test(value);
}

function toEmbeddedImageDataUrl(filePath: string, cache?: Map<string, string | null>): string | null {
  const cached = cache?.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  let embedded: string | null = null;
  try {
    const content = fs.readFileSync(filePath);
    const mimeType = exportAssetMimeType(filePath);
    embedded = `data:${mimeType};base64,${content.toString('base64')}`;
  } catch {
    embedded = null;
  }

  cache?.set(filePath, embedded);
  return embedded;
}

export function exportAssetMimeType(filePath: string): string {
  return IMAGE_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
