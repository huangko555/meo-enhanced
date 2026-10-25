# Contributing to MEO Enhanced

Thank you for helping improve MEO Enhanced. Keep changes small, focused, and
easy to verify: one semantic intent per change, with tests chosen for the risk
that changed.

## Prerequisites and setup

- Install [Bun](https://bun.sh/). The repository uses Bun for dependency
  installation, scripts, tests, and builds, but does not currently pin a Bun
  version in `package.json`.
- Use VS Code `^1.94.0`, the compatibility range declared by the extension.
- The repository does not declare a separate Node.js engine range. Do not infer
  a project-specific Node.js minimum from a local environment.

Install the locked dependencies with the same command used by CI:

```shell
bun install --frozen-lockfile
```

The locked Shiki 4.2.0 tokenizer has a small patch in `patches/` so empty lines
advance TextMate state. Without it, HTML blocks can suppress all following
Markdown syntax colors. Bun applies it during installation to both Webview and
Node export builds. When upgrading Shiki, run
`bun scripts/test-shiki-empty-line-recovery.ts` before removing or updating it.

For visual CSS work, follow [the UI design guidelines](docs/ui-design-guidelines.md).
Start the `Run` launch configuration with F5; its prelaunch task builds the
extension and webview. In the **Extension Development Host** window, open a
Markdown file with MEO Enhanced. Keep the original window for editing source
and the new Development Host window for checking the result. Saving
`webview/src/styles.css` updates its open MEO editors immediately, without a
rebuild or window reload. The development extension watches that source file and
sends the new stylesheet to each open editor; the normal installed extension
uses the built CSS instead.

This live path covers CSS only. After changing Webview TypeScript, run
`bun run build:webview` and restart the `Run` session to load the new JavaScript.
If a CSS edit does not appear, check that the file was saved and that the visible
window is the Extension Development Host with a MEO editor open. The focused
contract for the live style path is `bun scripts/test-development-style-refresh.ts`.

## Develop and verify

Use the tiered workflow in [docs/testing-workflow.md](docs/testing-workflow.md).
When adding, moving or changing tests, follow the guide's
[test registration procedure](docs/testing-workflow.md#adding-or-changing-tests)
and run `bun run test:inventory`. Agents own this step without a user reminder.
For copy, existing icon replacements and local visual style changes, use the
guide's Light UI path: `bun run test:ui-light` builds the Webview, then complete
the scoped bilingual light/dark visual and affected-control functional smoke.
For behavior or other implementation changes, run core quick checks after a
coherent change and complete the affected-feature contracts. Use a full targeted
pack when the whole area is affected or the impact is unclear:

```shell
bun run test:quick
bun run test:targeted -- table
```

The feature contracts in `package.json` remain available for narrower changes.
Quick success alone does not certify a feature. Editor behavior changes also follow
[document-scale coverage](docs/testing-workflow.md#document-scale-coverage), including
evidence that the intended optimized path ran. The former broad quick matrix is
preserved as `bun run test:regression -- --confirm-long-run`; propose it for concrete
coverage gaps and obtain authorization instead of running it for every commit.

Before submitting a change, run the relevant feature contract and the baseline
checks that match its risk. The **CI checks** workflow runs on Ubuntu and Windows
for pull requests and branch pushes. Tag pushes do not duplicate these checks.
Each platform runs:

```shell
bun run typecheck
bun run test:inventory
bun run architecture:check
bun run test:unit
bun run build
bun run package:check
```

`package:check` runs after the build and verifies the local VSIX file listing;
it does not publish or upload an extension.

For a release candidate, or specific cross-cutting risks that exceed the normal
checks, follow the testing guide's
[long-run recommendation and authorization](docs/testing-workflow.md#long-run-recommendation-and-authorization)
before starting the guarded release workflow:

```shell
bun run test:release -- --confirm-long-run
```

It includes the full `bun run test` suite. Use `bun run test`, not `bun test`;
the latter invokes Bun's built-in test discovery and is not this repository's
test pipeline. Full-document stress is separately available through
`bun run test:endurance` and should be scheduled deliberately.

The release workflow builds first and records each test script separately. Test
failures are collected across the remaining independent checks, and any failure
still fails the gate. Do not run an additional complete quick gate immediately
before an authorized release gate. See the testing guide for reports and the
strict same-input resume procedure; changed candidates and known failures
require a fresh run.

Ordinary commits, merges, and feature milestones use scope-appropriate checks
and reusable evidence as described in
[validation for commits and merges](docs/testing-workflow.md#validation-for-commits-and-merges).

### Full-suite expectation

The full suite is expected to finish with exit code 0. The repository has no
known-failure baseline. Do not skip, rename, or soften a failing test to obtain a
green run; investigate and fix the underlying regression instead.

## Architecture boundaries

When a change affects input, rendering, layout, scrolling, focus, history, mode
transitions, or background work, apply the
[editor performance contracts](docs/editor-performance-contracts.md). Assess
this proactively for ordinary and large documents, including controls and styles
that affect those behaviors.

- Every state value has one authoritative owner; projections and caches must be
  rebuildable and must not become a second source of truth.
- Keep compile-time dependencies directed from Bootstrap to concrete Adapters,
  then through Application-owned interfaces to Application and Domain rules.
  Domain and Application code must not depend on DOM, CodeMirror, VS Code, or
  other concrete frameworks.
- Host and Webview communicate through the single Protocol contract. Decode and
  validate `unknown` input at that boundary before it reaches Application code;
  do not introduce parallel message shapes or permissive fallback decoders.
- Define disposal and late-completion behavior for transports, subscriptions,
  timers, observers, resource pools, and browser or editor handles.
- Replace production ownership atomically. Do not add feature-flagged, shadow,
  or double-write paths, and delete the superseded Legacy owner and obsolete
  tests once the replacement is proven.

`.codegraph` is an optional local navigation aid for ownership and impact
analysis. It is derived data, is not required for contributors, and must not
become a CI, build, or release dependency. Dynamic Protocol, DOM, and lifecycle
behavior still requires source inspection and observable contracts.

## Change hygiene

- Prefer a small semantic diff over unrelated cleanup or speculative abstractions.
- Test through stable public interfaces and observable behavior, not private
  fields, callback counts, or implementation names.
- Never commit credentials, tokens, private keys, personal machine paths, local
  environment files, generated indexes, or identifying information that is not
  intentionally public.
- Review the staged diff before committing and keep generated or unrelated files
  out of the change.
