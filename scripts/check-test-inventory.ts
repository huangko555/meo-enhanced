import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import type { TestWorkflowCommand } from './test-workflow-policy';

type Exception = { kind: 'targeted' | 'native' | 'endurance'; command: string; reason: string };
type InventoryCommand = TestWorkflowCommand & { runtime?: 'bun' | 'node' };
export type TestInventory = {
  separate: Record<string, Exception>;
  repeats: Array<InventoryCommand & { count: number; reason: string }>;
  resources: { process: string[]; exclusive: string[] };
};
type Snapshot = Map<string, string>;
const candidate = (path: string) => /^scripts\/(?:.*\/)?test-[^/]+\.(?:ts|tsx|js|mjs|cjs|ps1)$/.test(path);
const identity = (command: InventoryCommand) => JSON.stringify([
  command.runtime ?? 'bun', command.args, Object.entries(command.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
]);

// All inputs come from one snapshot. In --staged mode, an unstaged registration
// must not hide an orphan in the commit being checked.
export function readInventorySnapshot(root: string, staged: boolean): Snapshot {
  const paths = execFileSync('git', ['ls-files', '--cached', ...(!staged ? ['--others', '--exclude-standard'] : []), '-z'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(path => path === 'package.json' || path.startsWith('scripts/'));
  const unique = [...new Set(paths)].sort();
  const relevant = unique.filter(path => /\.(?:json|ts|tsx|js|mjs|cjs|ps1)$/.test(path));
  if (!staged) return new Map(relevant.map(path => [path, readFileSync(resolve(root, path), 'utf8')]));
  const bytes = execFileSync('git', ['cat-file', '--batch'], { cwd: root,
    input: relevant.map(path => `:${path}\n`).join(''), maxBuffer: 128 * 1024 * 1024 });
  let offset = 0;
  return new Map(relevant.map(path => {
    const end = bytes.indexOf(10, offset);
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(bytes.subarray(offset, end).toString());
    if (!match) throw new Error(`Cannot read staged test inventory input: ${path}`);
    const size = Number(match[1]);
    offset = end + 1 + size + 1;
    return [path, bytes.subarray(end + 1, end + 1 + size).toString('utf8')];
  }));
}

export function inspectTestInventory(files: Snapshot, commands: TestWorkflowCommand[], inventory: TestInventory): string[] {
  const errors: string[] = [];
  const scripts = JSON.parse(files.get('package.json') ?? '{}').scripts as Record<string, string>;
  if (!scripts || !inventory.separate || !Array.isArray(inventory.repeats)) throw new Error('Invalid test inventory configuration');
  const executable: InventoryCommand[] = [];
  const expand = (command: InventoryCommand, ancestors: string[] = []): InventoryCommand[] => {
    if (command.args[0] !== 'run') return [command];
    const name = command.args[1]!;
    if (ancestors.includes(name)) throw new Error(`Cyclic package script: ${[...ancestors, name].join(' -> ')}`);
    if (!scripts[name]) throw new Error(`Missing package script: ${name}`);
    return scripts[name].split('&&').flatMap(part => {
      const text = part.trim();
      const alias = /^bun run ([\w:-]+)$/.exec(text);
      if (alias) return expand({ ...command, args: ['run', alias[1]!] }, [...ancestors, name]);
      const direct = /^(bun|node) (scripts\/[\w./-]+\.(?:ts|tsx|js|mjs|cjs))(?: ([\w=./:-]+(?: [\w=./:-]+)*))?$/.exec(text);
      if (direct) return [{ ...command, runtime: direct[1] as 'bun' | 'node', args: [direct[2]!, ...(direct[3]?.split(' ') ?? [])] }];
      // Build and compiler commands are opaque; test aliases must be auditable.
      if (name === 'test' || name.startsWith('test:') || /scripts\/test-/.test(text)) {
        throw new Error(`Unsupported test inventory command in ${name}: ${text}`);
      }
      return [];
    });
  };
  for (const command of commands) executable.push(...expand(command));
  const reached = new Set(executable.map(command => command.args[0]!));
  const runnable = new Set([...reached].filter(candidate));
  for (const [path, exception] of Object.entries(inventory.separate)) {
    if (!candidate(path) || !files.has(path)) errors.push(`Stale separate-test registration: ${path}`);
    if (!['targeted', 'native', 'endurance'].includes(exception.kind)
      || !exception.reason?.trim() || !exception.command?.includes(path)) errors.push(`Missing classification, command or reason: ${path}`);
    if (reached.has(path)) errors.push(`Test is now in release; remove its separate registration: ${path}`);
    reached.add(path);
    runnable.add(path);
  }

  // Imported helpers and explicitly referenced browser entry fixtures belong to
  // their reachable owner. A naming suffix alone never exempts an orphan.
  const queue = [...reached];
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const jsxTranspiler = new Bun.Transpiler({ loader: 'tsx' });
  const dependenciesByPath = new Map<string, string[]>();
  const browserOwners = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i]!;
    const source = files.get(path);
    if (source === undefined) { errors.push(`Missing test or helper: ${path}`); continue; }
    if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(path)) continue;
    const parser = path.endsWith('.tsx') ? jsxTranspiler : transpiler;
    const imports = parser.scan(source).imports.map(item => item.path);
    if (imports.some(ref => /(?:puppeteer|playwright|browser-test-helpers|@vscode\/test-electron)/.test(ref))
      || /(?:launchTestBrowser\s*\(|puppeteer-runtime|remote-debugging-port|\bStart-Process\b|\bSendInput\b)/.test(source)) browserOwners.add(path);
    const refs = imports.filter(item => item.startsWith('.'));
    const dependencies = refs.flatMap(ref => {
      const base = posix.normalize(posix.join(posix.dirname(path), ref));
      const matches = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.cjs`].filter(item => files.has(item));
      if (!matches.length && /(?:^|\/)test-/.test(ref)) errors.push(`Missing test helper imported by ${path}: ${ref}`);
      return matches;
    });
    // Transpilation removes comments. Match entire string tokens so a quoted
    // source-code example cannot silently register a fixture mentioned inside it.
    for (const match of parser.transformSync(source).matchAll(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g)) {
      const literal = match[0].slice(1, -1);
      if (!/^(?:scripts\/)?test-[\w-]+-entry\.ts$/.test(literal)) continue;
      const entry = literal.startsWith('scripts/') ? literal : posix.join(posix.dirname(path), literal);
      if (files.has(entry)) dependencies.push(entry);
    }
    for (const dependency of dependencies) {
      if (!reached.has(dependency)) { reached.add(dependency); queue.push(dependency); }
    }
    dependenciesByPath.set(path, dependencies);
  }
  for (const path of files.keys()) if (candidate(path) && !reached.has(path)) errors.push(`Unregistered test: ${path}`);
  // A new convenience alias is fine only when every test already has an owner.
  for (const name of Object.keys(scripts).filter(name => name.startsWith('test:'))) {
    for (const command of expand({ args: ['run', name] })) {
      if (!reached.has(command.args[0]!)) errors.push(`Unregistered test alias ${name}: ${command.args[0]}`);
    }
  }
  const counts = new Map<string, number>();
  for (const command of executable.filter(command => candidate(command.args[0]!))) {
    const key = identity(command);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const allowances = new Map<string, number>();
  for (const repeat of inventory.repeats) {
    const key = identity(repeat);
    if (!repeat.reason?.trim() || repeat.count < 2 || !Number.isInteger(repeat.count) || allowances.has(key)) errors.push(`Invalid repeat allowance: ${key}`);
    allowances.set(key, repeat.count);
    if (counts.get(key) !== repeat.count) errors.push(`Stale repeat allowance: ${key}`);
  }
  for (const [key, count] of counts) if (count > 1 && allowances.get(key) !== count) errors.push(`Unexplained repeated test (${count}): ${key}`);
  const assigned = new Set<string>();
  if (!inventory.resources || !Array.isArray(inventory.resources.process) || !Array.isArray(inventory.resources.exclusive)) {
    errors.push('Missing test resource classification (process/exclusive)');
  } else {
    for (const kind of ['process', 'exclusive'] as const) for (const path of inventory.resources[kind]) {
      if (!runnable.has(path)) errors.push(`Stale test resource classification: ${path}`);
      if (assigned.has(path)) errors.push(`Duplicate test resource classification: ${path}`);
      assigned.add(path);
      if (kind === 'process') {
        const pending = [path];
        const visited = new Set<string>();
        while (pending.length) {
          const current = pending.pop()!;
          if (visited.has(current)) continue;
          visited.add(current);
          if (browserOwners.has(current)) { errors.push(`Process-only test reaches browser/desktop resources: ${path} via ${current}`); break; }
          pending.push(...dependenciesByPath.get(current) ?? []);
        }
      }
    }
    for (const path of runnable) if (!assigned.has(path)) errors.push(`Unclassified test resources: ${path}`);
  }
  return errors;
}

export async function checkTestInventory(root: string, staged = false): Promise<Record<string, 'process' | 'exclusive'>> {
  const files = readInventorySnapshot(root, staged);
  const policySource = files.get('scripts/test-workflow-policy.ts');
  if (!policySource) throw new Error('Missing test workflow policy');
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  if (transpiler.scan(policySource).imports.length) throw new Error('Inventory snapshot requires a self-contained workflow policy');
  // The policy is pure plan construction. Load its snapshot, never the unstaged
  // working copy, and never import or execute any product test during this check.
  const policy = await import(`data:text/javascript;base64,${Buffer.from(transpiler.transformSync(policySource)).toString('base64')}`);
  const release = policy.createTestWorkflowPlan(policy.parseTestWorkflowRequest(['release']));
  const commands: TestWorkflowCommand[] = policy.flattenTestWorkflowCommands(release);
  const inventory = JSON.parse(files.get('scripts/test-inventory.json') ?? '{}') as TestInventory;
  const errors = inspectTestInventory(files, commands, inventory);
  if (errors.length) throw new Error(`Test inventory failed:\n${errors.map(error => `  ${error}`).join('\n')}`);
  console.log(`Test inventory (${staged ? 'staged index' : 'working tree'}) passed: ${[...files.keys()].filter(candidate).length} files accounted for; ${inventory.repeats.length} documented repeats.`);
  return Object.fromEntries((['process', 'exclusive'] as const).flatMap(kind => inventory.resources[kind].map(path => [path, kind])));
}

if (import.meta.main) {
  try { await checkTestInventory(resolve(dirname(import.meta.path), '..'), process.argv.includes('--staged')); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
