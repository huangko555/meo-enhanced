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

## Editor startup and loading

The quick and release gates run `scripts/test-panel-session-ready-init.ts` and
`scripts/test-editor-startup-load.ts`. The first checks that concurrent Webview
`ready` messages share one `init`, a later `ready` can retry a lost delivery,
and Markdown uses LF even when the file uses CRLF. The second opens the
production Webview directly in Live, Source, and Preview, then waits for the
document text on the active surface. In Preview, the test also requires the
loading status to clear and the rendered document to exist. A selected mode
button alone does not prove a successful load. Source's optional side-by-side
preview is covered by
`scripts/test-source-side-preview.ts` in the production browser matrix.
`scripts/test-mode-roundtrip-reveal.ts` checks Live → Source → Preview → Live
with a viewport table whose row layout is deliberately delayed. The first
visible Live frame must already contain content and the table's final height;
this check runs in the quick, targeted table/viewport, and release gates.
`scripts/test-mode-transition-matrix.ts` checks both six-step mode cycles with
Source's split preview on and off. It covers paragraphs, tables, code blocks,
successful and failed Mermaid renders, images, math, HTML/quotes, and nested
lists in the viewport. Every painted frame must retain visible content, the
first revealed editor frames must keep their geometry, and the 95th-percentile
switch-to-ready time must stay
below 300 ms in the production browser harness. Run it for mode-transition
changes and as part of the targeted viewport and release browser suites.

`scripts/test-viewport-anchor-production.ts` also runs in the full browser suite.
It checks semantic reading-band position and proportional rendered-block progress
across modes, every visible transition frame, and Preview selection/focus through
late resources, external revisions, and disk reloads. Same-surface captures inside
paragraph whitespace must preserve the gap; cross-mode checks do not require
identical raw pixel offsets for differently sized rendered blocks.

`scripts/test-preview-loading-reuse.ts` holds the initial Preview iframe load after
its Host response. It verifies that activation reuses that presentation while
changed text, forced refresh, failed-response retry, and disposal retain their
behavior. It runs in the full browser suite; the quick startup test also requires
one Host render when opening directly in Preview, with the configured language
and font size already applied to the initial request. Force-failure retry is
checked both before and after the retained iframe becomes ready.

For final installed-VSIX acceptance, use an isolated VS Code profile and open
a Markdown file in each saved mode after both closing its tab and restarting
VS Code. Confirm that the content is readable and interactive without changing
modes. This native check complements the browser contract by exercising the
actual extension Host/Webview startup handshake.

The full-document endurance runner keeps the curated operation set for its
original acceptance fixture. For other Markdown documents it discovers unique
edit targets by structure, samples up to eight per category across the document,
and mixes forward and shuffled traversal. Its report lists available/selected
targets and locations that could not be addressed safely. This is sampled editing
coverage; the subsequent production scroll-integrity pass traverses the document.
Duplicate text and unsupported shells are reported rather than counted as tested.
Custom fixture-specific phases still require their matching curated document.

`scripts/test-preview-code-highlight-layout.ts` exercises the production Preview
renderer and Shiki projection in Chromium at three widths and both appearances.
It checks source text, theme changes, viewport deferral, scrolling, resizing, and
full-document projection. CDP layout counts enforce bounded layout work during
projection without relying on machine-dependent elapsed-time thresholds. It runs
in the appearance pack, highlight suite, and full browser suite.

`scripts/test-source-lightweight-shiki-lifecycle.ts` checks shared highlighter
ownership and hidden-editor revisions through the production editor. Hidden
editors keep previously presented fences warm across source, language, and theme
changes without tokenizing every unseen fence. Reveal must color the latest
visible content, and another visible editor must keep working independently.
Performance comparisons must include the first return to Live/Source and a single
large fence so reduced background work cannot conceal a new mode-switch delay.

`scripts/test-export-fence-highlight-reuse.ts` runs the bundled renderer in Node
and observes the real fallback highlighter. It checks reuse after prose changes,
code/language invalidation, custom-highlighter isolation, error retries, bounded
entry count and text payload, oversized-entry bypass, parent-document release,
and repeated sanitization.
It runs in the unit suite. Performance comparisons must separate first rendering
from later revisions and include both many small fences and a single oversized
fence; cache reuse does not promise faster cold starts or oversized highlights.

## Performance investigation

Start with a fixed revision and document, then measure cold startup separately
from settled interaction. Change one suspected source of work at a time. Keep
the document hash, viewport, font, runtime version, and profiling mode with the
results; CPU sampling changes timings and must not be mixed with unprofiled runs.

For repeatable built-Webview loading measurements after a production build:

```powershell
bun scripts/benchmark-mode-loading.ts --confirm-long-run --rounds 5 --label candidate
```

This uses the emitted ESM chunks and real Mermaid runtime, with a fresh browser
context and disabled HTTP cache for each Live, Source, and Preview startup.
Ordinary, many-line, rich-block, and prose-only Mermaid mention fixtures have
recorded hashes. Reports in
`.local/probes/mode-loading-*` include build hashes, browser/version/viewport,
navigation-to-ready-handshake, navigation-to-first-content-frame, and individual
mode transitions tagged by whether the destination has been visited. Use
`--fixture mention-only` to focus a follow-up sample. The Host render bridge
uses the real preview renderer; it does not model Extension Host activation, VS Code IPC, OS file-cache coldness, saved
reading-position restoration, or optional Source split preview. Rich-resource
completion is not the first-content metric. The run additionally checks that
Source does not request Mermaid code for documents without a diagram hint and
that rich fixtures eventually produce a real SVG after switching to Live.

Use `--preload-mermaid` only to reproduce the former broad word-match policy
for comparison; it is recorded in the report and is not the current production
policy. Compare matching fixtures, runtime, viewport, and sampling order without
concurrent tests. Report medians and sample ranges; a few repetitions do not
establish a reliable p95. Complement these Webview measurements with the native
probes below. This is a repeated performance campaign and requires explicit
long-run authorization.

For native saved-mode and process-restart coverage, build first and create a JSON
case with an absolute `document` path, `savedMode` and `expectedMode` (`live`, `source`, or
`preview`), plus boolean `optimization` and `restore` fields. For example:

```json
{"document":"C:/fixtures/ordinary.md","savedMode":"preview","expectedMode":"preview","optimization":false,"restore":true}
```

```powershell
pwsh -File scripts/benchmark-vscode-modes.ps1 -CaseFile <case.json> -CodePath <Code.exe> -ConfirmLongRun
```

The probe seeds the saved mode and reading position through the real UI, quits,
then restarts the same isolated profile. It checks initial mode, a same-process
reopen, and all six directed mode transitions with Source split preview disabled
and enabled. The large-document policy can override a saved mode with Source;
encode that expectation explicitly rather than counting it as a Live/Preview
startup. Split preview is intentionally session-only. When `restore` is false,
the seed still saves a non-top position before the measuring process disables
restoration. Non-scrollable documents are explicitly excluded from restoration
coverage; scrollable documents must produce both a non-top DOM position and a
non-top persisted position.

This uses a small companion development extension, because VS Code's extension
test runner uses in-memory storage and cannot prove cross-process persistence.
Each phase is bounded to 180 seconds. Reports retain seed and measurement results,
built entry/runtime hashes, document/driver hashes, runtime, viewport, font and
focus state. Failure reports and isolated seed storage snapshots remain available
for diagnosis. The seed waits five seconds outside measured intervals and Bun
checks scroll geometry and the copied SQLite state before measuring restore.
Seeding uses trusted wheel input. Restored position must still be away from the
top in the settled snapshot. Each Source transition also asserts the actual split
state, and fresh Webviews must start with split disabled.
Missing persisted state fails the setup instead of being counted as a restore
test. Source documents are never edited.

`launchToHarnessMs` and `launchToReadyMs` include VS Code and automation overhead;
`openToReadyMs` starts at `openWith`. Extension activation may have begun earlier
and its state at harness entry is recorded. OS file caches are not cleared. DOM
polling is not exact first-paint measurement, and content readiness does not mean
all diagrams/images have finished. `readingPositionReadyMs` only detects a move
away from the top for a previously scrolled document; exact semantic fidelity is
asserted separately by the production reading-position browser tests. Do not
infer whole-application speedups, foreground latency, installed-VSIX acceptance,
or reliable percentiles from one development-window sample. The launcher requests
Hidden, but Electron may show its own window; use the recorded focus/visibility
state rather than assuming it stayed hidden.

For a short, read-only native Windows startup/scroll probe after building:

```powershell
pwsh -File scripts/benchmark-vscode-startup.ps1 -Document <absolute-markdown-path> -CodePath <absolute-Code.exe-path>
```

This opens an isolated hidden development window, measures immediate and settled
wheel scrolling, and stores JSON in `.local/probes/startup-*`. `openToEditorMs`
starts at the open command, after VS Code itself has started. Add `-Profile`
only to investigate CPU stacks. It never edits the input document. The timings
are comparative evidence, not hardware-independent pass/fail limits. This probe
uses a hidden window whose scheduling may differ from foreground use. It
does not measure native input latency or prove pixel-level scroll integrity;
use the existing input/viewport contracts for those checks.

For user-visible acceptance, obtain permission to occupy the foreground and add
`-Visible`. Compare only samples whose `foreground` values are true and whose
recorded viewport/font settings match. `-ExtensionPath` selects an independently
built baseline checkout. A single pair is indicative, not a stable improvement
percentage; repeated performance/endurance campaigns still require long-run
authorization. Do not run other tests alongside timing samples.

For a short read-only mode-transition and image-decoding probe:

```powershell
pwsh -File scripts/benchmark-vscode-startup.ps1 -Scenario reading -Document <absolute-markdown-path> -CodePath <absolute-Code.exe-path> -ImageLine <one-based-source-line>
```

This visits Preview, Source, Live, Source, Preview, and Live once, and records the
document and build hashes in `.local/probes/reading-*`. `readyMs` ends when the
destination surface is ready and the transition cover is gone; it includes
automation overhead and does not wait for every image or diagram. `-ImageLine`
optionally selects the first image whose mapped source line matches, aligns its
source block with the top after a trusted interaction, and checks real decoding
separately from the placeholder. The image report records its bounds and visibility after decoding;
decoding success alone does not prove that late layout kept it in the viewport.
`-Profile` samples each transition separately and marks the run as profiled.
`-Trace` instead captures `reading.trace.json` from before `openWith` through all
six transitions, including CPU samples from newly created webview renderers. User Timing marks
identify editor detection and each transition's automation start/ready bounds.
The trace excludes VS Code process startup and Extension Host CPU stacks;
editor detection can lag actual mounting. Use it to attribute renderer work,
not as an exact first-paint measurement. Group trace CPU profiles by process and
profile ID before aggregating samples; a renderer can also have worker profiles.
The trace cannot be combined with the separate per-transition `-Profile` mode;
collect uninstrumented timings separately.
These single samples are diagnostic, not percentiles or endurance acceptance.
The same hidden-window, foreground-permission, and no-concurrent-test rules apply.

For a short native input/save baseline on a disposable copy of a rich document:

```powershell
pwsh -File scripts/benchmark-vscode-startup.ps1 -Scenario interaction -Document <absolute-markdown-path> -CodePath <absolute-Code.exe-path>
```

This adds known edit targets to a copy inside the isolated workspace and measures
one prose, table, and Mermaid input/save action, followed by one delayed auto-save.
It checks the expected contents against both Host and disk and verifies the original
file is unchanged. The report remains under `.local/probes/interaction-*`. Input
latency ends after two animation frames following the native input event; this is
a scheduling proxy, not a physical display measurement. Save latency includes
the native save command and disk verification; auto-save includes the configured
one-second delay. Hidden windows remain diagnostic even if DOM focus is true.
`-Visible` requires foreground authorization, and `-Profile` is unavailable for
this scenario. A single sample per action establishes a baseline, not percentiles.

Add `-ColdInput` to observe the editor while `openWith` is still pending and
issue one trusted input at its default first-line-end caret immediately after
detection and focus, without the normal settling sleep or changing selection.
Direct DOM selection changes can race the editor's initial selection sync and
must not be used for this cold probe. It then scrolls once, switches Source →
Preview → Live, and performs the usual input/save checks, including that first
edit in the expected contents. Reports separate detection-to-command,
setup-to-input-event, input-to-two-frames, and command-to-result times.
Cold input also reports `inputToFirstFrameMs` and `betweenFramesMs`, whose sum
is `inputToPaintMs`. The split distinguishes waiting for the first frame callback
from subsequent work; neither callback proves that pixels reached the display.
Detection-to-command and setup-to-input-event include automation/setup overhead; editor detection can
lag mounting; this is not a measurement from the physical key press. Collecting
the result can wait behind later renderer tasks even when the two frames have
already occurred, so command-to-result must not be treated as input latency. The scroll
and switches follow that first input, so they do not represent independently
cold launches. This option is limited to `interaction` and remains a short
diagnostic, not an endurance run or a pixel-level scroll assertion.

Combine `-ColdInput -Trace` to write `interaction.trace.json` with CPU samples
and `meo-cold-setup`, `meo-cold-input`, `meo-cold-frame1`, and `meo-cold-frame2`
marks. Use this to attribute work between input and frames; tracing affects
timings, so collect untraced samples separately. This combination cannot use
`-Profile`.

For one bounded native hide/return/close resource sample:

```powershell
pwsh -File scripts/benchmark-vscode-startup.ps1 -Scenario lifecycle -Document <absolute-markdown-path> -CodePath <absolute-Code.exe-path>
```

This opens the read-only rich document and one disposable plain control editor
in the same tab group, returns to the rich document, then closes its tab. It
records Host tab activity separately from Webview visibility, diagnostic timer
progress, buffered long tasks, runtime availability, and CDP heap/DOM counters.
Different Webview targets may share an isolate: heap samples are deduplicated
by isolate ID and must not be added once per target. These are not native/GPU
memory totals or leak evidence. No forced GC is performed; closing a tab checks
frame detachment, not immediate return of memory to the OS. The probe does not
exercise multiple rich documents or repeated open/close cycles.

`richOpenToEditorMs` and `controlOpenToEditorMs` end at automated editor detection;
`returnCommandMs` ends at the Host command completing, not at first paint.
The counters and timers themselves add overhead. Reports include document/build
hashes and environment information under `.local/probes/lifecycle-*`. The same
hidden-window and foreground-permission rules apply; Profile/Trace are rejected.
Use the reading trace separately for startup attribution, and collect timing
samples without concurrent tests. Repeated resource campaigns remain long runs.

After explicit authorization for a repeated resource investigation, use:

```powershell
pwsh -File scripts/benchmark-vscode-startup.ps1 -Scenario lifecycle -ResourceCampaign -ConfirmLongRun -Document <absolute-markdown-path> -ImagePath <absolute-local-image-path> -CodePath <absolute-Code.exe-path>
```

This bounded campaign runs eight rounds with three generated rich documents
(small SVG images, twelve flowcharts, and the supplied large image) plus a
retained plain control, at most four editors at once. All assets are local
copies in the isolated workspace. The supplied Markdown is hashed for provenance
and checked unchanged; the campaign renders generated fixtures, not that entire
document. It waits for real Preview SVG/image completion, records return command
latency, observes five seconds hidden and five seconds after closing each round,
and writes incremental `progress.json` alongside the final report. Input/save,
foreground paint latency, and full-document scroll integrity are not covered.

Windows process private bytes and working sets are sampled only for process IDs
reported by the isolated browser. Shared working sets must not be summed as unique
memory; heap samples remain deduplicated by isolate. A final forced-GC diagnostic
is labeled separately, after every normal round and timing measurement has ended.
It helps distinguish retained objects from delayed collection, but cannot prove
the absence of native/GPU leaks. Reserve about 10–15 minutes and do not run other
tests concurrently. This authorization does not imply a release or VM run.

To isolate one diagram using the real runtime and production editor:

```shell
bun scripts/benchmark-mermaid-render.ts
bun scripts/benchmark-mermaid-render.ts <markdown-path> <opening-fence-line>
```

The default fixture has 40 edges. The optional document is read-only; only the
selected fenced Mermaid source is rendered. Reports record its hash, viewport,
cold render duration, long tasks, and whether Split reuses the cached SVG.
Initial editor work and individual diagram computation should be distinguished:
yielding can separate tasks without reducing total render time. Neither probe is
part of the quick gate or a substitute for authorized repeated/endurance checks.

For a narrow ordinary-document input, scroll, resource, and Live/Source baseline:

```shell
bun scripts/benchmark-large-document-production.ts --fixture ordinary
```

Keep the default full fixture matrix and endurance behind the existing long-run
authorization. Select additional scenarios from the actual changes: startup,
input, rendering, mode transitions, or native save scheduling. Optimize measured
bottlenecks and recheck adjacent behavior so work is not merely moved to the
next interaction. Preserve deterministic regression tests for excess work or
incorrect scheduling; do not turn noisy millisecond samples into CI assertions.

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

The transient-input browser check also covers input arriving during snapshot
collection, Live/Source IME confirmation and cancellation, table-cell IME after
pending ordinary input, and Mermaid/math embedded input. During composition,
saving must preserve the candidate and save only confirmed text; after confirmation,
the final characters must reach disk. Include a short delay (100 ms), switching
auto-save off and back on, manual save, and a clean external file update in native
acceptance. Keep failure checks for rejected applies, mismatched text, timeout,
and closing the editor: a warning must not be suppressed when input is unconfirmed.

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

The full-document endurance entry first runs save concurrency, transient-input
flush (including IME), and recent rendered-block, search,
reload, table interaction, change-review, diff-gutter, and code-block line-number
regressions. It then preserves the original high-intensity UAT and finishes with
production live-scroll integrity against the same document:

```shell
bun run test:endurance -- path/to/document.md --confirm-long-run
```

Use the recommendation and authorization policy above before either long run.

## Release candidate evidence

Before a release, compare the last published tag with the candidate commit.
Map every user-visible change to a relevant contract or native acceptance result,
and write release notes from that inventory. Do not describe an unconfirmed report
as fixed. Record the candidate commit, clean working-tree state, runtime versions,
commands, exit codes, log locations, and final VSIX size and SHA-256.

When font-size or viewport behavior changes, supplement the release gate with
`bun scripts/test-font-size-full-document.ts --document=<absolute-markdown-path>
--confirm-long-run` on a representative rich document. The runner checks every
sampled position in Live, Source, split Source/Preview, and Preview through five
size increases and decreases. Record the fixture hash and anomaly count. Near
the document end, an enlarged layout can reach the maximum scroll position;
those frames are reported as bottom-constrained instead of being counted as
top-anchor jumps. Any remaining displacement over 12 px is a failure.

Run the complete release gate before endurance. Keep browser performance and
native endurance runs serial to avoid resource contention. Diagnose failures with
the smallest reproducer, inspect any skipped remainder, then run the required
formal gate on the corrected candidate. Do not retry failures until one passes
or lower endurance limits to obtain release evidence. A short runner preflight
is useful during setup, but must be reported separately from the full run.

The full-document endurance runner exercises editor history and viewport
stability; it does **not** exercise VS Code's auto-save scheduler or real disk
persistence. When save behavior changes, supplement it with native acceptance.
The reusable `scripts/test-vscode-auto-save-endurance.cjs` runner is loaded through
VS Code's `--extensionTestsPath`, alongside `--extensionDevelopmentPath=<repo>`.
Launch it in a dedicated disposable workspace with separate `--user-data-dir`
and `--extensions-dir`, and `--remote-debugging-port=9337`. It requires:

- `MEO_CONFIRM_LONG_RUN=1`, only after explicit authorization.
- `MEO_NATIVE_ENDURANCE_WORKSPACE`: the absolute path of that disposable workspace.
- `MEO_NATIVE_ENDURANCE_ROUNDS`: defaults to 60 (1–120); use three rounds only
  for setup verification, then the default for candidate acceptance.
- `MEO_NATIVE_BROWSER_URL`: defaults to `http://127.0.0.1:9337`.

The native runner creates its own Markdown fixture, uses `afterDelay` at 1000 ms,
and keeps one document session alive across Source input, Live table editing,
undo/redo, and Preview transitions. It waits for actual platform save events and
compares exact expected text with TextDocument and disk, checks cell focus, then
reopens the file. It never calls `document.save()` to simulate auto-save. Results
are written to `auto-save-endurance-result.json` in the disposable workspace.
Budget approximately 3–6 minutes in addition to full-document endurance. This
complements, rather than replaces, the native focus-change/window-change and IME
acceptance described above. Do not use an actual user workspace or edit a user's
original document for this runner.

## Manual F5 acceptance

Manual acceptance should also be risk-based. Test the changed surface first,
then do a short transition check around it: Live/Source/Preview mode switching,
typing and undo/redo, cursor visibility and scroll stability. Add Mermaid/math,
tables, themes, or export only when the change can affect them. Reserve the
complete top-to-bottom document walkthrough for an explicitly scheduled
release acceptance session.
