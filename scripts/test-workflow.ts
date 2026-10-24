import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createTestWorkflowPlan, parseTestWorkflowRequest, validateTestWorkflowAuthorization } from './test-workflow-policy';
import { digest, executeWorkflow, prepareWorkflow, readResumeReport, saveReport,
  commandIdentity, type TaskResult, type WorkflowReport, type WorkflowTask } from './test-workflow-execution';
import { artifactFingerprint, workflowFingerprint } from './test-workflow-snapshot';

const help = `MEO Enhanced test workflow

Usage:
  bun scripts/test-workflow.ts ui-light [--dry-run]
  bun scripts/test-workflow.ts quick [--dry-run]
  bun scripts/test-workflow.ts targeted <history|table|rendered|appearance|search|viewport|changes> [--dry-run]
  bun scripts/test-workflow.ts targeted uat <document> [--dry-run]
  bun scripts/test-workflow.ts release [document] --confirm-long-run [--dry-run]
  bun scripts/test-workflow.ts release --confirm-long-run --resume=<report.json> --same-environment
  bun scripts/test-workflow.ts endurance <document> --confirm-long-run [--dry-run]
  bun scripts/test-workflow.ts large-document <document> --confirm-long-run [--dry-run]

Dry runs list every command without building or opening a browser.
Reports and separate command logs are written to .local/test-runs/<run-id>/.
Resume is release-only and rejects changed inputs or known failures. Before using
--same-environment, verify unchanged OS preferences, fonts and display conditions;
these external inputs cannot all be inferred from source hashes.
Light UI requires separate visual and functional smoke evidence.
Long-running workflows still require explicit authorization in the current task.`;

export async function runCommand(directory: string, task: WorkflowTask, result: TaskResult, persist = () => {}): Promise<number> {
  result.stdout = join(directory, `${task.id}.stdout.log`);
  result.stderr = join(directory, `${task.id}.stderr.log`);
  const output = openSync(result.stdout, 'wx');
  let error: number | undefined;
  try {
    error = openSync(result.stderr, 'wx');
    const child = Bun.spawn([process.execPath, ...task.command.args], {
      cwd: process.cwd(), env: { ...process.env, ...task.command.env },
      stdin: 'inherit', stdout: 'pipe', stderr: 'pipe'
    });
    result.childPid = child.pid;
    try { persist(); } catch (failure) { child.kill(); await child.exited; throw failure; }
    const copy = async (stream: ReadableStream<Uint8Array>, fd: number, destination: NodeJS.WriteStream): Promise<void> => {
      for await (const chunk of stream) {
        writeFileSync(fd, chunk);
        destination.write(chunk);
      }
    };
    const drain = (stream: ReadableStream<Uint8Array>, fd: number, destination: NodeJS.WriteStream) =>
      copy(stream, fd, destination).catch(failure => { child.kill(); throw failure; });
    const outcomes = await Promise.allSettled([
      drain(child.stdout, output, process.stdout), drain(child.stderr, error, process.stderr), child.exited
    ]);
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const exitCode = outcomes[2].status === 'fulfilled' ? outcomes[2].value as number : 1;
    return exitCode;
  } finally {
    closeSync(output);
    if (error !== undefined) closeSync(error);
    result.stdoutHash = digest(readFileSync(result.stdout));
    if (error !== undefined) result.stderrHash = digest(readFileSync(result.stderr));
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const preparationStarted = performance.now();
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(help); return; }
  const resume = argv.find(value => value.startsWith('--resume='))?.slice('--resume='.length);
  const request = parseTestWorkflowRequest(argv.filter(value => !value.startsWith('--resume=') && value !== '--same-environment'));
  const plan = createTestWorkflowPlan(request);
  validateTestWorkflowAuthorization(plan, request.confirmLongRun, request.dryRun);
  if (request.documentPath && !request.dryRun) readFileSync(resolve(request.documentPath));
  if (resume !== undefined && (!resume || plan.tier !== 'release' || !argv.includes('--same-environment'))) {
    throw new Error('Resume requires release, --resume=<report.json> and verified --same-environment.');
  }
  const root = process.cwd();
  const { checkTestInventory } = await import('./check-test-inventory');
  const resources = await checkTestInventory(root);
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
  const stages = prepareWorkflow(plan, scripts, { ...resources, 'run typecheck': 'process', 'run architecture:check': 'process' });
  const planHash = digest(JSON.stringify(stages));
  console.log(`${plan.title} (${plan.expectedDuration})`);
  for (const stage of stages) {
    console.log(`  ${stage.title} (up to ${stage.maxConcurrency} groups)`);
    for (const task of stage.groups.flat()) console.log(`    ${task.id}. [${task.resource}] bun ${task.command.args.join(' ')}${task.command.env ? ' ' + JSON.stringify(task.command.env) : ''}`);
  }
  if (plan.tier === 'release') {
    const commands = stages.flatMap(stage => stage.groups.flat()).filter(task => task.reusable);
    console.log(`Test coverage: ${commands.length} logical invocations, ${new Set(commands.map(task => commandIdentity(task.command))).size} distinct executions; exact duplicates reference the first result.`);
  }
  if (request.dryRun) { console.log('Dry run only; no tests were executed.'); return; }

  let browserPath = '';
  if (plan.tier === 'release') {
    const { findBrowserExecutable } = await import('./browser-test-helpers');
    browserPath = findBrowserExecutable();
  }
  const fingerprintTimings: NonNullable<WorkflowReport['fingerprintTimings']> = [];
  let phase: 'before' | 'after' = 'before';
  const inputs = () => plan.tier === 'release' ? workflowFingerprint(root, browserPath, (section, seconds, metrics) => {
    fingerprintTimings.push({ phase, section, seconds, ...metrics });
    console.log(`Fingerprint ${phase}: ${section} ${seconds.toFixed(1)}s${metrics ? ` (${metrics.files} physical files, ${metrics.cacheHits} shared nodes)` : ''}`);
  }, request.documentPath ? [request.documentPath] : []) : '';
  const fingerprint = inputs();
  phase = 'after';
  const previous = resume ? { path: resolve(resume), report: readResumeReport(resolve(resume), fingerprint, planHash) } : undefined;
  const directory = join(root, '.local', 'test-runs', `${Date.now()}-${randomUUID().slice(0, 8)}`);
  mkdirSync(directory, { recursive: true });
  const report: WorkflowReport = { schemaVersion: 1, pid: process.pid, title: plan.title, fingerprint, planHash,
    candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    status: 'running', startedAt, preparationSeconds: (performance.now() - preparationStarted) / 1000,
    fingerprintTimings, tasks: [], stages: [] };
  const persist = () => saveReport(directory, report);
  persist();
  console.log(`Report: ${join(directory, 'report.json')}`);
  try {
    await executeWorkflow({ stages, report, previous, persist, inputs,
      collectFailures: plan.tier === 'release',
      deduplicate: plan.tier === 'release',
      artifacts: () => artifactFingerprint(root), run: (task, result) => runCommand(directory, task, result, persist),
      log: message => console.log(message) });
    console.log(`\n${plan.title} passed in ${report.seconds!.toFixed(1)}s`);
  } finally {
    console.log(`Result: ${report.status}; report: ${join(directory, 'report.json')}`);
    console.log(`Preparation: ${report.preparationSeconds?.toFixed(1)}s; final verification: ${report.verificationSeconds?.toFixed(1) ?? 'incomplete'}s; total: ${report.seconds?.toFixed(1) ?? 'incomplete'}s`);
    console.log(`Coverage: ${report.tasks.filter(task => task.status === 'passed').length} executed passes, ${report.tasks.filter(task => task.status === 'reused').length} evidence references, ${report.tasks.filter(task => task.status === 'failed').length} failures`);
    const slowest = report.tasks.filter(task => task.status !== 'reused' && task.seconds !== undefined)
      .sort((a, b) => b.seconds! - a.seconds!).slice(0, 10);
    for (const task of slowest) console.log(`  ${task.id}: ${task.seconds!.toFixed(1)}s (${task.status}) ${task.command?.args.join(' ') ?? ''}`);
  }
  if (plan.tier === 'ui-light') console.log('Build evidence only. Complete Chinese/English, light/dark visual and functional smoke separately.');
}

if (import.meta.main) {
  try { await main(); } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
