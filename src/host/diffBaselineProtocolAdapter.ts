import { createHash } from 'node:crypto';
import type {
  DiffBaselineOutput,
  DiffBaselineSelection
} from '../application/diffBaselineSelection';
import type { GitBaselineChangedEvent, GitBaselinePayload } from '../protocol/git';
import type { HostEditorEvent } from '../protocol/hostEditorEvents';

type DiffBaselineProtocolAdapterDependencies = {
  readonly readDocumentVersion: () => number;
  readonly post: (message: GitBaselineChangedEvent | HostEditorEvent) => Promise<boolean>;
};

/** Maps Application comparison selections to the single Host/Webview Protocol. */
export function createDiffBaselineProtocolAdapter(
  dependencies: DiffBaselineProtocolAdapterDependencies
): DiffBaselineOutput<GitBaselinePayload> {
  const toPayload = (selection: DiffBaselineSelection<GitBaselinePayload>): GitBaselinePayload => {
    switch (selection.kind) {
      case 'disabled':
        return { available: false, tracked: false, baseText: null };
      case 'fixed':
        return {
          available: true,
          tracked: true,
          headOid: null,
          baseText: selection.text,
          mode: 'fixed'
        };
      case 'saved':
        return {
          available: true,
          tracked: true,
          headOid: null,
          baseText: selection.text,
          mode: selection.mode
        };
      case 'unavailable':
        return {
          available: false,
          tracked: false,
          baseText: null,
          mode: selection.mode,
          reason: selection.reason
        };
      case 'git-head':
        return { ...selection.value, mode: 'git-head' };
    }
  };

  return {
    hash(selection) {
      const payload = toPayload(selection);
      const hash = createHash('sha1');
      hash.update(JSON.stringify({
        available: payload.available,
        mode: payload.mode ?? 'git-head',
        repoRoot: payload.repoRoot ?? null,
        headOid: payload.headOid ?? null,
        tracked: payload.tracked,
        gitPath: payload.gitPath ?? null,
        reason: payload.reason ?? null,
        maxBytesExceeded: Boolean(payload.maxBytesExceeded)
      }));
      hash.update('\n');
      hash.update(payload.baseText ?? '');
      return hash.digest('hex');
    },
    async publish(selection, generation) {
      const message: GitBaselineChangedEvent = {
        type: 'gitBaselineChanged',
        version: dependencies.readDocumentVersion(),
        payload: { ...toPayload(selection), generation }
      };
      return dependencies.post(message);
    },
    async publishFixedState(state) {
      const message: HostEditorEvent = { type: 'fixedBaselineChanged', ...state };
      await dependencies.post(message);
    }
  };
}
