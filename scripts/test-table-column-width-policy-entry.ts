import { tableColumnWidthPolicy } from '../webview/src/editor/tableColumnWidthPolicy';

(globalThis as typeof globalThis & {
  TableColumnWidthPolicyCandidate?: {
    instances: number;
    policy: typeof tableColumnWidthPolicy;
  };
}).TableColumnWidthPolicyCandidate = {
  instances: 1,
  policy: tableColumnWidthPolicy
};

