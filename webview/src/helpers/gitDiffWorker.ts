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
  // The foreground's 50ms budget includes line preparation and can expire
  // before a large comparison starts. Use the shared 1s background budget;
  // the owner still cancels superseded work and enforces a 5s outer deadline.
  const result = compareDocuments(data.baseline, data.current);
  worker.postMessage({ id: data.id, result }, [result.currentToBaselineLine.buffer]);
};
