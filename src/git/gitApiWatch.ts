import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitBaselineRefreshOptions } from '../application/gitBaselineRefreshCoordinator';

type GitRepository = {
  rootUri?: vscode.Uri;
  state?: {
    onDidChange?: vscode.Event<unknown>;
  };
};

type GitApi = {
  repositories?: GitRepository[];
  onDidOpenRepository?: vscode.Event<GitRepository>;
  onDidCloseRepository?: vscode.Event<GitRepository>;
};

type GitExtensionExports = {
  getAPI?: (version: number) => GitApi | undefined;
};

type GitRepositorySession = {
  getGitRepoRoot(): string | null;
  refreshGitBaseline(options: GitBaselineRefreshOptions): void;
};

// On Windows Git prints `C:/repo`, while `Uri.fsPath` gives `c:\repo`.
function isSameRepoRoot(left: string, right: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return left === right;
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

export function refreshRepositorySessions(
  sessions: Iterable<GitRepositorySession>,
  repoRootFsPath: string,
  platform: NodeJS.Platform = process.platform
): void {
  for (const session of sessions) {
    const sessionRepoRoot = session.getGitRepoRoot();
    if (sessionRepoRoot === null || !isSameRepoRoot(sessionRepoRoot, repoRootFsPath, platform)) {
      continue;
    }
    session.refreshGitBaseline({ forceReload: true });
  }
}

function normalizeRepoKey(repo: GitRepository): string | null {
  const root = repo.rootUri?.fsPath;
  return typeof root === 'string' && root ? root : null;
}

export async function createGitApiWatcher(
  onRepoChanged: (repoRootFsPath: string) => void
): Promise<vscode.Disposable | null> {
  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!extension) {
    return null;
  }

  let api: GitApi | undefined;
  try {
    if (!extension.isActive) {
      await extension.activate();
    }
    api = extension.exports?.getAPI?.(1);
  } catch {
    return null;
  }

  if (!api) {
    return null;
  }

  const disposables: vscode.Disposable[] = [];
  const repoSubscriptions = new Map<string, vscode.Disposable>();

  const attachRepository = (repo: GitRepository) => {
    const key = normalizeRepoKey(repo);
    if (!key || repoSubscriptions.has(key)) {
      return;
    }
    const onDidChange = repo.state?.onDidChange;
    if (typeof onDidChange !== 'function') {
      return;
    }
    repoSubscriptions.set(key, onDidChange(() => {
      onRepoChanged(key);
    }));
  };

  const detachRepository = (repo: GitRepository) => {
    const key = normalizeRepoKey(repo);
    if (!key) {
      return;
    }
    repoSubscriptions.get(key)?.dispose();
    repoSubscriptions.delete(key);
  };

  for (const repo of api.repositories ?? []) {
    attachRepository(repo);
  }

  if (api.onDidOpenRepository) {
    disposables.push(api.onDidOpenRepository((repo) => attachRepository(repo)));
  }
  if (api.onDidCloseRepository) {
    disposables.push(api.onDidCloseRepository((repo) => detachRepository(repo)));
  }

  return new vscode.Disposable(() => {
    for (const disposable of repoSubscriptions.values()) {
      disposable.dispose();
    }
    repoSubscriptions.clear();
    for (const disposable of disposables) {
      disposable.dispose();
    }
  });
}

