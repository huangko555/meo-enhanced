import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyEvidenceReview, createEvidenceItems, type ReuseReview } from './release-acceptance-evidence';
import { digest, type WorkflowReport } from './test-workflow-execution';
import { executeNativePlan, runNativeCommand, validateNativePlan, validateNativeResume, verifyNativeReceipt,
  type NativePlan, type NativeState, type NativeStep } from './native-acceptance';

const root = path.resolve('.local'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'acceptance-contract-'));
try {
  const stdout = path.join(directory, 'old.stdout'), stderr = path.join(directory, 'old.stderr');
  fs.writeFileSync(stdout, 'actual success\n'); fs.writeFileSync(stderr, '');
  const command = { args: ['scripts/test-fixture.ts'], env: { MEO_CASE: 'ordinary' } };
  const pass = { id: 'old-pass', command, status: 'passed' as const, startedAt: '2026-01-01', exitCode: 0,
    stdout, stderr, stdoutHash: digest(fs.readFileSync(stdout)), stderrHash: digest(fs.readFileSync(stderr)) };
  const report: WorkflowReport = { schemaVersion: 1, pid: 1, title: 'Historical failed census', fingerprint: 'old', planHash: 'old',
    candidate: 'old', status: 'failed', startedAt: '2026-01-01', tasks: [pass, { ...pass, id: 'old-fail', status: 'failed', exitCode: 1 }], stages: [] };
  const commands = [{ id: 'first', command }, { id: 'duplicate', command },
    { id: 'different-scale', command: { ...command, args: [...command.args, '--large'] } },
    { id: 'different-environment', command: { ...command, env: { MEO_CASE: 'large' } } }];
  const sources = [{ file: 'historical-report.json', hash: 'report-hash', report }];
  const items = createEvidenceItems(commands, sources);
  assert.equal(items.length, 3); assert.deepEqual(items[0]!.occurrences, ['first', 'duplicate']);
  assert.deepEqual(items.map(item => item.disposition), ['rerun', 'missing', 'missing']);
  const review: ReuseReview = { snapshot: 'current', items: [{ ids: [items[0]!.id], decision: 'reuse',
    sourceReportHash: 'report-hash', productAndBuild: 'unchanged owning module', testAndSharedFixtures: 'fixture changes checked',
    argumentsAndScale: 'same document and exact args', dependenciesAndEnvironment: 'same verified runtimes' }] };
  assert.throws(() => applyEvidenceReview(items, 'changed', review), /different inputs/);
  assert.throws(() => applyEvidenceReview(items, 'current', review), /Unresolved historical failure/);
  review.items[0]!.failures = [{ reportHash: 'report-hash', task: 'old-fail', causeAndResolution: 'Driver fault resolved; replacement owner verified' }];
  applyEvidenceReview(items, 'current', review); assert.equal(items[0]!.disposition, 'reuse');
  assert.equal(report.status, 'failed'); assert.equal(report.tasks[1]!.status, 'failed');
  assert.throws(() => applyEvidenceReview(items, 'current', { ...review, items: [review.items[0]!, review.items[0]!] }), /duplicate/);
  fs.writeFileSync(stdout, 'tampered');
  const changed = createEvidenceItems(commands, sources);
  assert.throws(() => applyEvidenceReview(changed, 'current', review), /verified passing logs/);
  applyEvidenceReview(changed, 'current', { snapshot: 'current', items: [{ ids: changed.map(item => item.id), decision: 'rerun' }] });
  assert.ok(changed.every(item => item.disposition === 'rerun'), 'Rerun choices need no repetitive applicability paperwork');

  const owner = path.join(directory, 'owner.cjs');
  fs.writeFileSync(owner, `const fs=require('node:fs');const p=require('node:path');
    if(process.argv.includes('--fail'))process.exit(3);
    if(process.argv.includes('--hang'))setInterval(()=>{},1000);
    else fs.writeFileSync(p.join(process.env.MEO_ACCEPTANCE_OUTPUT,'result.json'),JSON.stringify({passed:true,capabilities:{'installed-vsix':true,pointer:true},observed:42}));`);
  const step = (id: string, kind: NativeStep['kind'], extra: Partial<NativeStep> = {}): NativeStep => ({ id, kind,
    command: { runtime: 'node', script: owner }, timeoutSeconds: 3, receipt: { file: 'result.json', expect: { observed: 42 } }, ...extra });
  const plan: NativePlan = { schemaVersion: 1, environment: { id: 'isolated-fixture', launch: 'normal', description: 'Test process only; no OS/native acceptance', runtimes: [process.execPath] },
    artifact: { file: 'fixture.vsix', sha256: 'a'.repeat(64) }, inputs: [], steps: [
      step('installed', 'setup', { provides: ['installed-vsix'] }), step('pointer', 'preflight', { provides: ['pointer'] }),
      step('first', 'check', { requires: ['pointer'] }), step('dependent', 'check', { dependsOn: ['first'] }),
      step('independent', 'check'), step('cleanup', 'cleanup') ] };
  validateNativePlan(plan);
  assert.throws(() => validateNativePlan({ ...plan, steps: plan.steps.filter(step => step.id !== 'installed') }), /Installed-VSIX/);
  assert.throws(() => validateNativePlan({ ...plan, steps: [step('check', 'check', { requires: ['scan-codes'] }), step('cleanup', 'cleanup')] }), /Missing preflight/);
  assert.throws(() => validateNativePlan({ ...plan, steps: [step('cleanup', 'cleanup'), ...plan.steps] }), /Cleanup/);
  const makeState = (): NativeState => ({ schemaVersion: 1, runId: 'fixture-run', pid: process.pid, snapshot: 'frozen', planHash: 'plan',
    artifactSha256: plan.artifact.sha256, environment: plan.environment, status: 'running', startedAt: new Date().toISOString(), results: [] });
  const runAttempt = async (name: string, failed?: string, previous?: { file: string; state: NativeState }) => {
    const state = makeState(), output = path.join(directory, name); fs.mkdirSync(output);
    const executed: string[] = [];
    await executeNativePlan({ plan, state, directory: output, previous, persist() {}, snapshot: () => 'frozen',
      run: (task, output, result) => {
        executed.push(task.id);
        return runNativeCommand(task.id === failed ? { ...task, command: { ...task.command, args: ['--fail'] } } : task,
          output, result, { root: process.cwd(), planDirectory: directory, runId: state.runId, artifact: 'fixture.vsix', session: output, persist() {} });
      } });
    return { state, executed };
  };
  const first = await runAttempt('first', 'first');
  assert.equal(first.state.status, 'failed');
  assert.equal(first.state.results.find(result => result.id === 'dependent')!.status, 'blocked');
  assert.ok(first.executed.includes('independent') && first.executed.includes('cleanup'));
  const failedProbe = await runAttempt('failed-probe', 'pointer');
  assert.equal(failedProbe.state.results.find(result => result.id === 'first')!.status, 'blocked');
  assert.ok(failedProbe.executed.includes('independent') && failedProbe.executed.includes('cleanup'));
  assert.throws(() => validateNativeResume(first.state, 'frozen', 'plan', 'old-report'), /Diagnose/);
  validateNativeResume(first.state, 'frozen', 'plan', 'old-report', { reportHash: 'old-report',
    failures: [{ id: 'first', classification: 'driver', cause: 'Injected failure', correction: 'Removed injected failure' }] });
  assert.throws(() => validateNativeResume(first.state, 'changed', 'plan', 'old-report'), /changed/);
  const second = await runAttempt('second', undefined, { file: 'old-state.json', state: first.state });
  assert.equal(second.state.status, 'passed');
  assert.deepEqual(second.executed, ['installed', 'pointer', 'first', 'dependent', 'cleanup']);
  assert.equal(second.state.results.find(result => result.id === 'independent')!.status, 'reused');
  assert.equal(first.state.status, 'failed', 'Historical reports remain unchanged');
  fs.writeFileSync(first.state.results.find(result => result.id === 'independent')!.receipt!.file, '{}');
  const third = await runAttempt('tampered', undefined, { file: 'old-state.json', state: first.state });
  assert.equal(third.state.status, 'failed'); assert.ok(third.executed.includes('cleanup'));

  const unproved = path.join(directory, 'unproved'); fs.mkdirSync(unproved);
  fs.writeFileSync(path.join(unproved, 'result.json'), JSON.stringify({ passed: true }));
  assert.throws(() => verifyNativeReceipt(plan.steps[1]!, unproved), /mismatch|Unproven/);
  const interrupted = makeState();
  assert.throws(() => validateNativeResume(interrupted, 'frozen', 'plan', 'x'), /still active/);
  const timeoutPlan = { ...plan, steps: [plan.steps[0]!, step('timeout', 'check', { timeoutSeconds: 0.1, command: { runtime: 'node', script: owner, args: ['--hang'] } }), plan.steps.at(-1)!] };
  const timeoutState = makeState(); const timeoutOutput = path.join(directory, 'timeout'); fs.mkdirSync(timeoutOutput);
  await executeNativePlan({ plan: timeoutPlan, state: timeoutState, directory: timeoutOutput, persist() {}, snapshot: () => 'changed',
    run: (task, output, result) => runNativeCommand(task, output, result,
      { root: process.cwd(), planDirectory: directory, runId: 'timeout', artifact: 'fixture.vsix', session: timeoutOutput, persist() {} }) });
  assert.equal(timeoutState.status, 'invalidated'); assert.equal(timeoutState.results.at(-1)!.status, 'passed');
  const planFile = path.join(directory, 'plan.json'); fs.writeFileSync(planFile, JSON.stringify(plan));
  const dryOutput = path.join(directory, 'dry-output');
  const dryRun = Bun.spawn([process.execPath, path.resolve('scripts/native-acceptance.ts'), `--plan=${planFile}`, `--output=${dryOutput}`, '--dry-run'], { stdout: 'pipe', stderr: 'pipe' });
  const dryError = await new Response(dryRun.stderr).text();
  assert.equal(await dryRun.exited, 0, dryError); assert.equal(fs.existsSync(dryOutput), false, 'Dry run must not execute owners or prepare a session');
  const badOwner = path.join(directory, 'bad.cjs'); fs.writeFileSync(badOwner, 'function {');
  fs.writeFileSync(planFile, JSON.stringify({ ...plan, steps: plan.steps.map(task => task.id === 'installed'
    ? { ...task, command: { runtime: 'node', script: badOwner } } : task) }));
  const badRun = Bun.spawn([process.execPath, path.resolve('scripts/native-acceptance.ts'), `--plan=${planFile}`, `--output=${dryOutput}`, '--dry-run'], { stdout: 'pipe', stderr: 'pipe' });
  const badError = await new Response(badRun.stderr).text();
  assert.notEqual(await badRun.exited, 0); assert.match(badError, /syntax failed/); assert.equal(fs.existsSync(dryOutput), false);
  const pwsh = Bun.which('pwsh');
  if (pwsh) {
    const psOwner = path.join(directory, 'owner.ps1'); fs.writeFileSync(psOwner, 'param()\nthrow "Parser must not execute this owner"\n');
    const psPlan = { ...plan, steps: plan.steps.map(task => task.id === 'installed'
      ? { ...task, command: { runtime: 'pwsh', script: psOwner } } : task) };
    fs.writeFileSync(planFile, JSON.stringify(psPlan));
    const parse = () => Bun.spawn([pwsh, '-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/native-acceptance-syntax.ps1'), '-PlanPath', planFile], { stdout: 'pipe', stderr: 'pipe' });
    const valid = parse(); const validError = await new Response(valid.stderr).text(); assert.equal(await valid.exited, 0, validError);
    fs.writeFileSync(psOwner, 'function {');
    const invalid = parse(); await new Response(invalid.stderr).text(); assert.notEqual(await invalid.exited, 0);
  }
  console.log('Release evidence: complete coverage identities, explicit grouped review, original failures and log integrity passed');
  console.log('Native continuation: capability prerequisites, independent failures, complete-owner reuse, tamper rejection, timeout and cleanup passed');
} finally {
  const resolved = fs.realpathSync(directory);
  assert.ok(path.relative(root, resolved) && !path.relative(root, resolved).startsWith('..'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
