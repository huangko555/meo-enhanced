import { compareDocuments, type DocumentDiff } from '../../../src/shared/gitDiffCore';

export type GitDiffWorkerRequest = {
  readonly id: number;
  readonly baseline: string;
  readonly current: string;
};

export type GitDiffWorkerResponse = {
  readonly id: number;
  readonly result: DocumentDiff;
};

// Bundled as one classic script: VS Code Webviews only load blob/data workers
// and do not support imports inside them.
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<GitDiffWorkerRequest>) => void) | null;
  postMessage(message: GitDiffWorkerResponse, transfer: Transferable[]): void;
};
worker.onmessage = ({ data }) => {
  const result = compareDocuments(data.baseline, data.current, { maxComputationTimeMs: 50 });
  worker.postMessage({ id: data.id, result }, [result.currentToBaselineLine.buffer]);
};
