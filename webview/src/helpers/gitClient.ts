import type { GitBaselineChangedEvent } from '../../../src/protocol/git';

interface GitClient {
  applyBaselineToEditor: (editor: any) => void;
  handleMessage: (message: GitBaselineChangedEvent, options?: { editor?: any }) => boolean;
}

export function createGitClient(): GitClient {
  let gitBaselineSnapshot: any = null;
  let pendingGitBaselineBeforeEditorMount: any = null;
  let baselineGeneration = -1;

  const applyBaselineToEditor = (editor: any) => {
    if (!editor) {
      return;
    }
    if (pendingGitBaselineBeforeEditorMount) {
      editor.setGitBaseline(pendingGitBaselineBeforeEditorMount);
      pendingGitBaselineBeforeEditorMount = null;
      return;
    }
    if (gitBaselineSnapshot) {
      editor.setGitBaseline(gitBaselineSnapshot);
    }
  };

  const handleMessage = (
    message: GitBaselineChangedEvent,
    { editor }: { editor?: any } = {}
  ): boolean => {
    if (message.type !== 'gitBaselineChanged') {
      return false;
    }
    const incomingGeneration = Number.isFinite(message.payload?.generation)
      ? Number(message.payload.generation)
      : 0;
    if (incomingGeneration < baselineGeneration) {
      return true;
    }
    baselineGeneration = incomingGeneration;
    gitBaselineSnapshot = message.payload ?? null;
    if (editor) {
      editor.setGitBaseline(gitBaselineSnapshot);
    } else {
      pendingGitBaselineBeforeEditorMount = gitBaselineSnapshot;
    }
    return true;
  };

  return { applyBaselineToEditor, handleMessage };
}
