import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spyOn } from 'bun:test';
import { join } from 'node:path';
import { digest, executeWorkflow, expandTestCommand, prepareWorkflow, readResumeReport, saveReport,
  type TaskResult, type WorkflowReport } from './test-workflow-execution';
import { hashPaths } from './test-workflow-snapshot';
import type { TestWorkflowPlan } from './test-workflow-policy';
import { runCommand } from './test-workflow';

mkdirSync(join(process.cwd(), '.local'), { recursive: true });
const root = mkdtempSync(join(process.cwd(), '.local', 'workflow-contract-'));
try {
  const scripts = { 'test:unit': 'bun scripts/test-first.ts && bun run test:nested',
    'test:nested': 'bun scripts/test-second.ts --sampled --limit=8' };
  assert.deepEqual(expandTestCommand({ args: ['run', 'test:unit'], env: { MEO_SAMPLE: '8' } }, scripts), [
    { args: ['scripts/test-first.ts'], env: { MEO_SAMPLE: '8' } },
    { args: ['scripts/test-second.ts', '--sampled', '--limit=8'], env: { MEO_SAMPLE: '8' } }
  ]);
  assert.throws(() => expandTestCommand({ args: ['run', 'test:a'] }, { 'test:a': 'bun run test:a' }), /Cyclic/);
  assert.throws(() => expandTestCommand({ args: ['run', 'test:a'] }, { 'test:a': 'bun scripts/a.ts || true' }), /Unsupported/);
  assert.throws(() => expandTestCommand({ args: ['run', 'test:a'] }, {}), /Missing/);
  assert.deepEqual(expandTestCommand({ args: ['run', 'build'] }, {}), [{ args: ['run', 'build'] }]);

  const plan: TestWorkflowPlan = { tier: 'release', title: 'fixture', expectedDuration: 'seconds', longRunning: true,
    stages: [
      { title: 'build', commands: [{ args: ['run', 'build'] }] },
      { title: 'unit', maxConcurrency: 2, commands: [{ args: ['run', 'test:unit'] }, { args: ['scripts/test-third.ts'] }] },
      { title: 'browser', commands: [{ args: ['scripts/test-fourth.ts'] }] },
      { title: 'package', commands: [{ args: ['run', 'package:check'] }] }
    ] };
  const stages = prepareWorkflow(plan, scripts);
  assert.throws(() => prepareWorkflow({ ...plan, stages: [{ ...plan.stages[0]!, maxConcurrency: 0 }] }, scripts), /Invalid stage/);
  const createReport = (): WorkflowReport => ({ schemaVersion: 1, pid: process.pid, title: 'fixture',
    fingerprint: 'input', planHash: digest(JSON.stringify(stages)), status: 'running',
    startedAt: new Date().toISOString(), tasks: [], stages: [] });
  const nativeRename = fs.renameSync;
  for (const code of ['EPERM', 'EBUSY']) {
    const directory = join(root, `sharing-lock-${code}`);
    let attempts = 0;
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (++attempts <= 2) throw Object.assign(new Error('temporary sharing lock'), { code });
      nativeRename(from, to);
    });
    try {
      const report = createReport();
      saveReport(directory, report);
      assert.equal(attempts, 3, 'temporary sharing locks must not abort the workflow');
      assert.deepEqual(JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')), report);
    } finally { rename.mockRestore(); }
  }
  const lockedDirectory = join(root, 'locked-report');
  const originalReport = createReport();
  saveReport(lockedDirectory, originalReport);
  for (const code of ['EPERM', 'ENOENT']) {
    let attempts = 0;
    const locked = Object.assign(new Error('replacement failed'), { code });
    const rename = spyOn(fs, 'renameSync').mockImplementation(() => { attempts++; throw locked; });
    try {
      assert.throws(() => saveReport(lockedDirectory, { ...originalReport, title: 'new report' }), error => error === locked);
      assert.equal(attempts, code === 'EPERM' ? 10 : 1, 'permanent locks are bounded and other errors fail immediately');
      assert.deepEqual(JSON.parse(readFileSync(join(lockedDirectory, 'report.json'), 'utf8')), originalReport,
        'a failed replacement must preserve the previous complete report');
    } finally { rename.mockRestore(); }
  }
  const events: string[] = [];
  const failure = createReport();
  let active = 0;
  let maximum = 0;
  await assert.rejects(executeWorkflow({ stages, report: failure, inputs: () => 'input', artifacts: () => 'artifact', collectFailures: true,
    persist: () => saveReport(join(root, 'failed'), failure), log: () => {}, run: async task => {
      events.push(task.id);
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return task.command.args[0] === 'scripts/test-first.ts' ? 1 : 0;
    } }), /1 test command/);
  assert.equal(maximum, 2);
  assert.equal(failure.status, 'failed');
  assert.equal(events.length, stages.flatMap(stage => stage.groups.flat()).length,
    'A test failure must not hide the chain tail, later browser stage or package result');
  assert.ok(events.indexOf('2-1-1') < events.indexOf('2-1-2'), 'Keep ordered task groups ordered');
  assert.throws(() => readResumeReport(join(root, 'failed/report.json'), 'input', failure.planHash), /known failure/);

  const buildFailure = createReport();
  await assert.rejects(executeWorkflow({ stages, report: buildFailure, inputs: () => 'input', artifacts: () => 'artifact',
    persist: () => {}, log: () => {}, run: async () => 1 }), /Production build failed/);
  assert.equal(buildFailure.tasks.length, 1, 'Failed build blocks dependent tests');
  const blockedSupplement = createReport();
  const supplementStages = prepareWorkflow({ ...plan, stages: [
    { title: 'census', commands: [{ args: ['scripts/test-first.ts'] }] },
    { title: 'font sweep', requiresPassed: true, commands: [{ args: ['scripts/test-font.ts'] }] }
  ] }, {});
  await assert.rejects(executeWorkflow({ stages: supplementStages, report: blockedSupplement, inputs: () => 'input', artifacts: () => 'artifact',
    collectFailures: true, persist: () => {}, log: () => {}, run: async () => 1 }), /font sweep was not started/);
  assert.equal(blockedSupplement.tasks.length, 1, 'Long supplements stay blocked after a failed full census');
  const shortFailure = createReport();
  await assert.rejects(executeWorkflow({ stages, report: shortFailure, inputs: () => 'input', artifacts: () => 'artifact',
    persist: () => {}, log: () => {}, run: async task => task.id === '2-1-1' ? 1 : 0 }), /unit failed/);
  assert.ok(!shortFailure.tasks.some(task => task.id === '2-1-2' || task.id === '3-1-1'),
    'Short repair workflows stop rather than launching remaining long work');

  const evidence = join(root, 'evidence.log');
  writeFileSync(evidence, 'original evidence');
  const evidenceFields = { stdout: evidence, stderr: evidence,
    stdoutHash: digest(readFileSync(evidence)), stderrHash: digest(readFileSync(evidence)) };
  const duplicatePlan: TestWorkflowPlan = { ...plan, stages: [
    plan.stages[0]!,
    { title: 'overlapping packs', maxConcurrency: 3, commands: [
      { args: ['scripts/test-duplicate.ts'], env: { A: '1', B: '2' } },
      { args: ['scripts/test-duplicate.ts'], env: { B: '2', A: '1' } },
      { args: ['scripts/test-duplicate.ts', '--different'] }
    ] },
    { title: 'supplement preflight', commands: [{ args: ['scripts/test-duplicate.ts'], env: { A: '1', B: '2' } }] }
  ] };
  for (const exitCode of [0, 1]) {
    let calls = 0;
    const report = createReport();
    const execute = executeWorkflow({ stages: prepareWorkflow(duplicatePlan, {}), report,
      inputs: () => 'input', artifacts: () => 'artifact', collectFailures: true, deduplicate: true,
      persist: () => {}, log: () => {}, run: async (task, result) => {
        Object.assign(result, evidenceFields);
        if (!task.reusable) return 0;
        calls++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return exitCode;
      } });
    if (exitCode) await assert.rejects(execute, /test command\(s\) failed/); else await execute;
    assert.equal(calls, 2, 'Identical concurrent and later invocations share execution; different arguments execute');
    assert.equal(report.tasks.length, 5, 'Every logical coverage item retains a receipt');
    assert.equal(report.tasks.filter(task => task.evidence?.startsWith('current#')).length, 2);
    assert.equal(report.status, exitCode ? 'failed' : 'passed', 'A failed duplicate cannot be retried to green');
  }
  const resourcePlan: TestWorkflowPlan = { ...plan, stages: [{ title: 'resources', maxConcurrency: 3,
    commands: ['a', 'b', 'c', 'd'].map(name => ({ args: [`scripts/test-${name}.ts`] })) }] };
  const resourceStages = prepareWorkflow(resourcePlan, {}, {
    'scripts/test-a.ts': 'process', 'scripts/test-b.ts': 'exclusive', 'scripts/test-c.ts': 'process'
  });
  assert.equal(resourceStages[0]!.groups[3]![0]!.resource, 'exclusive', 'Unknown resources stay exclusive');
  let running = 0;
  let browserRunning = false;
  await executeWorkflow({ stages: resourceStages, report: createReport(), inputs: () => 'input', artifacts: () => 'artifact',
    persist: () => {}, log: () => {}, run: async task => {
      assert.equal(browserRunning, false, 'Other tasks cannot run while an exclusive test owns resources');
      if (task.resource === 'exclusive') { assert.equal(running, 0); browserRunning = true; }
      running++;
      await new Promise(resolve => setTimeout(resolve, 5));
      running--;
      browserRunning = false;
      return 0;
    } });
  const previous = createReport();
  previous.status = 'passed'; previous.artifactHash = 'artifact';
  previous.tasks = stages.flatMap(stage => stage.groups.flat()).map(task => ({
    id: task.id, status: 'passed', startedAt: previous.startedAt, exitCode: 0, ...evidenceFields
  }));
  saveReport(join(root, 'previous'), previous);
  const priorPath = join(root, 'previous/report.json');
  const priorBytes = readFileSync(priorPath);
  assert.throws(() => readResumeReport(priorPath, 'other', previous.planHash), /changed/);
  assert.throws(() => readResumeReport(priorPath, 'input', 'other'), /changed/);
  assert.equal(readResumeReport(priorPath, 'input', previous.planHash).status, 'passed');
  const resumed = createReport();
  const rerun: string[] = [];
  await executeWorkflow({ stages, report: resumed, inputs: () => 'input', artifacts: () => 'artifact',
    previous: { report: previous, path: priorPath }, persist: () => {}, log: () => {},
    run: async task => { rerun.push(task.id); return 0; } });
  assert.equal(resumed.status, 'passed');
  assert.deepEqual(rerun, ['1-1-1', '4-1-1'], 'Build and package checks must execute again');
  assert.equal(resumed.tasks.filter(task => task.status === 'reused').length, 4);
  assert.deepEqual(readFileSync(priorPath), priorBytes, 'Resume must not rewrite original evidence');

  const interruptedTask = previous.tasks[2]!;
  interruptedTask.status = 'running';
  const resumedPartial = createReport();
  const partialEvents: string[] = [];
  await executeWorkflow({ stages, report: resumedPartial, inputs: () => 'input', artifacts: () => 'artifact',
    previous: { report: previous, path: priorPath }, persist: () => {}, log: () => {},
    run: async task => { partialEvents.push(task.id); return 0; } });
  assert.ok(partialEvents.includes(interruptedTask.id), 'Incomplete task is never counted as passed');

  const differentArtifact = createReport();
  let executions = 0;
  await executeWorkflow({ stages, report: differentArtifact, inputs: () => 'input', artifacts: () => 'new-artifact',
    previous: { report: previous, path: priorPath }, persist: () => {}, log: () => {},
    run: async () => { executions++; return 0; } });
  assert.equal(executions, previous.tasks.length, 'Changed build must invalidate every reused case');

  writeFileSync(evidence, 'changed');
  await assert.rejects(executeWorkflow({ stages, report: createReport(), inputs: () => 'input', artifacts: () => 'artifact',
    previous: { report: previous, path: priorPath }, persist: () => {}, log: () => {}, run: async () => 0 }), /changed evidence/);
  const modifiedInput = createReport();
  await assert.rejects(executeWorkflow({ stages, report: modifiedInput, inputs: () => 'changed', artifacts: () => 'artifact',
    persist: () => {}, log: () => {}, run: async () => 0 }), /Inputs or built artifacts/);
  assert.equal(modifiedInput.status, 'invalidated');
  const changedArtifact = createReport();
  let artifactReads = 0;
  await assert.rejects(executeWorkflow({ stages, report: changedArtifact, inputs: () => 'input',
    artifacts: () => ++artifactReads === 1 ? 'artifact' : 'changed',
    persist: () => {}, log: () => {}, run: async () => 0 }), /Inputs or built artifacts/);

  const live = createReport();
  saveReport(join(root, 'live'), live);
  assert.throws(() => readResumeReport(join(root, 'live/report.json'), 'input', live.planHash), /still be active/);
  const fixtureDir = join(root, 'inputs');
  mkdirSync(fixtureDir);
  const initial = hashPaths([fixtureDir]);
  writeFileSync(join(fixtureDir, 'helper.ts'), 'version one');
  const added = hashPaths([fixtureDir]);
  assert.notEqual(initial, added);
  writeFileSync(join(fixtureDir, 'helper.ts'), 'version two');
  assert.notEqual(added, hashPaths([fixtureDir]));
  const graph = join(root, 'dependency-graph');
  const sharedDependency = join(graph, 'package');
  mkdirSync(sharedDependency, { recursive: true });
  writeFileSync(join(sharedDependency, 'runtime.js'), 'one');
  for (const name of ['first', 'second']) symlinkSync(sharedDependency, join(graph, name), 'junction');
  const metrics = { files: 0, bytes: 0, directories: 0, cacheHits: 0 };
  const graphHash = hashPaths([graph], metrics);
  assert.equal(metrics.files, 1, 'Shared dependency bytes must be read once per snapshot');
  assert.ok(metrics.cacheHits >= 2);
  writeFileSync(join(sharedDependency, 'runtime.js'), 'two');
  assert.notEqual(hashPaths([graph]), graphHash, 'A later snapshot must reread changed dependency bytes of the same length');
  const beforeLinkRemoval = hashPaths([graph]);
  unlinkSync(join(graph, 'second'));
  assert.notEqual(hashPaths([graph]), beforeLinkRemoval, 'Logical dependency edges remain part of the identity');
  symlinkSync(graph, join(sharedDependency, 'cycle'), 'junction');
  assert.throws(() => hashPaths([graph]), /Circular/);
  unlinkSync(join(sharedDependency, 'cycle'));
  const collisionA = join(root, 'file-boundaries-a');
  const collisionB = join(root, 'file-boundaries-b');
  writeFileSync(collisionA, 'a'); writeFileSync(collisionB, 'bc');
  const boundaryHash = hashPaths([collisionA, collisionB]);
  writeFileSync(collisionA, 'ab'); writeFileSync(collisionB, 'c');
  assert.notEqual(hashPaths([collisionA, collisionB]), boundaryHash, 'File boundaries cannot be confused with concatenated bytes');
  const childScript = join(root, 'child.ts');
  writeFileSync(childScript, 'console.log("stdout witness"); console.error("stderr witness"); process.exitCode = 7;');
  const result: TaskResult = { id: 'child', status: 'running', startedAt: new Date().toISOString() };
  assert.equal(await runCommand(root, { id: 'child', command: { args: [childScript] }, reusable: false }, result), 7);
  assert.match(readFileSync(result.stdout!, 'utf8'), /stdout witness/);
  assert.match(readFileSync(result.stderr!, 'utf8'), /stderr witness/);
  assert.equal(result.stdoutHash, digest(readFileSync(result.stdout!)));
  assert.equal(result.stderrHash, digest(readFileSync(result.stderr!)));
  assert.ok(Number.isInteger(result.childPid));
  console.log('Workflow execution checks passed: complete census, build dependency, bounded concurrency, resume and invalidation.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
