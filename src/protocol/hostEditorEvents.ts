import type { DiffBaselineMode, OutlinePosition } from './editorCommands';

export type HostEditorEvent =
  | { readonly type: 'focusEditor' }
  | { readonly type: 'revealSelection'; readonly anchor: number; readonly head: number; readonly focus?: boolean; readonly preserveViewport?: boolean }
  | { readonly type: 'revealDocumentFragment'; readonly href: string }
  | { readonly type: 'outlinePositionChanged'; readonly position: OutlinePosition }
  | { readonly type: 'outlineVisibilityChanged'; readonly visible: boolean }
  | { readonly type: 'gitChangesGutterChanged'; readonly enabled: boolean }
  | { readonly type: 'gitDiffLineHighlightsChanged'; readonly enabled: boolean }
  | { readonly type: 'diffBaselineModeChanged'; readonly mode: DiffBaselineMode }
  | { readonly type: 'fixedBaselineChanged'; readonly pinned: boolean; readonly active: boolean }
  | { readonly type: 'contentMaxWidthChanged'; readonly enabled: boolean }
  | { readonly type: 'longCodeBlockFoldingChanged'; readonly enabled: boolean }
  | { readonly type: 'findOptionsChanged'; readonly findOptions: { readonly wholeWord: boolean; readonly caseSensitive: boolean } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function decodeHostEditorEvent(value: unknown): HostEditorEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'focusEditor':
      return { type: 'focusEditor' };
    case 'revealSelection':
      return isOffset(value.anchor) && isOffset(value.head)
        && (value.focus === undefined || typeof value.focus === 'boolean')
        && (value.preserveViewport === undefined || typeof value.preserveViewport === 'boolean')
        ? value as HostEditorEvent : null;
    case 'revealDocumentFragment':
      return typeof value.href === 'string' && value.href.length > 0 ? value as HostEditorEvent : null;
    case 'outlinePositionChanged':
      return value.position === 'left' || value.position === 'right' ? value as HostEditorEvent : null;
    case 'outlineVisibilityChanged':
      return typeof value.visible === 'boolean' ? value as HostEditorEvent : null;
    case 'gitChangesGutterChanged':
    case 'gitDiffLineHighlightsChanged':
    case 'contentMaxWidthChanged':
    case 'longCodeBlockFoldingChanged':
      return typeof value.enabled === 'boolean' ? value as HostEditorEvent : null;
    case 'diffBaselineModeChanged':
      return value.mode === 'current-edit' || value.mode === 'recent-save' || value.mode === 'git-head'
        ? value as HostEditorEvent : null;
    case 'fixedBaselineChanged':
      return typeof value.pinned === 'boolean' && typeof value.active === 'boolean' ? value as HostEditorEvent : null;
    case 'findOptionsChanged':
      return isRecord(value.findOptions)
        && typeof value.findOptions.wholeWord === 'boolean'
        && typeof value.findOptions.caseSensitive === 'boolean' ? value as HostEditorEvent : null;
    default:
      return null;
  }
}
