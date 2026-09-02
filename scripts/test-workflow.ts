import {
  createTestWorkflowPlan,
  parseTestWorkflowRequest,
  type TestWorkflowCommand,
  type TestWorkflowStage,
  validateTestWorkflowAuthorization
} from './test-workflow-policy';

const help = `MEO Enhanced test workflow

Usage:
  bun scripts/test-workflow.ts quick [--dry-run]
  bun scripts/test-workflow.ts targeted <history|table|rendered|appearance|search|viewport> [--dry-run]
  bun scripts/test-workflow.ts targeted uat <document> [--dry-run]
  bun scripts/test-workflow.ts release --confirm-long-run [--dry-run]
  bun scripts/test-workflow.ts endurance <document> --confirm-long-run [--dry-run]
  bun scripts/test-workflow.ts large-document <document> --confirm-long-run [--dry-run]

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

async function runCommand(command: TestWorkflowCommand): Promise<number> {
  const startedAt = performance.now();
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
  return Math.round((performance.now() - startedAt) / 100) / 10;
}

async function runStage(
  stage: TestWorkflowStage,
  stageIndex: number,
  stageCount: number
): Promise<void> {
  const concurrency = Math.max(
    1,
    Math.min(stage.maxConcurrency ?? 1, stage.commands.length)
  );
  console.log(
    `\n[stage ${stageIndex + 1}/${stageCount}] ${stage.title}`
      + (concurrency > 1 ? ` (up to ${concurrency} concurrent commands)` : '')
  );

  let nextIndex = 0;
  const failures: Array<{ index: number; error: unknown }> = [];
  const timings = new Array<number>(stage.commands.length);
  const worker = async (): Promise<void> => {
    while (nextIndex < stage.commands.length) {
      const commandIndex = nextIndex;
      nextIndex += 1;
      const command = stage.commands[commandIndex]!;
      console.log(
        `[${commandIndex + 1}/${stage.commands.length}] START ${formatCommand(command)}`
      );
      try {
        const elapsed = await runCommand(command);
        timings[commandIndex] = elapsed;
        console.log(
          `[${commandIndex + 1}/${stage.commands.length}] PASS  ${formatCommand(command)} (${elapsed}s)`
        );
      } catch (error) {
        failures.push({ index: commandIndex, error });
        console.error(
          `[${commandIndex + 1}/${stage.commands.length}] FAIL  ${formatCommand(command)}`
        );
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (failures.length > 0) {
    failures.sort((left, right) => left.index - right.index);
    const summary = failures.map(({ index, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      return `  - ${formatCommand(stage.commands[index]!)}: ${message}`;
    });
    throw new Error(`${stage.title} failed:\n${summary.join('\n')}`);
  }

  const elapsed = Math.max(0, ...timings.filter(Number.isFinite));
  console.log(`${stage.title} passed (critical path ${elapsed}s)`);
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
  let commandNumber = 0;
  for (const [stageIndex, stage] of plan.stages.entries()) {
    const concurrency = Math.max(1, stage.maxConcurrency ?? 1);
    console.log(
      `  Stage ${stageIndex + 1}: ${stage.title}`
        + (concurrency > 1 ? ` (max concurrency ${concurrency})` : '')
    );
    for (const command of stage.commands) {
      commandNumber += 1;
      console.log(`    ${commandNumber}. ${formatCommand(command)}`);
    }
  }
  if (request.dryRun) {
    console.log('Dry run only; no tests were executed.');
    return;
  }

  const startedAt = performance.now();
  for (const [index, stage] of plan.stages.entries()) {
    await runStage(stage, index, plan.stages.length);
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
