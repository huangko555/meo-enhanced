import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest, saveWorkflowState } from './test-workflow-execution';
import { artifactFingerprint, workflowFingerprint } from './test-workflow-snapshot';

export type NativeStep = {
  id: string; kind: 'setup' | 'preflight' | 'check' | 'cleanup';
  command: { runtime: 'bun' | 'node' | 'pwsh'; script: string; args?: string[] };
  timeoutSeconds: number; dependsOn?: string[]; requires?: string[]; provides?: string[];
  receipt: { file: string; expect?: Record<string, unknown> };
};
export type NativePlan = {
  schemaVersion: 1;
  environment: { id: string; launch: 'normal' | 'forced-accessibility'; description: string; runtimes: string[] };
  artifact: { file: string; sha256: string };
  inputs: string[];
  steps: NativeStep[];
};
type FileProof = { file: string; sha256: string };
export type NativeResult = {
  id: string; status: 'running' | 'passed' | 'failed' | 'blocked' | 'reused';
  seconds?: number; childPid?: number; exitCode?: number; error?: string;
  stdout?: FileProof; stderr?: FileProof; receipt?: FileProof; capabilities?: string[]; evidence?: string;
};
export type NativeState = {
  schemaVersion: 1; runId: string; pid: number; snapshot: string; planHash: string;
  artifactSha256: string; environment: NativePlan['environment'];
  status: 'running' | 'passed' | 'failed' | 'invalidated';
  startedAt: string; completedAt?: string; results: NativeResult[];
};
type Dispositions = { reportHash: string; failures: Array<{ id: string; classification: 'product' | 'driver' | 'environment'; cause: string; correction: string }> };

export function validateNativePlan(plan: NativePlan): void {
  if (plan.schemaVersion !== 1 || !plan.environment?.id?.trim() || !plan.environment.description?.trim()
    || !['normal', 'forced-accessibility'].includes(plan.environment.launch)
    || !Array.isArray(plan.environment.runtimes) || !plan.environment.runtimes.length
    || !plan.artifact?.file || !/^[a-f0-9]{64}$/.test(plan.artifact.sha256)
    || !Array.isArray(plan.inputs) || !Array.isArray(plan.steps)) throw new Error('Invalid native acceptance plan identity.');
  const ids = new Set<string>(), capabilities = new Set<string>();
  let cleanup = false;
  for (const step of plan.steps) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(step.id) || ids.has(step.id)
      || !['setup', 'preflight', 'check', 'cleanup'].includes(step.kind)
      || !['bun', 'node', 'pwsh'].includes(step.command?.runtime)
      || !step.command.script || !Array.isArray(step.command.args ?? [])
      || (step.command.args ?? []).some(arg => typeof arg !== 'string')
      || !Number.isFinite(step.timeoutSeconds) || step.timeoutSeconds <= 0 || step.timeoutSeconds > 3600
      || !step.receipt?.file || path.isAbsolute(step.receipt.file)
      || step.receipt.file.split(/[\\/]/).includes('..')) throw new Error(`Invalid native step: ${step.id}`);
    if (cleanup && step.kind !== 'cleanup') throw new Error('Cleanup steps must be last.');
    if ((step.dependsOn ?? []).some(id => !ids.has(id))) throw new Error(`Dependencies must precede ${step.id}.`);
    if ((step.requires ?? []).some(capability => !capabilities.has(capability))) throw new Error(`Missing preflight provider for ${step.id}.`);
    if (step.kind === 'check' && !capabilities.has('installed-vsix')) {
      throw new Error(`Installed-VSIX preflight must be planned before ${step.id}.`);
    }
    if ((step.provides?.length ?? 0) && !['setup', 'preflight'].includes(step.kind)) throw new Error('Only setup/preflight can prove capabilities.');
    for (const capability of step.provides ?? []) capabilities.add(capability);
    cleanup ||= step.kind === 'cleanup';
    ids.add(step.id);
  }
  if (!cleanup || !plan.steps.some(step => step.kind === 'check')) throw new Error('Native acceptance requires checks and owned cleanup.');
}

function proof(file: string): FileProof { return { file, sha256: digest(fs.readFileSync(file)) }; }
function verified(file: FileProof | undefined): boolean {
  try { return !!file && proof(file.file).sha256 === file.sha256; } catch { return false; }
}
function readField(value: unknown, field: string): unknown {
  return field.split('.').reduce<unknown>((item, key) => item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined, value);
}

export function verifyNativeReceipt(step: NativeStep, directory: string): { receipt: FileProof; capabilities: string[] } {
  const file = path.resolve(directory, step.receipt.file);
  const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(file));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Receipt escaped its fresh step directory.');
  const bytes = fs.readFileSync(file), receipt = JSON.parse(bytes.toString());
  if (receipt.passed !== true) throw new Error(`Missing passing owner receipt: ${step.id}`);
  for (const [field, expected] of Object.entries(step.receipt.expect ?? {})) {
    if (!isDeepStrictEqual(readField(receipt, field), expected)) throw new Error(`Owner receipt mismatch: ${step.id}.${field}`);
  }
  for (const capability of step.provides ?? []) {
    if (receipt.capabilities?.[capability] !== true) throw new Error(`Unproven capability: ${capability}`);
  }
  return { receipt: { file, sha256: digest(bytes) }, capabilities: step.provides ?? [] };
}

export function validateNativeResume(state: NativeState, snapshot: string, planHash: string, reportHash: string, dispositions?: Dispositions): void {
  if (state.schemaVersion !== 1 || state.snapshot !== snapshot || state.planHash !== planHash || state.status === 'invalidated') {
    throw new Error('Native candidate, plan, scripts, dependencies, document or environment changed; start a new session and review prior evidence.');
  }
  for (const pid of [state.status === 'running' ? state.pid : undefined,
    ...state.results.filter(result => result.status === 'running').map(result => result.childPid)]) {
    if (!pid) continue;
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error; }
    throw new Error('Previous native executor or child is still active.');
  }
  for (const result of state.results.filter(result => result.status === 'failed')) {
    const disposition = dispositions?.reportHash === reportHash ? dispositions.failures.find(entry => entry.id === result.id) : undefined;
    if (!disposition || !['product', 'driver', 'environment'].includes(disposition.classification)
      || !disposition.cause?.trim() || !disposition.correction?.trim()) throw new Error(`Diagnose and disposition the failure before retry: ${result.id}`);
  }
}

/** Every invocation reproves setup/capabilities; only complete, byte-verified check owners can be reused. */
export async function executeNativePlan(options: {
  plan: NativePlan; state: NativeState; directory: string; previous?: { file: string; state: NativeState };
  persist: () => void; snapshot: () => string;
  run: (step: NativeStep, directory: string, result: NativeResult) => Promise<number>;
}): Promise<void> {
  const { plan, state, directory, previous, persist, run } = options;
  validateNativePlan(plan);
  const accepted = new Set<string>(), capabilities = new Set<string>();
  const execute = async (step: NativeStep) => {
    const result: NativeResult = { id: step.id, status: 'running' };
    state.results.push(result);
    const needs = step.kind === 'check' ? ['installed-vsix', ...(step.requires ?? [])] : step.requires ?? [];
    if (step.kind !== 'cleanup' && ((step.dependsOn ?? []).some(id => !accepted.has(id)) || needs.some(capability => !capabilities.has(capability)))) {
      result.status = 'blocked'; result.error = 'Required owner or capability did not pass'; persist(); return;
    }
    const prior = step.kind === 'check' ? previous?.state.results.find(result => result.id === step.id) : undefined;
    if (prior && ['passed', 'reused'].includes(prior.status)) {
      if (!verified(prior.stdout) || !verified(prior.stderr) || !verified(prior.receipt)) {
        result.status = 'failed'; result.error = `Prior evidence changed: ${step.id}`;
      } else Object.assign(result, prior, { status: 'reused', seconds: 0, evidence: `${previous!.file}#${step.id}` });
    } else {
      const output = path.join(directory, step.id); fs.mkdirSync(output, { recursive: true });
      persist(); const started = performance.now();
      try {
        result.exitCode = await run(step, output, result);
        if (result.exitCode !== 0) throw new Error(`Owner exited with ${result.exitCode}`);
        Object.assign(result, verifyNativeReceipt(step, output)); result.status = 'passed';
      } catch (error) { result.status = 'failed'; result.error = String(error); }
      result.seconds = (performance.now() - started) / 1000;
    }
    if (['passed', 'reused'].includes(result.status)) {
      accepted.add(step.id); for (const capability of result.capabilities ?? []) capabilities.add(capability);
    }
    persist();
  };
  let infrastructureError: unknown;
  try {
    for (const step of plan.steps.filter(step => step.kind !== 'cleanup')) await execute(step);
  } catch (error) {
    infrastructureError = error;
    const running = state.results.findLast(result => result.status === 'running');
    if (running) { running.status = 'failed'; running.error = String(error); }
  }
  finally {
    for (const step of plan.steps.filter(step => step.kind === 'cleanup')) {
      try { await execute(step); } catch (error) { infrastructureError ??= error; }
    }
  }
  for (const result of state.results.filter(result => ['passed', 'reused'].includes(result.status))) {
    if (!verified(result.stdout) || !verified(result.stderr) || !verified(result.receipt)) {
      result.status = 'failed'; result.error = 'Owner evidence changed before final verification';
    }
  }
  state.status = state.results.every(result => ['passed', 'reused'].includes(result.status)) ? 'passed' : 'failed';
  if (infrastructureError) state.status = 'failed';
  if (options.snapshot() !== state.snapshot) state.status = 'invalidated';
  state.completedAt = new Date().toISOString(); persist();
  if (infrastructureError) throw infrastructureError;
}

export async function runNativeCommand(step: NativeStep, directory: string, result: NativeResult, context: {
  root: string; planDirectory: string; runId: string; artifact: string; session: string; persist: () => void;
}): Promise<number> {
  const runtime = step.command.runtime === 'bun' ? process.execPath : Bun.which(step.command.runtime);
  if (!runtime) throw new Error(`Missing runtime: ${step.command.runtime}`);
  const script = path.resolve(context.planDirectory, step.command.script);
  const expand = (value: string) => value.replaceAll('{output}', directory).replaceAll('{session}', context.session).replaceAll('{artifact}', context.artifact);
  const args = [...(step.command.runtime === 'pwsh' ? ['-NoProfile', '-NonInteractive', '-File'] : []), script, ...(step.command.args ?? []).map(expand)];
  const stdout = path.join(directory, 'stdout.log'), stderr = path.join(directory, 'stderr.log');
  const out = fs.openSync(stdout, 'wx'); let err: number | undefined;
  try {
    err = fs.openSync(stderr, 'wx');
    const child = Bun.spawn([runtime, ...args], { cwd: context.root, stdin: 'ignore', stdout: out, stderr: err,
      env: { ...process.env, MEO_ACCEPTANCE_OUTPUT: directory, MEO_ACCEPTANCE_SESSION: context.session,
        MEO_ACCEPTANCE_RUN_ID: context.runId, MEO_ACCEPTANCE_ARTIFACT: context.artifact } });
    result.childPid = child.pid;
    try { context.persist(); } catch (error) { child.kill(); await child.exited; throw error; }
    const timeout = setTimeout(() => child.kill(), step.timeoutSeconds * 1000);
    try { return await child.exited; } finally { clearTimeout(timeout); }
  } finally {
    fs.closeSync(out); result.stdout = proof(stdout);
    if (err !== undefined) { fs.closeSync(err); result.stderr = proof(stderr); }
  }
}

async function checkSyntax(plan: NativePlan, planDirectory: string, planFile: string): Promise<void> {
  for (const step of plan.steps) {
    const script = path.resolve(planDirectory, step.command.script);
    if (step.command.runtime === 'bun') {
      new Bun.Transpiler({ loader: script.endsWith('.tsx') ? 'tsx' : script.endsWith('.ts') ? 'ts' : 'js' }).transformSync(fs.readFileSync(script, 'utf8'));
    } else if (step.command.runtime === 'node') {
      const node = Bun.which('node'); if (!node) throw new Error('Missing Node runtime');
      const child = Bun.spawn([node, '--check', script], { stdout: 'pipe', stderr: 'pipe' });
      const error = await new Response(child.stderr).text();
      if (await child.exited !== 0) throw new Error(`Native owner syntax failed: ${step.id}: ${error}`);
    }
  }
  if (plan.steps.some(step => step.command.runtime === 'pwsh')) {
    const pwsh = Bun.which('pwsh'); if (!pwsh) throw new Error('Missing PowerShell runtime');
    const child = Bun.spawn([pwsh, '-NoProfile', '-NonInteractive', '-File', path.join(import.meta.dir, 'native-acceptance-syntax.ps1'), '-PlanPath', planFile], { stdout: 'pipe', stderr: 'pipe' });
    const error = await new Response(child.stderr).text();
    if (await child.exited !== 0) throw new Error(`Native PowerShell syntax failed: ${error}`);
  }
}

async function main(): Promise<void> {
  const options = new Map<string, string>(); const flags = new Set<string>();
  for (const arg of process.argv.slice(2)) {
    if (['--help', '--dry-run', '--confirm-long-run', '--same-environment'].includes(arg)) { flags.add(arg); continue; }
    const match = /^--(plan|output|resume|dispositions)=(.+)$/.exec(arg);
    if (!match || options.has(match[1]!)) throw new Error(`Unknown or duplicate option: ${arg}`); options.set(match[1]!, match[2]!);
  }
  if (flags.has('--help') || !options.size && !flags.size) {
    console.log('bun run acceptance:native -- --plan=<json> --output=<new-directory> [--dry-run | --confirm-long-run] [--resume=<state.json> --same-environment --dispositions=<json>]'); return;
  }
  if (!options.has('plan') || !options.has('output')) throw new Error('A plan and fresh output directory are required.');
  const root = process.cwd(), planFile = path.resolve(options.get('plan')!), planDirectory = path.dirname(planFile);
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as NativePlan; validateNativePlan(plan);
  await checkSyntax(plan, planDirectory, planFile);
  if (flags.has('--dry-run')) {
    console.log(JSON.stringify({ environment: plan.environment, steps: plan.steps.map(step => ({ id: step.id, kind: step.kind, dependsOn: step.dependsOn, requires: step.requires })), scope: 'Syntax and plan only; no native owner ran.' }, null, 2)); return;
  }
  if (!flags.has('--confirm-long-run')) throw new Error('Native acceptance requires current-task authorization and --confirm-long-run.');
  if (options.has('resume') && !flags.has('--same-environment')) throw new Error('Resume requires verified --same-environment.');
  const artifact = path.resolve(planDirectory, plan.artifact.file);
  if (proof(artifact).sha256 !== plan.artifact.sha256) throw new Error('VSIX identity mismatch.');
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Freeze a clean candidate before native acceptance.');
  const directory = path.resolve(options.get('output')!); if (fs.existsSync(directory)) throw new Error('Preserve earlier attempts; choose a fresh output directory.');
  const lockFile = path.join(root, '.local', 'native-acceptance.lock'); fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const lock = fs.openSync(lockFile, 'wx'), runId = randomUUID();
  try {
    // Acquire before hashing dependencies so a second invocation cannot disturb an active measurement.
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, runId, directory }));
    const snapshot = () => digest(workflowFingerprint(root, plan.environment.runtimes.map(file => path.resolve(planDirectory, file)), undefined,
      [planFile, artifact, ...plan.inputs.map(file => path.resolve(planDirectory, file)), ...plan.steps.map(step => path.resolve(planDirectory, step.command.script))]) + artifactFingerprint(root));
    const identity = snapshot(), planHash = digest(fs.readFileSync(planFile));
    const priorFile = options.get('resume') ? path.resolve(options.get('resume')!) : undefined;
    const priorBytes = priorFile ? fs.readFileSync(priorFile) : undefined;
    const previous = priorBytes ? { file: priorFile!, state: JSON.parse(priorBytes.toString()) as NativeState } : undefined;
    const dispositions = options.get('dispositions') ? JSON.parse(fs.readFileSync(options.get('dispositions')!, 'utf8')) as Dispositions : undefined;
    if (previous) validateNativeResume(previous.state, identity, planHash, digest(priorBytes!), dispositions);
    const state: NativeState = { schemaVersion: 1, runId, pid: process.pid, snapshot: identity, planHash,
      artifactSha256: plan.artifact.sha256, environment: plan.environment, status: 'running', startedAt: new Date().toISOString(), results: [] };
    fs.mkdirSync(directory, { recursive: true });
    const persist = () => {
      saveWorkflowState(directory, 'state.json', state);
      console.log(`${state.runId}: ${state.status}; ${state.results.at(-1)?.id ?? 'starting'} ${state.results.at(-1)?.status ?? ''}`);
    };
    persist();
    await executeNativePlan({ plan, state, directory, previous, persist, snapshot,
      run: (step, output, result) => runNativeCommand(step, output, result, { root, planDirectory, runId: state.runId, artifact, session: directory, persist }) });
    if (state.status !== 'passed') process.exitCode = 1;
  } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
