import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, type Dirent } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';

export type HashMetrics = { files: number; bytes: number; directories: number; cacheHits: number };

export function hashPaths(paths: string[], metrics?: HashMetrics): string {
  const counters = metrics ?? { files: 0, bytes: 0, directories: 0, cacheHits: 0 };
  // Bun's dependency graph exposes the same physical trees through many links.
  // Hash each physical node once per snapshot, retaining every logical edge,
  // filename and link target. Never cache between the before/after snapshots.
  const completed = new Map<string, string>();
  const activeDirectories = new Set<string>();
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const visit = (path: string, entry?: Dirent): string => {
    let stat;
    try { stat = entry ?? lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return digest('missing');
      throw error;
    }
    // Children are enumerated from an already resolved physical parent. Avoid
    // repeating Windows realpath/stat calls for every ordinary dependency file.
    const real = entry && !stat.isSymbolicLink() ? path : realpathSync(path);
    if (activeDirectories.has(real)) throw new Error(`Circular input directory: ${path}`);
    let content = completed.get(real);
    if (content !== undefined) counters.cacheHits++;
    else {
      const physical = stat.isSymbolicLink() ? lstatSync(real) : stat;
      if (physical.isDirectory()) {
        counters.directories++;
        activeDirectories.add(real);
        try {
          const entries = readdirSync(real, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
          content = digest(JSON.stringify(['directory', entries.map(entry => [entry.name, visit(join(real, entry.name), entry)])]));
        } finally { activeDirectories.delete(real); }
      } else {
        const bytes = readFileSync(real);
        counters.files++;
        counters.bytes += bytes.length;
        content = digest(JSON.stringify(['file', bytes.length, digest(bytes)]));
      }
      completed.set(real, content);
    }
    return stat.isSymbolicLink() ? digest(JSON.stringify(['link', readlinkSync(path), real, content])) : content;
  };
  return digest(JSON.stringify(['content-graph-v2', [...paths].sort().map(path => [path, visit(path)])]));
}

// Any source/test/config/dependency change invalidates resume. This is not
// affected-test inference or a cross-machine result cache.
export function workflowFingerprint(root: string, browserPath: string,
  record: (section: string, seconds: number, metrics?: HashMetrics) => void = () => {}, extraPaths: string[] = []): string {
  const started = performance.now();
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8'
  }).split('\0').filter(Boolean);
  const hash = createHash('sha256');
  hash.update(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }));
  hash.update(execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root }));
  record('Git identity', (performance.now() - started) / 1000);
  const append = (section: string, paths: string[]) => {
    const start = performance.now();
    const metrics: HashMetrics = { files: 0, bytes: 0, directories: 0, cacheHits: 0 };
    hash.update(hashPaths(paths, metrics));
    record(section, (performance.now() - start) / 1000, metrics);
  };
  append('Source, tests and configuration', [...new Set(files)].map(file => resolve(root, file)));
  if (extraPaths.length) append('Selected document fixtures', extraPaths.map(file => resolve(root, file)));
  append('Installed dependencies and runtimes', [
    join(root, 'node_modules'), join(root, 'webview/node_modules'),
    process.execPath, Bun.which('node') ?? '', browserPath
  ].filter(Boolean));
  // Hash environment values rather than persisting credentials in reports.
  hash.update(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))));
  hash.update(JSON.stringify({ root, platform: process.platform, arch: process.arch,
    os: os.release(), host: os.hostname(), bun: Bun.version, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
  return hash.digest('hex');
}

export function artifactFingerprint(root: string): string {
  return hashPaths([join(root, 'dist'), join(root, 'webview/dist')]);
}
