import { isWebviewPageId } from './readyInit';

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
  | DocumentReloadFromDiskFailedMessage
  | { readonly type: 'requestDraftRecoverySnapshot'; readonly pageId: string };

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

export type DraftChangedMessage =
  | {
      readonly type: 'draftChanged';
      readonly pageId: string;
      readonly text: string;
      /** Host document revision the local candidate was derived from. */
      readonly baseVersion: number;
      /** Present only for a terminal merge conflict; not sent on every edit. */
      readonly conflictBaseText?: string;
      /** One full beforeunload handoff that may outlive this page receiver. */
      readonly terminal?: true;
      readonly receiptVersion: number;
    }
  | {
      readonly type: 'draftChanged';
      readonly pageId: string;
      readonly text: null;
      readonly receiptVersion: number;
    };

export type DraftPatchedMessage = {
  readonly type: 'draftPatched';
  readonly pageId: string;
  /** Host document revision the reconstructed local candidate was derived from. */
  readonly baseVersion: number;
  readonly baseReceiptVersion: number;
  readonly receiptVersion: number;
} & (
  | { readonly change: TextChange; readonly changes?: never }
  | { readonly changes: readonly TextChange[]; readonly change?: never }
);
export type DraftRecoveryMessage = DraftChangedMessage | DraftPatchedMessage;

export type DocumentReloadPresentationCompletedMessage = {
  readonly type: 'documentReloadPresentationCompleted';
  readonly reloadId: number;
  readonly presented: boolean;
  readonly receiptVersion: number;
};

export type DocumentSyncCommand =
  | ApplyChangesMessage
  | DraftRecoveryMessage
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

function isReceiptVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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
  if (value.type === 'requestDraftRecoverySnapshot' && isWebviewPageId(value.pageId)) {
    return { type: 'requestDraftRecoverySnapshot', pageId: value.pageId };
  }
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
  if (value.type === 'draftPatched' && isWebviewPageId(value.pageId) && isVersion(value.baseVersion) && isReceiptVersion(value.baseReceiptVersion)
    && isReceiptVersion(value.receiptVersion) && value.receiptVersion > value.baseReceiptVersion
    && isTextChange(value.change) && value.changes === undefined) {
    return {
      type: 'draftPatched', pageId: value.pageId, baseVersion: value.baseVersion, baseReceiptVersion: value.baseReceiptVersion,
      receiptVersion: value.receiptVersion, change: value.change
    };
  }
  if (value.type === 'draftPatched' && isWebviewPageId(value.pageId) && isVersion(value.baseVersion) && isReceiptVersion(value.baseReceiptVersion)
    && isReceiptVersion(value.receiptVersion) && value.receiptVersion > value.baseReceiptVersion
    && value.change === undefined && Array.isArray(value.changes) && value.changes.every(isTextChange)
    && value.changes.every((change, index, changes) => index === 0 || change.from >= changes[index - 1].to)) {
    return {
      type: 'draftPatched', pageId: value.pageId, baseVersion: value.baseVersion, baseReceiptVersion: value.baseReceiptVersion,
      receiptVersion: value.receiptVersion, changes: value.changes
    };
  }
  if (value.type === 'draftChanged' && isWebviewPageId(value.pageId) && typeof text === 'string'
    && isVersion(value.baseVersion) && isReceiptVersion(value.receiptVersion)
    && (value.conflictBaseText === undefined || typeof value.conflictBaseText === 'string')
    && (value.terminal === undefined || value.terminal === true)) {
    return {
      type: 'draftChanged', pageId: value.pageId, text, baseVersion: value.baseVersion,
      ...(typeof value.conflictBaseText === 'string' ? { conflictBaseText: value.conflictBaseText } : {}),
      ...(value.terminal === true ? { terminal: true as const } : {}),
      receiptVersion: value.receiptVersion
    };
  }
  if (value.type === 'draftChanged' && isWebviewPageId(value.pageId) && text === null
    && isReceiptVersion(value.receiptVersion)) {
    return { type: 'draftChanged', pageId: value.pageId, text: null, receiptVersion: value.receiptVersion };
  }
  if (value.type === 'documentReloadPresentationCompleted'
    && isReloadId(value.reloadId) && typeof value.presented === 'boolean'
    && isReceiptVersion(value.receiptVersion)) {
    return {
      type: 'documentReloadPresentationCompleted',
      reloadId: value.reloadId,
      presented: value.presented,
      receiptVersion: value.receiptVersion
    };
  }
  const changes = value.changes;
  if (value.type === 'applyChanges' && isVersion(value.baseVersion)
    && Array.isArray(changes) && changes.every(isTextChange)) {
    return { type: 'applyChanges', baseVersion: value.baseVersion, changes: changes as TextChange[] };
  }
  return null;
}
// Recovery payloads intentionally have no legacy page-identity fallback.
