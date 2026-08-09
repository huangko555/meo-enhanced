import { tableStickyHeaderPolicy } from '../webview/src/editor/tableStickyHeaderPolicy';

(globalThis as typeof globalThis & {
  TableStickyHeaderPolicyCandidate?: {
    instances: number;
    policy: typeof tableStickyHeaderPolicy;
  };
}).TableStickyHeaderPolicyCandidate = {
  instances: 1,
  policy: tableStickyHeaderPolicy
};
