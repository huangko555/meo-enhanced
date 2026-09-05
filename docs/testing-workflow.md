# Testing workflow

This repository separates fast feedback from release confidence. The normal
repair loop stays narrow; broad and endurance runs are intentional events.

| Tier | Use it when | Expected time | Command |
| --- | --- | --- | --- |
| Quick | A coherent implementation change is ready for a general regression check | About 30–60 seconds | `bun run test:quick` |
| Targeted | A change affects one high-risk area, or a quick check identifies that area | About 1–5 minutes | `bun run test:targeted -- <area>` |
| Release | A milestone or release candidate needs the complete gate | About 12–25 minutes | `bun run test:release -- --confirm-long-run` |
| Large document | A shorter production-like document stress pass is specifically needed | About 1–3 minutes | `bun run test:large-document -- <document> --confirm-long-run` |
| Endurance | Full-document edit, undo/redo, cursor, and viewport stress is specifically needed | About 20–35 minutes per run | `bun run test:endurance -- <document> --confirm-long-run` |

## Long-run recommendation and authorization

The agent owns the decision to recommend a long run; the user does not need to
remember the tiers or commands. Recommend the appropriate run proactively when
the work reaches one of these boundaries:

- **Release:** a milestone or release candidate is becoming fixed, or broad
  cross-cutting changes need release confidence.
- **Large document:** a shorter production benchmark, sampled strict UAT, and
  live-scroll integrity pass are enough to assess document-scale risk.
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

## Auto-save verification

Auto-save concurrency is part of `bun run test:quick`. The focused save checks are:

```shell
bun scripts/test-document-auto-save-concurrency.ts
bun scripts/test-document-save-flush-webview-adapter.ts
bun scripts/test-vscode-document-save-lifecycle-adapter.ts
bun scripts/test-panel-session-native-save-flush.ts
bun scripts/test-native-save-table-flush.ts
```

For native VS Code acceptance, use an isolated development profile and disposable
Markdown files. Check `files.autoSave` with `afterDelay` (1000 ms),
`onFocusChange` (switch to another editor), and `onWindowChange` (leave the VS Code
window). Verify Live and Source input, a table cell without leaving the cell,
continued input during save, and reopening the saved file. Compare disk contents
with the editor and verify focus/history are preserved; a simulated save event
alone does not validate the platform's focus or auto-save scheduling.

## Targeted packs

```shell
bun run test:targeted -- history
bun run test:targeted -- table
bun run test:targeted -- rendered
bun run test:targeted -- appearance
bun run test:targeted -- search
bun run test:targeted -- viewport
bun run test:targeted -- changes
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
architecture checks, every sub-suite from the repository's unchanged full
`bun run test` pipeline, a production build, and package-content validation:

```shell
bun run test:release -- --confirm-long-run
```

To reduce wall-clock time without reducing coverage, independent static and
domain suites run with bounded concurrency. High-risk browser contracts run as
an early serial preflight before the complete production browser matrix, so a
recent interaction regression fails before the longest stage. The matrix is
followed by the production build and package validation. Workflow contracts
verify both that every sub-suite from `bun run test` appears exactly once in
the release plan and that every non-UAT targeted contract is transitively
included in the full suite, so scheduling changes cannot silently remove
coverage.

The existing `bun run test` command remains the complete test pipeline for CI
compatibility. Agents and local repair work use the guarded release entry when
requesting that pipeline as part of a full gate.

The simplified large-document entry is a shorter stress test, currently about
one minute on a steady local machine and budgeted at about 1–3 minutes:

```shell
bun run test:large-document -- <document> --confirm-long-run
```

It runs the production large-document benchmark, an eight-edit strict
full-document UAT, and the production live-scroll integrity check in that order.
All three commands run serially so their performance measurements do not
contaminate one another. Despite the shorter duration, this remains a stress
test: an agent must wait for explicit user authorization in the current task
before running it. Omitting `--confirm-long-run` is rejected; `--dry-run` may be
used without authorization to inspect the exact plan.

The full-document endurance entry first runs recent rendered-block, search,
reload, table interaction, change-review, diff-gutter, and code-block line-number
regressions. It then preserves the original high-intensity UAT and finishes with
production live-scroll integrity against the same document:

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
