import { tableStickyHeaderPolicy } from '../webview/src/editor/tableStickyHeaderPolicy';
import { createCodeMirrorDomTableStickyHeaderAdapter } from '../webview/src/editor/internal/codeMirrorDomTableStickyHeaderAdapter';

(globalThis as typeof globalThis & {
  TableStickyHeaderAdapterCandidate?: unknown;
}).TableStickyHeaderAdapterCandidate = {
  policy: tableStickyHeaderPolicy,
  createAdapter: createCodeMirrorDomTableStickyHeaderAdapter
};
