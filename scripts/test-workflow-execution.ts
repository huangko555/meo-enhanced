import { createHash } from 'node:crypto';
import fs, { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestWorkflowCommand, TestWorkflowPlan } from './test-workflow-policy';

export type WorkflowTask = {
  id: string;
  command: TestWorkflowCommand;
  reusable: boolean;
  resource?: 'process' | 'exclusive';
};
export type WorkflowStage = {
  title: string;
  maxConcurrency: number;
  prerequisite: boolean;
  requiresPassed?: boolean;
  groups: WorkflowTask[][];
};
export type TaskResult = {
  id: string;
  command?: TestWorkflowCommand;
  status: 'running' | 'passed' | 'failed' | 'reused';
  startedAt: string;
  seconds?: number;
  exitCode?: number;
  childPid?: number;
  error?: string;
  stdout?: string;
  stderr?: string;
  stdoutHash?: string;
  stderrHash?: string;
  evidence?: string;
};
export type WorkflowReport = {
  schemaVersion: 1;
  pid: number;
  title: string;
  fingerprint: string;
  candidate?: string;
  planHash: string;
  artifactHash?: string;
  status: 'running' | 'passed' | 'failed' | 'invalidated';
  startedAt: string;
  completedAt?: string;
  preparationSeconds?: number;
  verificationSeconds?: number;
  fingerprintTimings?: Array<{ phase: 'before' | 'after'; section: string; seconds: number; files?: number; bytes?: number; directories?: number; cacheHits?: number }>;
  seconds?: number;
  tasks: TaskResult[];
  stages: Array<{ title: string; seconds: number }>;
};

export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function commandIdentity(command: TestWorkflowCommand): string {
  return JSON.stringify([command.args, Object.entries(command.env ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}

function verifyEvidence(prior: TaskResult): void {
  if (!prior.stdout || !prior.stderr || !prior.stdoutHash || !prior.stderrHash
    || digest(readFileSync(prior.stdout)) !== prior.stdoutHash
    || digest(readFileSync(prior.stderr)) !== prior.stderrHash) {
    throw new Error(`Missing or changed evidence for ${prior.id}; start a fresh run.`);
  }
}

// Only test aliases are expanded. Build/typecheck aliases retain their shell
// prerequisites; unknown test-shell syntax must never silently drop coverage.
export function expandTestCommand(
  command: TestWorkflowCommand,
  scripts: Record<string, string>,
  ancestors: string[] = []
): TestWorkflowCommand[] {
  const [verb, name] = command.args;
  if (verb !== 'run' || !name?.startsWith('test:')) return [command];
  if (command.args.length !== 2) throw new Error(`Test alias arguments cannot be expanded: ${name}`);
  if (ancestors.includes(name)) throw new Error(`Cyclic test alias: ${[...ancestors, name].join(' -> ')}`);
  const body = scripts[name];
  if (!body) throw new Error(`Missing test alias: ${name}`);
  return body.split('&&').flatMap(part => {
    const text = part.trim();
    if (!/^bun (?:run [\w:-]+|scripts\/[\w./-]+\.(?:ts|mjs|cjs)(?: [\w=./:-]+)*)$/.test(text)) {
      throw new Error(`Unsupported test command in ${name}: ${text}`);
    }
    return expandTestCommand({ ...command, args: text.slice(4).split(' ') }, scripts, [...ancestors, name]);
  });
}

export function prepareWorkflow(plan: TestWorkflowPlan, scripts: Record<string, string>, resources?: Record<string, 'process' | 'exclusive'>): WorkflowStage[] {
  for (const stage of plan.stages) {
    if (!stage.commands.length || !Number.isInteger(stage.maxConcurrency ?? 1) || (stage.maxConcurrency ?? 1) < 1) {
      throw new Error(`Invalid stage scheduling: ${stage.title}`);
    }
  }
  return plan.stages.map((stage, stageIndex) => ({
    title: stage.title,
    maxConcurrency: stage.maxConcurrency ?? 1,
    prerequisite: stage.commands.some(command => command.args.join(' ') === 'run build'),
    ...(stage.requiresPassed ? { requiresPassed: true } : {}),
    groups: stage.commands.map((command, groupIndex) =>
      expandTestCommand(command, scripts).map((leaf, leafIndex) => ({
        id: `${stageIndex + 1}-${groupIndex + 1}-${leafIndex + 1}`,
        command: leaf,
        reusable: leaf.args[0]?.startsWith('scripts/test-') === true,
        ...(resources ? { resource: resources[leaf.args[0]!] ?? resources[leaf.args.join(' ')] ?? 'exclusive' } : {})
      })))
  }));
}

export function readResumeReport(path: string, fingerprint: string, planHash: string): WorkflowReport {
  const report = JSON.parse(readFileSync(path, 'utf8')) as WorkflowReport;
  if (report.schemaVersion !== 1 || report.fingerprint !== fingerprint || report.planHash !== planHash
    || !Array.isArray(report.tasks) || !Array.isArray(report.stages)) {
    throw new Error('Cannot resume: source, dependencies, runtime, environment or test plan changed. Start a fresh run.');
  }
  if (!['running', 'passed'].includes(report.status)
    || report.tasks.some(task => task.status === 'failed')) {
    throw new Error('Cannot resume a known failure. Diagnose it and start a fresh run; retrying to green is not release evidence.');
  }
  const assertStopped = (pid: number): void => {
    let alive = true;
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('The previous runner may still be active. Do not start a second run.');
  };
  if (report.status === 'running') {
    assertStopped(report.pid);
    for (const task of report.tasks) {
      if (task.status === 'running' && task.childPid !== undefined) assertStopped(task.childPid);
    }
  }
  return report;
}

export function saveReport(directory: string, report: WorkflowReport): void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'report.json');
  writeFileSync(`${path}.tmp`, JSON.stringify(report, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(`${path}.tmp`, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 9 || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
      // Windows scanners can briefly hold either file during an atomic replace.
      // Retain the previous report and fail normally if the lock does not clear.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

export async function executeWorkflow(options: {
  stages: WorkflowStage[];
  report: WorkflowReport;
  previous?: { report: WorkflowReport; path: string };
  persist: () => void;
  run: (task: WorkflowTask, result: TaskResult) => Promise<number>;
  artifacts: () => string;
  inputs: () => string;
  log: (message: string) => void;
  collectFailures?: boolean;
  deduplicate?: boolean;
}): Promise<void> {
  const { stages, report, previous, persist, run, artifacts, inputs, log } = options;
  const started = performance.now();
  const executions = new Map<string, Promise<TaskResult>>();
  // Fair reader/writer lease: isolated processes can share capacity, while a
  // browser/desktop measurement runs without competing workflow commands.
  let shared = 0;
  let exclusive = false;
  const queue: Array<{ kind: 'process' | 'exclusive'; resolve: (release: () => void) => void }> = [];
  const pump = () => {
    while (queue.length && !exclusive) {
      if (queue[0]!.kind === 'exclusive' && shared) return;
      const next = queue.shift()!;
      if (next.kind === 'exclusive') exclusive = true; else shared++;
      next.resolve(() => { if (next.kind === 'exclusive') exclusive = false; else shared--; pump(); });
    }
  };
  const acquire = (kind: 'process' | 'exclusive') => new Promise<() => void>(resolve => { queue.push({ kind, resolve }); pump(); });
  try {
    for (const stage of stages) {
      if (stage.requiresPassed && report.tasks.some(task => task.status === 'failed')) {
        throw new Error(`Earlier checks failed; ${stage.title} was not started.`);
      }
      const stageStarted = performance.now();
      log(`\n[stage] ${stage.title}`);
      let nextGroup = 0;
      let stageFailed = false;
      const worker = async (): Promise<void> => {
        while (nextGroup < stage.groups.length) {
          if (stageFailed && !options.collectFailures) return;
          const group = stage.groups[nextGroup++]!;
          for (const task of group) {
            const key = commandIdentity(task.command);
            const existing = options.deduplicate && task.reusable ? executions.get(key) : undefined;
            if (existing) {
              const source = await existing;
              verifyEvidence(source);
              const result: TaskResult = { ...source, id: task.id, command: task.command,
                status: source.status === 'failed' ? 'failed' : 'reused', seconds: 0,
                evidence: `current#${source.id}` };
              report.tasks.push(result);
              stageFailed ||= result.status === 'failed';
              persist();
              log(`[${task.id}] ${result.status.toUpperCase()} ${task.command.args.join(' ')} (${result.evidence})`);
              if (result.error) throw new Error(`Test execution infrastructure failed: ${result.error}`);
              if (result.status === 'failed' && !options.collectFailures) break;
              continue;
            }
            const prior = previous?.report.tasks.find(result => result.id === task.id);
            if (task.reusable && prior && ['passed', 'reused'].includes(prior.status)
              && report.artifactHash && report.artifactHash === previous?.report.artifactHash) {
              verifyEvidence(prior);
              const result: TaskResult = { ...prior, status: 'reused', evidence: `${previous!.path}#${task.id}` };
              report.tasks.push(result);
              if (options.deduplicate && task.reusable) executions.set(key, Promise.resolve(result));
              persist();
              log(`[${task.id}] REUSE ${task.command.args.join(' ')}`);
              continue;
            }
            const result: TaskResult = { id: task.id, command: task.command, status: 'running', startedAt: new Date().toISOString() };
            report.tasks.push(result);
            persist();
            log(`[${task.id}] START ${task.command.args.join(' ')}`);
            const taskStarted = performance.now();
            let settle: (result: TaskResult) => void = () => {};
            if (options.deduplicate && task.reusable) executions.set(key, new Promise(resolve => { settle = resolve; }));
            try {
              const release = await acquire(task.resource ?? 'process');
              try { result.exitCode = await run(task, result); }
              finally { release(); }
              result.status = result.exitCode === 0 ? 'passed' : 'failed';
            } catch (error) {
              result.status = 'failed';
              result.error = error instanceof Error ? error.message : String(error);
            }
            result.seconds = (performance.now() - taskStarted) / 1000;
            settle(result);
            stageFailed ||= result.status === 'failed';
            persist();
            log(`[${task.id}] ${result.status.toUpperCase()} ${task.command.args.join(' ')} (${result.seconds.toFixed(1)}s)`);
            if (result.error) throw new Error(`Test execution infrastructure failed: ${result.error}`);
            if (result.status === 'failed' && !options.collectFailures) break;
          }
        }
      };
      const workers = await Promise.allSettled(Array.from({ length: Math.min(stage.maxConcurrency, stage.groups.length) }, worker));
      const rejected = workers.find(result => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      report.stages.push({ title: stage.title, seconds: (performance.now() - stageStarted) / 1000 });
      log(`${stage.title}: ${report.stages.at(-1)!.seconds.toFixed(1)}s wall time`);
      if (stage.prerequisite) {
        if (stageFailed) throw new Error('Production build failed; dependent tests were not executed.');
        report.artifactHash = artifacts();
      }
      persist();
      if (stageFailed && !options.collectFailures) throw new Error(`${stage.title} failed.`);
    }
    const verificationStarted = performance.now();
    let unchanged: boolean;
    try { unchanged = inputs() === report.fingerprint && (!report.artifactHash || artifacts() === report.artifactHash); }
    finally { report.verificationSeconds = (performance.now() - verificationStarted) / 1000; }
    if (!unchanged) {
      report.status = 'invalidated';
      throw new Error('Inputs or built artifacts changed during verification. Results are diagnostic only.');
    }
    const failed = report.tasks.filter(task => task.status === 'failed');
    if (failed.length) throw new Error(`${failed.length} test command(s) failed: ${failed.map(task => task.id).join(', ')}`);
    const expected = stages.flatMap(stage => stage.groups.flat()).map(task => task.id).sort();
    const completed = report.tasks.filter(task => ['passed', 'reused'].includes(task.status)).map(task => task.id).sort();
    if (JSON.stringify(expected) !== JSON.stringify(completed)) throw new Error('Incomplete test coverage; cannot pass the gate.');
    report.status = 'passed';
  } catch (error) {
    if (report.status !== 'invalidated') report.status = 'failed';
    throw error;
  } finally {
    report.seconds = (report.preparationSeconds ?? 0) + (performance.now() - started) / 1000;
    report.completedAt = new Date().toISOString();
    persist();
  }
}
