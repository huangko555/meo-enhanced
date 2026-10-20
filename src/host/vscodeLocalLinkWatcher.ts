import * as vscode from 'vscode';
import { posix } from 'node:path';
import { isLikelyLocalLinkDestination } from '../foundation/linkDestination';
import { markdownReferenceCandidates } from './markdownPathTargets';

const resourcePath = (uri: vscode.Uri): string => {
  const path = uri.path.replace(/\/$/, '');
  return uri.scheme === 'file' && process.platform === 'win32' ? path.toLowerCase() : path;
};
const contains = (parent: vscode.Uri, child: vscode.Uri): boolean => parent.scheme === child.scheme
  && parent.authority === child.authority && (resourcePath(parent) === resourcePath(child)
    || resourcePath(child).startsWith(resourcePath(parent) + '/'));
const parentDirectory = (uri: vscode.Uri): vscode.Uri => {
  const path = posix.dirname(uri.path);
  return uri.with({ path: /^\/[a-z]:$/i.test(path) ? path + '/' : path, query: '', fragment: '' });
};

/** Watch candidate directories and recheck when a missing ancestor is created. */
export function createVscodeLocalLinkWatcher(document: vscode.Uri, changed: () => void): {
  update(targets: readonly string[]): Promise<void>;
  dispose(): void;
} {
  const watchers = new Map<string, vscode.FileSystemWatcher>();
  let candidates: vscode.Uri[] = [];
  let generation = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; if (!disposed) changed(); }, delay);
  };
  const onResourceChanged = (uri: vscode.Uri) => {
    if (disposed || !candidates.some(candidate => contains(uri, candidate))) return;
    scheduleRefresh(100);
  };

  return {
    async update(targets) {
      if (disposed) return;
      const current = ++generation;
      const nextCandidates = [...new Map(targets.filter(isLikelyLocalLinkDestination)
        .flatMap(target => markdownReferenceCandidates(target, document)).map(uri => [uri.toString(), uri])).values()];
      const directoryRoots = new Map<string, Promise<vscode.Uri>>();
      const rootFor = (uri: vscode.Uri): Promise<vscode.Uri> => {
        const directory = parentDirectory(uri);
        let pending = directoryRoots.get(directory.toString());
        if (!pending) {
          pending = (async () => {
            let root = directory;
            for (;;) {
              try { if ((await vscode.workspace.fs.stat(root)).type & vscode.FileType.Directory) return root; } catch { /* Missing directories need an existing ancestor. */ }
              const parent = parentDirectory(root);
              if (parent.path === root.path) return root;
              root = parent;
            }
          })();
          directoryRoots.set(directory.toString(), pending);
        }
        return pending;
      };
      const roots = await Promise.all(nextCandidates.map(rootFor));
      if (disposed || current !== generation) return;
      candidates = nextCandidates;
      // Direct children reveal the next missing directory. Watching each root's
      // parent also catches the root being removed. No recursive watcher is needed.
      const retained = new Map(roots.flatMap(root => [root, parentDirectory(root)]).map(root => [root.toString(), root]));
      for (const [key, watcher] of watchers) if (!retained.has(key)) { watcher.dispose(); watchers.delete(key); }
      let added = false;
      for (const [key, root] of retained) {
        if (watchers.has(key)) continue;
        try {
          const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '*'));
          watcher.onDidCreate(onResourceChanged);
          watcher.onDidDelete(onResourceChanged);
          watcher.onDidChange(onResourceChanged);
          watchers.set(key, watcher);
          added = true;
        } catch { /* Navigation and focus refresh still work for providers without watching. */ }
      }
      // Native watcher registration is asynchronous and has no ready receipt.
      // Recheck once after new roots settle so that interval cannot retain a stale hint.
      if (added) scheduleRefresh(500);
    },
    dispose() {
      disposed = true;
      generation++;
      if (timer) clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.dispose();
      watchers.clear();
      candidates = [];
    }
  };
}
