import { AlertCircle, createElement } from 'lucide';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import { createLocalLinkResolutionTransport, type LocalLinkResolutionTransport } from '../adapters/localLinkResolutionTransport';
import type { ResolvedLocalLinksResponse } from '../../../src/protocol/localLinkResolution';
import { normalizeLinkDestination, isLikelyLocalLinkDestination as isLikelyLocalLinkTarget } from '../../../src/foundation/linkDestination';
export { isLikelyLocalLinkTarget };

const localLinkStatusByTarget = new Map<string, boolean>();
let vscodeApi: any = null;
let localLinkTransport: LocalLinkResolutionTransport = {
  resolve: async () => ({ ok: false, error: { code: 'operation-failed', message: 'Local Link handling is not initialized' } }),
  accept: () => false
};
let localLinkGeneration = 0;
let pendingLocalLinkStatusRefresh: number | null = null;
const localLinkStatusDebounceMs = 1000;

export interface LocalLinkRefreshContext {
  refreshDecorations: () => void;
}

let refreshContext: LocalLinkRefreshContext | null = null;

export const initializeLocalLinkHandling = (vscode: any): void => {
  vscodeApi = vscode;
  localLinkTransport = createLocalLinkResolutionTransport((message) => {
    vscodeApi?.postMessage(message);
  });
};

export const setLocalLinkRefreshContext = (context: LocalLinkRefreshContext): void => {
  refreshContext = context;
};

export const scheduleLocalLinkStatusRefresh = (text: string): void => {
  if (pendingLocalLinkStatusRefresh !== null) {
    window.clearTimeout(pendingLocalLinkStatusRefresh);
  }
  pendingLocalLinkStatusRefresh = window.setTimeout(() => {
    pendingLocalLinkStatusRefresh = null;
    requestLocalLinkStatuses(text);
  }, localLinkStatusDebounceMs);
};

export const cancelPendingLocalLinkStatusRefresh = (): void => {
  if (pendingLocalLinkStatusRefresh !== null) {
    window.clearTimeout(pendingLocalLinkStatusRefresh);
    pendingLocalLinkStatusRefresh = null;
  }
};

export const requestLocalLinkStatuses = (text: string): void => {
  const generation = ++localLinkGeneration;
  const targets = collectLocalLinkTargets(text);
  if (!targets.length) {
    if (replaceLocalLinkStatuses([])) refreshContext?.refreshDecorations();
    return;
  }

  void localLinkTransport.resolve(targets).then((result) => {
    if (generation !== localLinkGeneration) return;
    if (replaceLocalLinkStatuses(result.ok === true ? result.value.results : [])) refreshContext?.refreshDecorations();
  });
};

export const invalidateLocalLinkStatuses = (text: string): void => {
  cancelPendingLocalLinkStatusRefresh();
  replaceLocalLinkStatuses([]);
  requestLocalLinkStatuses(text);
  refreshContext?.refreshDecorations();
};

export const handleResolvedLocalLinks = (message: ResolvedLocalLinksResponse): boolean => {
  return localLinkTransport.accept(message);
};

/** Returns whether the visible status cache changed, independent of result order. */
export function replaceLocalLinkStatuses(entries: Array<{ target: string; exists: boolean }>): boolean {
  const next = new Map<string, boolean>();
  for (const entry of entries) {
    if (!entry || typeof entry.target !== 'string') {
      continue;
    }
    const target = normalizeLocalLinkTarget(entry.target);
    if (!target) {
      continue;
    }
    next.set(target, entry.exists === true);
  }
  if (next.size === localLinkStatusByTarget.size
    && [...next].every(([target, exists]) => localLinkStatusByTarget.get(target) === exists)) return false;
  localLinkStatusByTarget.clear();
  for (const [target, exists] of next) localLinkStatusByTarget.set(target, exists);
  return true;
}

export function getLocalLinkStatus(target: string | null | undefined): boolean | null {
  const normalized = normalizeLocalLinkTarget(target ?? '');
  if (!normalized || !localLinkStatusByTarget.has(normalized)) {
    return null;
  }
  return localLinkStatusByTarget.get(normalized) === true;
}

export function isMissingLocalLinkTarget(target: string | null | undefined): boolean {
  const normalized = normalizeLocalLinkTarget(target ?? '');
  return Boolean(
    normalized &&
    isLikelyLocalLinkTarget(normalized) &&
    getLocalLinkStatus(normalized) === false
  );
}

export function createMissingLocalLinkIndicator(language: UiLanguage = 'en'): HTMLElement {
  const strings = getUiStrings(language);
  const badge = document.createElement('span');
  badge.className = 'meo-md-local-link-missing-icon';
  badge.dataset.tooltip = strings.missingLocalLink;
  badge.setAttribute('aria-label', strings.missingLocalLink);
  badge.appendChild(createElement(AlertCircle, { 'aria-hidden': 'true' }));
  return badge;
}

export function normalizeLocalLinkTarget(rawTarget: string): string {
  return normalizeLinkDestination(`${rawTarget ?? ''}`);
}

export const collectLocalLinkTargets = (text: string): string[] => {
  const targets = new Set<string>();

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '[' || isEscapedAt(text, i)) {
      continue;
    }
    if (i > 0 && text[i - 1] === '!') {
      continue;
    }

    const closeBracket = findClosingBracket(text, i + 1);
    if (closeBracket < 0) {
      continue;
    }

    let cursor = closeBracket + 1;
    while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) {
      cursor += 1;
    }
    if (text[cursor] !== '(') {
      continue;
    }

    const destination = consumeLinkDestination(text, cursor + 1);
    if (destination.nextIndex < 0) {
      continue;
    }
    const normalized = normalizeLocalLinkTarget(destination.target);
    if (normalized && isLikelyLocalLinkTarget(normalized)) {
      targets.add(normalized);
    }
    i = destination.nextIndex;
  }

  return Array.from(targets);
};

function isEscapedAt(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    slashCount += 1;
  }
  return (slashCount % 2) === 1;
}

function findClosingBracket(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === ']' && !isEscapedAt(text, i)) {
      return i;
    }
  }
  return -1;
}

function consumeLinkDestination(text: string, from: number): { target: string; nextIndex: number } {
  let depth = 1;
  for (let i = from; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\n' || char === '\r') {
      return { target: '', nextIndex: -1 };
    }
    if (char === '(' && !isEscapedAt(text, i)) {
      depth += 1;
      continue;
    }
    if (char === ')' && !isEscapedAt(text, i)) {
      depth -= 1;
      if (depth === 0) {
        const inside = text.slice(from, i);
        return { target: parseDestinationToken(inside), nextIndex: i };
      }
    }
  }
  return { target: '', nextIndex: -1 };
}

function parseDestinationToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('<')) {
    const close = trimmed.indexOf('>');
    if (close > 1) {
      return trimmed.slice(1, close);
    }
    return '';
  }

  let end = trimmed.length;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (/\s/.test(trimmed[i])) {
      end = i;
      break;
    }
  }
  return trimmed.slice(0, end);
}
