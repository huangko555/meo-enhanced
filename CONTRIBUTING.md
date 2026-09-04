# Contributing to MEO Enhanced

Thank you for helping improve MEO Enhanced. Keep changes small, focused, and
easy to verify: one semantic intent per change, with tests chosen for the risk
that changed.

## Prerequisites and setup

- Install [Bun](https://bun.sh/). The repository uses Bun for dependency
  installation, scripts, tests, and builds, but does not currently pin a Bun
  version in `package.json`.
- Use VS Code `^1.97.0`, the compatibility range declared by the extension.
- The repository does not declare a separate Node.js engine range. Do not infer
  a project-specific Node.js minimum from a local environment.

Install the locked dependencies with the same command used by CI:

```shell
bun install --frozen-lockfile
```

## Develop and verify

Use the tiered workflow in [docs/testing-workflow.md](docs/testing-workflow.md).
For normal development, run the quick gate after a coherent change and add the
targeted pack for the affected high-risk area:

```shell
bun run test:quick
bun run test:targeted -- table
```

The feature contracts in `package.json` remain available when one narrower
contract is sufficient during the implementation loop.

Before submitting a change, run the relevant feature contract and the baseline
checks that match its risk. The **CI checks** workflow runs on Ubuntu and Windows
for pull requests and branch pushes. Tag pushes do not duplicate these checks.
Each platform runs:

```shell
bun run typecheck
bun run architecture:check
bun run test:unit
bun run build
bun run package:check
```

`package:check` runs after the build and verifies the local VSIX file listing;
it does not publish or upload an extension.

For broad runtime changes, production ownership cutovers, and feature or
project milestones, intentionally start the guarded release workflow:

```shell
bun run test:release -- --confirm-long-run
```

It includes the full `bun run test` suite. Use `bun run test`, not `bun test`;
the latter invokes Bun's built-in test discovery and is not this repository's
test pipeline. Full-document stress is separately available through
`bun run test:endurance` and should be scheduled deliberately.

### Full-suite expectation

The full suite is expected to finish with exit code 0. The repository has no
known-failure baseline. Do not skip, rename, or soften a failing test to obtain a
green run; investigate and fix the underlying regression instead.

## Architecture boundaries

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
