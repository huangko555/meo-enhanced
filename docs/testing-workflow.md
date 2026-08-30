# Testing workflow

This repository separates fast feedback from release confidence. The normal
repair loop stays narrow; broad and endurance runs are intentional events.

| Tier | Use it when | Expected time | Command |
| --- | --- | --- | --- |
| Quick | A coherent implementation change is ready for a general regression check | About 30–60 seconds | `bun run test:quick` |
| Targeted | A change affects one high-risk area, or a quick check identifies that area | About 1–5 minutes | `bun run test:targeted -- <area>` |
| Release | A milestone or release candidate needs the complete gate | About 15–30 minutes | `bun run test:release -- --confirm-long-run` |
| Endurance | Full-document edit, undo/redo, cursor, and viewport stress is specifically needed | About 15–30 minutes per run | `bun run test:endurance -- <document> --confirm-long-run` |

## Long-run recommendation and authorization

The agent owns the decision to recommend a long run; the user does not need to
remember the tiers or commands. Recommend the appropriate run proactively when
the work reaches one of these boundaries:

- **Release:** a milestone or release candidate is becoming fixed, or broad
  cross-cutting changes need release confidence.
- **Endurance:** undo/redo, cursor, viewport, tables, or rendered-block editing
  has changed substantially, regressed repeatedly, or is ready for final UAT.
- **Clean-environment/VM validation:** a final VSIX or installer needs an
  installation and startup check outside the development checkout.

Every recommendation must state the test type, why it is warranted, its scope,
and its expected duration. Release, endurance, full browser matrices, repeated
stress runs, full-document sweeps, and VM validation wait for explicit user authorization
in the current task. A generic request to fix, build, or test is
not authorization. The confirmation flag records an intentional invocation;
it is not a substitute for asking. `--dry-run` is always safe and prints the
exact commands without running them.

## Daily repair loop

1. Reproduce the reported behavior with the smallest relevant contract.
2. While implementing, rerun only that contract.
3. Once the change is coherent, run `bun run test:quick` once.
4. Add the matching targeted pack when the change touches a high-risk area.
5. Assess the long-run triggers above. If one applies, recommend the matching
   run and wait for authorization; otherwise stop.

This avoids repeatedly paying for browser startup and unrelated matrices while
still checking type safety, workflow policy, history, tables, rendered blocks,
input-derived work, viewport behavior, and one production browser scenario in
the quick gate.

## Targeted packs

```shell
bun run test:targeted -- history
bun run test:targeted -- table
bun run test:targeted -- rendered
bun run test:targeted -- appearance
bun run test:targeted -- viewport
```

Choose only areas affected by the change. Several areas may be run one after
another for a cross-cutting fix; the workflow never escalates itself to the
full suite.

For a sampled real-document UAT, use:

```shell
bun run test:targeted -- uat path/to/document.md
```

The sample performs eight representative edits with undo/redo, then checks the
real Webview shell during first-pass outline navigation and bidirectional
scrolling. It treats every soft viewport finding as a failure. This is the
regular substitute for the full document sweep, not a release claim.

## Long-running gates

After explicit authorization, the release entry runs type checking,
architecture checks, the repository's unchanged full `bun run test` suite, a
production build, and package-content validation:

```shell
bun run test:release -- --confirm-long-run
```

The existing `bun run test` command remains the complete test pipeline for CI
compatibility. Agents and local repair work use the guarded release entry when
requesting that pipeline as part of a full gate.

The full-document endurance entry preserves the original high-intensity UAT:

```shell
bun run test:endurance -- path/to/document.md --confirm-long-run
```

Use the recommendation and authorization policy above before either long run.

## Manual F5 acceptance

Manual acceptance should also be risk-based. Test the changed surface first,
then do a short transition check around it: Live/Source/Preview mode switching,
typing and undo/redo, cursor visibility and scroll stability. Add Mermaid/math,
tables, themes, or export only when the change can affect them. Reserve the
complete top-to-bottom document walkthrough for an explicitly scheduled
release acceptance session.
