import {
  createTestWorkflowPlan,
  parseTestWorkflowRequest,
  type TestWorkflowCommand,
  validateTestWorkflowAuthorization
} from './test-workflow-policy';

const help = `MEO Enhanced test workflow

Usage:
  bun scripts/test-workflow.ts quick [--dry-run]
  bun scripts/test-workflow.ts targeted <history|table|rendered|appearance|viewport> [--dry-run]
  bun scripts/test-workflow.ts targeted uat <document> [--dry-run]
  bun scripts/test-workflow.ts release --confirm-long-run [--dry-run]
  bun scripts/test-workflow.ts endurance <document> --confirm-long-run [--dry-run]

Long-running workflows require explicit user authorization for the current task
and the --confirm-long-run flag. A dry run only prints the plan.`;

function formatCommand(command: TestWorkflowCommand): string {
  const environment = Object.entries(command.env ?? {})
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join(' ');
  const invocation = ['bun', ...command.args]
    .map((value) => (/\s/.test(value) ? JSON.stringify(value) : value))
    .join(' ');
  return environment ? `${environment} ${invocation}` : invocation;
}

async function runCommand(command: TestWorkflowCommand): Promise<void> {
  const child = Bun.spawn([process.execPath, ...command.args], {
    cwd: process.cwd(),
    env: { ...process.env, ...command.env },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${formatCommand(command)}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(help);
    return;
  }

  const request = parseTestWorkflowRequest(argv);
  const plan = createTestWorkflowPlan(request);
  validateTestWorkflowAuthorization(plan, request.confirmLongRun, request.dryRun);

  console.log(`${plan.title} (${plan.expectedDuration})`);
  for (const [index, command] of plan.commands.entries()) {
    console.log(`  ${index + 1}. ${formatCommand(command)}`);
  }
  if (request.dryRun) {
    console.log('Dry run only; no tests were executed.');
    return;
  }

  const startedAt = performance.now();
  for (const [index, command] of plan.commands.entries()) {
    console.log(`\n[${index + 1}/${plan.commands.length}] ${formatCommand(command)}`);
    await runCommand(command);
  }
  const elapsedSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
  console.log(`\n${plan.title} passed in ${elapsedSeconds}s`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
