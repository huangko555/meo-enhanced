# Release acceptance preparation and continuation

These tools support the existing [release acceptance sequence](testing-workflow.md#release-acceptance-sequence).
They do not change release coverage, thresholds, long-run authorization or the
release runner's conservative resume rules. Use them to avoid repeated setup,
unnecessary whole-gate reruns and hand-maintained continuation scripts.

## Prepare the coverage checklist

```shell
bun run acceptance:evidence -- --baseline=<accepted-commit> --document=<disposable-rich-document> --report=<previous-report.json> --output=.local/acceptance/coverage.json
```

The command does not execute tests. It expands the **current complete release
plan**, retaining every logical occurrence and exact arguments/environment while
grouping identical executions. Supply additional `--report=` arguments for focused
workflow reports. It lists changed paths, historical source candidates, verified
log references, and `missing`, `rerun`, `review` or `reuse` dispositions.
Omitting `--document` explicitly omits font/endurance supplements; it cannot
establish full-document or native coverage. Supplemental ad-hoc logs still need
the existing manual evidence review; they are not silently imported as passes.

Passing logs initially require review. Failed cases require rerun or an explicit
cause/resolution and a verified passing replacement. A changed file list is an
aid to impact review, never automatic unaffected-test inference. Check source
changes since each source report's own candidate, including any intermediate
repair/evidence bridge, rather than assuming every report covers the baseline.

To record reuse, copy the output's `reviewTemplate` to a separate review JSON.
Group case IDs that share the same applicability argument instead of repeating
identical paperwork. A reuse group has this shape:

```json
{
  "snapshot": "<snapshot from coverage.json>",
  "items": [{
    "ids": ["<case-id>", "<another-case-id>"],
    "decision": "reuse",
    "sourceReportHash": "<verified source report hash>",
    "productAndBuild": "Owning code and relevant build inputs checked; describe why applicable",
    "testAndSharedFixtures": "Test and shared driver differences checked",
    "argumentsAndScale": "Document identity, scale and arguments checked",
    "dependenciesAndEnvironment": "Relevant runtime, OS, display and input conditions checked"
  }]
}
```

Use `source: {reportHash, task}` when selecting one exact source task. A group
containing historical failures also needs `failures: [{reportHash, task,
causeAndResolution}]` for each recorded failure. Rerun groups need only IDs and
`decision: "rerun"`; they need no applicability essay.

Repeat the command with `--review=<review.json>` and a **new** output path.
The review binds source, configuration, selected document, actual dependencies,
runtime files, built output, original reports and their logs. The selected test
browser and capture browser are included automatically. Use repeatable
`--runtime=<Code-or-other-executable>` arguments to include native executables.
Changed or missing evidence prevents reuse. This checklist is not a passing
complete-run report or release approval: retain independent completeness review,
installed/native evidence and the final archive identity checks.

## Preflight the existing drivers

```shell
bun run acceptance:preflight
bun run acceptance:native -- --plan=.local/acceptance/native-plan.json --output=.local/acceptance/native-1 --dry-run
```

The first entry runs the existing pointer delivery and mode-readiness contracts,
including negative controls. It does not establish physical Windows input or
delivery in a particular installed Workbench. The native dry run validates the
plan and parses every configured Bun/Node/PowerShell owner before any owner runs.
Prove the actual capabilities needed by the selected native cases separately.

## One native plan and one continuation entry

A plan binds one VSIX and one explicitly selected environment. Keep it under
`.local/`; reuse the already verified native owners instead of cloning another
controller. All paths in the plan are relative to its directory. Example shape:

```json
{
  "schemaVersion": 1,
  "environment": {
    "id": "isolated-current-vscode",
    "launch": "normal",
    "description": "Record actual OS, VS Code, display, language and input method",
    "runtimes": ["<absolute Code.exe path>", "<absolute browser executable>"]
  },
  "artifact": {"file": "<verified.vsix>", "sha256": "<64 lowercase hex characters>"},
  "inputs": ["<disposable document>", "<shared native driver or stable input directory>"],
  "steps": [
    {"id":"install", "kind":"setup", "command":{"runtime":"pwsh", "script":"<existing install owner.ps1>"}, "timeoutSeconds":300, "provides":["installed-vsix"], "receipt":{"file":"result.json"}},
    {"id":"pointer", "kind":"preflight", "command":{"runtime":"bun", "script":"../../scripts/test-native-input-delivery.ts", "args":["--browser-url=http://127.0.0.1:9337", "--heading=<unique disposable heading>", "--selector=<visible target>", "--output={output}/result.json"]}, "timeoutSeconds":30, "dependsOn":["install"], "provides":["target","pointer","observation"], "receipt":{"file":"result.json"}},
    {"id":"resources", "kind":"check", "command":{"runtime":"pwsh", "script":"<existing installed resource owner.ps1>"}, "timeoutSeconds":300, "requires":["target","pointer","observation"], "receipt":{"file":"result.json", "expect":{"documentUnchanged":true}}},
    {"id":"finish", "kind":"cleanup", "command":{"runtime":"pwsh", "script":"<existing owned cleanup.ps1>"}, "timeoutSeconds":120, "receipt":{"file":"result.json", "expect":{"ownedProcessesExited":true}}}
  ]
}
```

Adapt existing wrappers to write their **actual assertion result** below
`MEO_ACCEPTANCE_OUTPUT`, or pass `{output}` to their output argument. The owner
receipt must contain `passed: true`; capability providers also expose
`capabilities: {"<provided-capability>": true}` after proving each capability.
The install owner must verify the installed archive boundary, not merely CLI
exit success. Preserve source, event, geometry, history and OS assertions in
their owning tests. `receipt.expect` checks additional dot-separated fields.
No exit code alone, old receipt or driver fixture establishes native acceptance.

`{session}` shares one invocation's setup directory; `{artifact}` supplies the
verified VSIX. `MEO_ACCEPTANCE_RUN_ID` identifies the invocation. Include all
external/shared helper and fixture inputs in `inputs`. Setup and cleanup can
own one VM boot for the whole batch; the coordinator does not manage another VM
or require repeating the full matrix in a VM. Cleanup owners must scope their
processes and files and tolerate partially completed setup.

Select requirements by actual risk. Keyboard scan codes, IME, physical Windows
input, file dialogs and Word need their own proven capabilities when relevant;
pointer CDP evidence cannot satisfy them. Use stable dialog control IDs rather
than English-only captions. Normal and forced-accessibility launches belong to
separate plans/evidence. Performance comparison uses the existing production
shell/readiness helper and the original complete samples, in exclusive time.

After current-task authorization:

```shell
bun run acceptance:native -- --plan=.local/acceptance/native-plan.json --output=.local/acceptance/native-1 --confirm-long-run
```

Execution is serial. Failure blocks only declared dependents/capabilities;
independent owners continue. Cleanup always runs. The single authoritative
`state.json` records run ID, per-owner status, exact log/receipt hashes and input
identity; read it instead of interpreting delayed notifications from old runs.
Keep other browser, performance and native jobs idle during this invocation.
The native lock prevents two instances of this entry; it does not lock arbitrary
commands or other terminal sessions.

During authorized unattended acceptance, a native batch's exit is a stage result,
not the end of the overall task. The acceptance executor reads this checkpoint,
resolves ordinary failures and continues to complete coverage and a verified final
package. Reserve final handoff for completion or a genuine remaining human dependency,
after finishing independent work; see the workflow's continuous-execution contract.

Use a new output directory for continuation:

```shell
bun run acceptance:native -- --plan=.local/acceptance/native-plan.json --output=.local/acceptance/native-2 --resume=.local/acceptance/native-1/state.json --same-environment --dispositions=.local/acceptance/dispositions.json --confirm-long-run
```

Only complete passing check owners with unchanged inputs and verified streams/
receipts are reused. Setup and actual capability probes run again. Interrupted
owners restart from their beginning. Recorded failures require a disposition
file bound to the SHA-256 of the previous `state.json`:

```json
{"reportHash":"<state.json SHA-256>", "failures":[{"id":"<failed-step>", "classification":"driver", "cause":"Observed cause", "correction":"Specific correction and verification"}]}
```

A source/driver/plan/environment change rejects automatic continuation; start
a new session and review old results through the evidence checklist. Preserve
all earlier failed reports. This is separate native checkpointing; it does not
relax `test:release --resume` or retry unexplained failures to green. If an
executor was terminated, verify its recorded process/children and perform owned
cleanup before removing a stale `.local/native-acceptance.lock`.
