export type DocumentChangedMessage = {
  readonly type: 'docChanged';
  readonly text: string;
  readonly version: number;
};

export type AppliedMessage = {
  readonly type: 'applied';
  readonly version: number;
};

export type DocumentReloadedFromDiskMessage = {
  readonly type: 'documentReloadedFromDisk';
  /** Correlates the Host reload result with the Webview presentation receipt. */
  readonly reloadId: number;
  readonly text: string;
  readonly version: number;
  readonly topLine: number;
  readonly topLineOffset: number;
};

export type DocumentReloadFromDiskFailedMessage = {
  readonly type: 'documentReloadFromDiskFailed';
  readonly message: string;
};

export type DocumentSyncMessage =
  | DocumentChangedMessage
  | AppliedMessage
  | DocumentReloadedFromDiskMessage
  | DocumentReloadFromDiskFailedMessage;

export type TextChange = {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
};

export type ApplyChangesMessage = {
  readonly type: 'applyChanges';
  readonly baseVersion: number;
  readonly changes: TextChange[];
};

export type DraftChangedMessage = {
  readonly type: 'draftChanged';
  readonly text: string | null;
};

export type DocumentReloadPresentationCompletedMessage = {
  readonly type: 'documentReloadPresentationCompleted';
  readonly reloadId: number;
  readonly presented: boolean;
};

export type DocumentSyncCommand =
  | ApplyChangesMessage
  | DraftChangedMessage
  | DocumentReloadPresentationCompletedMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isReloadId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isTextChange(value: unknown): value is TextChange {
  return isRecord(value)
    && typeof value.from === 'number'
    && Number.isInteger(value.from)
    && value.from >= 0
    && typeof value.to === 'number'
    && Number.isInteger(value.to)
    && value.to >= value.from
    && typeof value.insert === 'string';
}

function normalizeTopLine(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function normalizeTopLineOffset(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function decodeDocumentSyncMessage(value: unknown): DocumentSyncMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'docChanged' && typeof value.text === 'string' && isVersion(value.version)) {
    return { type: 'docChanged', text: value.text, version: value.version };
  }
  if (value.type === 'applied' && isVersion(value.version)) {
    return { type: 'applied', version: value.version };
  }
  if (value.type === 'documentReloadedFromDisk' && typeof value.text === 'string'
    && isVersion(value.version) && isReloadId(value.reloadId)) {
    return {
      type: 'documentReloadedFromDisk',
      reloadId: value.reloadId,
      text: value.text,
      version: value.version,
      topLine: normalizeTopLine(value.topLine),
      topLineOffset: normalizeTopLineOffset(value.topLineOffset)
    };
  }
  if (value.type === 'documentReloadFromDiskFailed' && typeof value.message === 'string') {
    return { type: 'documentReloadFromDiskFailed', message: value.message };
  }
  return null;
}

export function decodeDocumentSyncCommand(value: unknown): DocumentSyncCommand | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  const text = value.text;
  if (value.type === 'draftChanged' && typeof text === 'string') {
    return { type: 'draftChanged', text };
  }
  if (value.type === 'draftChanged' && text === null) {
    return { type: 'draftChanged', text: null };
  }
  if (value.type === 'documentReloadPresentationCompleted'
    && isReloadId(value.reloadId) && typeof value.presented === 'boolean') {
    return {
      type: 'documentReloadPresentationCompleted',
      reloadId: value.reloadId,
      presented: value.presented
    };
  }
  const changes = value.changes;
  if (value.type === 'applyChanges' && isVersion(value.baseVersion)
    && Array.isArray(changes) && changes.every(isTextChange)) {
    return { type: 'applyChanges', baseVersion: value.baseVersion, changes: changes as TextChange[] };
  }
  return null;
}
