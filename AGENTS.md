# AGENTS.md

This file applies to the entire repository. Follow a more specific nested `AGENTS.md` if one is added later. The user's request takes precedence over this guide.

## Project orientation

Lathe is a source-run, loopback-only, single-operator web workbench for manual AI red teaming. The server owns authoritative state; the browser is an editor and navigator over that state. Before changing behavior, read:

- `README.md` for setup, workflows, and supported scope;
- `ARCHITECTURE.md` for package boundaries and persistence rules;
- `SECURITY.md` for trust boundaries and credential handling;
- `docs/settings-provider.md`, `docs/tools.md`, or `docs/payload-workbench.md` when working in those areas.

Do not expand Lathe into a hosted, multi-user, or autonomous system unless the task explicitly requires it.

## Toolchain

- Node.js 24.x.
- pnpm 11.x, pinned with integrity in the root `packageManager` field.
- Use pnpm only. Do not add a second pnpm version to CI or use npm/yarn lockfiles.
- Install with `pnpm install --frozen-lockfile` when the lockfile is expected to be current.
- The repository is strict ESM TypeScript. Local relative imports use emitted `.js` extensions.
- Generated output (`dist`, coverage, Playwright artifacts, local databases, traces, and blobs) is not source and must not be committed.

## Workspace boundaries

| Path | Responsibility |
| --- | --- |
| `apps/web` | React/Vite UI, transcript/tree/compare workbench, settings, dialogs, and inspectors. |
| `apps/server` | Hono API, security middleware, run/tool/job/payload coordination, SSE, and production UI serving. |
| `packages/domain` | Shared records, strict Zod schemas, graph invariants, IDs, and JSON/hash utilities. |
| `packages/db` | SQLite/PostgreSQL schemas, migrations, repository implementation, and content storage. |
| `packages/providers` | OpenAI Responses, OpenAI Chat, and Anthropic request/stream adapters. |
| `packages/payloads` | Deterministic context/instruction compilation, variables, transforms, and pipelines. |
| `packages/agent-runtimes` | Codex App Server process/JSON-RPC integration. |
| `packages/execution` | QuickJS handlers, approvals/trust, and host/container/SSH execution. |
| `packages/mcp` | Official-SDK MCP clients, capabilities, approvals, tracing, and policy. |
| `packages/automation` | Replay, fan-out, and batch planning primitives. |
| `packages/artifacts` | Harness/finding archive schemas, validation, redaction, import, and export. |
| `packages/harness` | Built-in assets and harness resolution. |

Shared packages must not import from either application. Put portable contracts in `packages/domain` and reusable behavior in the narrowest relevant package.

## Core invariants

### Graph and evidence

- `MessageNode` records are immutable. Fork, rewind, and restore operations move branch/checkpoint references; they do not rewrite transcript history.
- Validate project/session/branch/node ownership before any mutation. The server reconstructs authoritative paths; never trust a client-supplied path.
- Every target-model run freezes the exact effective configuration in a `ConfigSnapshot`.
- Library assets are immutable revisions. Editing creates a new revision; mutable session drafts point to exact revisions.
- Payload helper generations, attempts, and revisions stay separate from conversation `ModelRun` records. They may enter the graph only when the operator explicitly uses a payload in the composer.
- Preserve partial text, reasoning, stop/refusal signals, fallback history, usage, and raw transport evidence. These can coexist in one provider stream.
- Do not add automatic provider retries. A captured tool call that precedes a policy stop still follows normal approval/execution while retaining the blocked classification.

### Tools and runtimes

- Tool failures are model-facing results. Preserve `isError` and failure evidence, and allow configured bounded continuation unless approval, cancellation, or limits require a stop.
- Manual approval is the default. Bypass approval must remain an explicit, snapshotted session choice.
- Approval evidence must describe the effective command, arguments, target, environment names, and launcher that will actually execute.
- Session trust is bound to exact tool/implementation and target revision identities/hashes. Editing either invalidates trust.
- Never execute an imported or otherwise untrusted tool implementation, execution target, or stdio MCP profile without an explicit trusted revision.
- QuickJS compilation is not an execution sandbox for the resulting host/container/SSH command.
- Codex helper profiles use the operator's trusted absolute executable and existing ChatGPT login. Do not copy auth state, silently fall back to API-key billing, broaden workspace access, or accept App Server approval/tool/app requests.

### Secrets and redaction

- Provider and static MCP credentials are plaintext local data in v1. Never print, return, or commit them.
- The global redaction switch controls heuristic evidence filtering only. Exact managed credentials and Codex control-plane auth/account values remain protected in every mode.
- Ordinary provider/asset APIs and all exports must stay credential-safe even when heuristic redaction is disabled.
- Keep semantic values used for provider continuation or execution separate from sanitized API/UI/trace views. Never show an approval for one command and execute a different hidden value.
- Preserve loopback binding, bearer-token authentication, origin checks, CSP, and sanitized Markdown rendering.

### Persistence and artifacts

- SQLite and PostgreSQL implement the same repository contract. A schema change requires both schema files, additive migrations for both dialects, both migration journals, and contract coverage.
- Do not rewrite an existing released migration. Add the next numbered migration.
- PostgreSQL replaces relational storage only; blobs and traces remain in `LATHE_DATA_DIR`.
- Restart recovery must mark in-flight jobs/runs/helper generations interrupted rather than silently resuming external work.
- Content blobs are SHA-256 addressed. Validate ownership, declared sizes, hashes, paths, and archive limits at trust boundaries.
- Imports keep executable assets untrusted. Finding round trips must retain referenced configuration/evidence lineage while remapping IDs and excluding credentials/auth state.

## Coding conventions

- Keep strict TypeScript green: avoid `any`, validate `unknown`, and respect `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Use two-space indentation, double quotes, semicolons, and existing naming patterns.
- Validate external input with strict Zod schemas before business logic. Return clear 4xx errors for invalid state instead of opaque 500s.
- Prefer small pure helpers for graph selection, transforms, compilation, and policy decisions; cover them directly.
- Use the shared API/query helpers and typed domain contracts rather than duplicating DTO shapes in views.
- Use `OperatorDialogProvider` for prompts and confirmations; do not introduce `window.prompt` or `window.confirm`.
- Use the shared `RenderedMarkdown` component for model-authored Markdown. Raw text remains authoritative and must stay available.
- Keep controls keyboard-accessible, labeled, focus-visible, and usable at supported UI font scales. Constrain local overflow instead of adding page-level horizontal scrolling.
- Preserve existing user changes in a dirty worktree. Do not reformat or rewrite unrelated files.

## Dependency changes

- Add external versions as exact stable entries in the root `catalog`; package manifests use `catalog:`. Internal dependencies use `workspace:*`.
- Do not weaken the release-age, peer, exotic-source, lockfile-trust, or lifecycle-build policies to make an install pass.
- Add lifecycle packages to `allowBuilds` only after an explicit supply-chain review.
- Keep lockfile changes isolated and inspect origins, integrity hashes, optional/native code, and build scripts.
- Run `pnpm check:deps` after any manifest, catalog, lockfile, or CI package-manager change.

## Validation

Run the smallest relevant checks while iterating, then expand according to risk:

```sh
# Focused test file
pnpm exec vitest run apps/server/test/example.test.ts

# One workspace
pnpm --filter @lathe/server typecheck
pnpm --filter @lathe/server test

# Repository-wide
pnpm typecheck
pnpm test
pnpm build

# Browser acceptance
pnpm test:e2e

# PostgreSQL contract (requires an explicit disposable test database)
LATHE_TEST_POSTGRES_URL='postgresql://...' pnpm test:postgres
```

Also run `git diff --check` before handoff. Use deterministic local fixtures for providers, MCP servers, and Codex App Server tests; CI must not require real credentials, subscriptions, network services, or operator home-directory state.

Minimum expectations by change type:

- Domain/schema change: domain tests plus all affected package/app typechecks.
- Repository/migration change: fresh and migrated SQLite tests, shared repository contract, and PostgreSQL contract when available.
- Provider/MCP/runtime streaming change: fragmented-event, partial-output, cancellation, classification, and redaction tests.
- UI behavior change: focused Testing Library coverage; add Playwright when browser layout, downloads, clipboard, SSE, or cross-component integration matters.
- Security/export change: regression tests proving managed credentials cannot cross ordinary API, trace, or artifact boundaries.

If a required environment is unavailable, report exactly what was not run and why. Never claim a real provider, PostgreSQL, browser, or subscription test passed unless it actually ran.

## Handoff and commits

- Summarize behavior changed, important tradeoffs, and validation performed.
- Call out migrations, compatibility boundaries, skipped checks, and operator-visible security implications.
- Keep commits cohesive and include only intended files. Never rewrite history, discard user work, or use destructive Git commands without explicit authorization.
