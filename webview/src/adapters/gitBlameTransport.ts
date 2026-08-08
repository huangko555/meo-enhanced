import {
  GIT_BLAME_TIMEOUT_MS,
  type GitBlameLineResult,
  type GitBlameRequest,
  type GitBlameResolution,
  type GitBlameResponse
} from '../../../src/protocol/git';
import { createRequestLifecycle, type RequestLifecycleOptions } from './requestLifecycle';

export type GitBlameTransportOptions = RequestLifecycleOptions;

export type GitBlameTransport = {
  request(request: Omit<GitBlameRequest, 'type' | 'requestId'>): Promise<GitBlameResolution>;
  accept(response: GitBlameResponse): boolean;
  cancelAll(message?: string): void;
};

export function createGitBlameTransport(
  postMessage: (message: GitBlameRequest) => void,
  options: GitBlameTransportOptions = {}
): GitBlameTransport {
  const lifecycle = createRequestLifecycle<GitBlameLineResult>(
    'blame',
    GIT_BLAME_TIMEOUT_MS,
    options
  );

  return {
    request(request) {
      return lifecycle.start(
        (requestId) => postMessage({ type: 'requestGitBlame', requestId, ...request }),
        {
          timeout: 'Timed out while resolving Git blame',
          sendFailed: 'Failed to send Git blame request'
        }
      );
    },
    accept(response) {
      return lifecycle.accept(response.requestId, response.result);
    },
    cancelAll(message = 'Git blame request superseded') {
      lifecycle.cancelAll(message);
    }
  };
}
