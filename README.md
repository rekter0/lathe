# Lathe

Lathe is a local, operator-driven web workbench for manual AI red teaming. Its primary data model is a conversation tree: every message is an immutable node, while branches and checkpoints are movable references. That makes it possible to fork, rewind, compare, and reproduce an attack path without losing the evidence that led there.

Lathe is deliberately not an autonomous agent or a scanner. The operator chooses the prompts, models, tools, branches, and approvals; Lathe handles the transcript and evidence bookkeeping.

> **Early v1 software.** Run Lathe only on a trusted macOS or Linux machine. Provider and static MCP credentials are stored in plaintext in the local database. Approved host, container, and SSH commands run with the authority of the selected target. Read [SECURITY.md](./SECURITY.md) before using real credentials or tools.

## What is included

- Immutable conversation nodes, named branches, rewind/fork semantics, checkpoints, and aligned branch comparison.
- Copy-on-write session configuration with ordered prompt blocks, tool bindings, provider options, and immutable generation snapshots.
- Provider profiles for OpenAI Responses (`/v1/responses`), OpenAI Chat Completions (`/v1/chat/completions`), and Anthropic Messages (`/v1/messages`). Compatible gateways can use the matching protocol and a custom base URL.
- Lathe-maintained Blank, Claude Code-inspired, and Codex-inspired harnesses. The inspired harnesses are approximations, not extracted vendor prompts.
- Manual and deterministic mock tools, QuickJS-authored command builders/formatters, and host, existing Docker/Podman container, or system OpenSSH targets.
- MCP client support through the official TypeScript SDK over stdio and Streamable HTTP, with negotiated capability snapshots and explicit approval gates.
- Redacted raw provider/MCP traces, content-addressed attachments, persisted automation jobs, and checksum-verified `.lathe-harness` and `.lathe-finding` bundles.
- A Payload Workbench for deterministic transforms and pipelines, context-aware helper-model generation, independent candidate comparison/refinement, and immutable payload history.
- SQLite by default or PostgreSQL selected at startup, both behind the same repository contract.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for package boundaries and persistence rules, [docs/settings-provider.md](./docs/settings-provider.md) for provider endpoints and reasoning controls, [docs/tools.md](./docs/tools.md) for tool and execution-target examples, and [docs/payload-workbench.md](./docs/payload-workbench.md) for generator setup and the Transform/Generate/History workflow.

## Quick start

Prerequisites:

- Node.js 24.x
- pnpm 11.4.0 (the project pins both the version and its SHA-512 digest)
- macOS or Linux

With Corepack available:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

If your Node installation does not include Corepack, install pnpm 11.4.0 using pnpm's documented standalone method, then run the final two commands.

The server prints a tokenized loopback URL. Open that exact URL; the web app moves the launch token into tab-scoped session storage and removes it from the address bar. Development runs Vite on `127.0.0.1:5173` and proxies `/api` to the server on `127.0.0.1:4317`.

For a built, single-process run:

```sh
pnpm start
```

`pnpm start` builds all packages and applications, then serves the API and built UI from the Hono server.

## Configuration

Copy [`.env.example`](./.env.example) as a reference. Lathe reads environment variables from the launching process; it does not load `.env` files automatically.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LATHE_HOST` | `127.0.0.1` | Bind host. v1 rejects anything except `127.0.0.1`, `localhost`, or `::1`. |
| `LATHE_PORT` | `4317` | API port and built-UI port. |
| `LATHE_API_TOKEN` | random per launch | Bearer token embedded in the printed launch URL. Set a stable value only for controlled automation. |
| `LATHE_WEB_URL` | `http://127.0.0.1:5173` | Development UI URL used in the printed launch link when no built UI exists. |
| `LATHE_DATA_DIR` | platform application-data directory | Overrides the directory for SQLite, blobs, traces, and staging data. |
| `LATHE_DATABASE_URL` | unset | Unset selects SQLite. Set a `postgres://` or `postgresql://` URL for PostgreSQL; file/`sqlite:` values select a SQLite path. |

Default data directories are:

- macOS: `~/Library/Application Support/Lathe`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/lathe`

Lathe creates the data directory with mode `0700` where supported and the SQLite database with mode `0600`. Remote PostgreSQL URLs must set `sslmode=require`, `verify-ca`, or `verify-full`; loopback PostgreSQL may run without TLS. PostgreSQL replaces relational storage only—attachments and trace blobs stay in `LATHE_DATA_DIR`.

Example PostgreSQL launch:

```sh
LATHE_DATABASE_URL='postgresql://lathe:lathe@127.0.0.1:5432/lathe' \
LATHE_DATA_DIR='/absolute/path/to/lathe-data' \
pnpm start
```

SQLite and PostgreSQL migrations run automatically at server startup.

## First workflow

1. Open **Settings** and create a provider profile. Choose the exact protocol the endpoint implements, enter its base URL, credential, and one or more model IDs.
2. Create or import prompt/tool revisions, or start with one of the three built-in harnesses.
3. Create a project, then a session. The harness becomes an editable session draft; the original revision remains unchanged.
4. Select a provider/model and preview the compiled prompt and tools in the inspector.
5. Run a payload. Select any earlier node to fork, rewind, or checkpoint it; choose another branch in the comparison selector to inspect the divergence.
6. Review normalized output and the redacted raw trace. Resolve tool calls manually, with a mock, through an approved real target, or through an approved MCP server.
7. Save a reusable harness or record a finding and export its reproducible bundle.

Provider profile body/header overrides cannot replace Lathe-owned request fields such as the model, messages/input, tools, or streaming flag. Lathe does not retry provider requests automatically, and stream failures after an HTTP 200 remain classified failures with their preceding trace evidence.

## Payload Workbench

The magic-wand button beside the session composer opens three explicit, non-executing workflows:

- **Transform** applies allowlisted encoders, text transforms, framing helpers, variables, or a saved deterministic pipeline. Each persisted step is an immutable payload revision.
- **Generate** asks a separately configured helper model for one to four candidates. Project/session briefings, active-branch context, target configuration, reusable instructions, and ordered techniques are independently selectable and previewable.
- **History** restores prior generation and refinement groups without rewriting the conversation tree.

The separate **Payload Workbench settings** wand in the global toolbar is available on every page. It manages generator profiles, reusable instructions, techniques, pipelines, and defaults. HTTP generator profiles reuse existing provider revisions and secret handling. Codex App Server profiles reuse an installed Codex executable and its existing ChatGPT login; Lathe neither stores Codex tokens nor exposes the helper run as a target-model conversation turn.

Generated or partially generated text never runs automatically. **Use as next prompt** only copies the selected revision into the composer, where the operator can inspect or edit it before pressing **Run**. Read the complete setup, context-budget, subscription-backend, and provenance guide in [docs/payload-workbench.md](./docs/payload-workbench.md).

## Tools and MCP

A real JavaScript tool implementation is a synchronous QuickJS program with two entry points:

```js
function build(input) {
  return {
    program: "/usr/bin/printf",
    args: ["%s", String(input.text)],
    timeoutMs: 5000
  };
}

function formatResult(input) {
  return {
    stdout: input.stdout,
    stderr: input.stderr,
    exitCode: input.exitCode
  };
}
```

The QuickJS handler has no imports, filesystem, network, process, or environment access. Its output is an execution request; the approved target then executes exactly one program plus argument vector. A shell is never implicit—select `/bin/sh` (or an equivalent shell) as the visible program when shell syntax is intentional.

Every real or MCP tool call requires operator approval by default. A session can explicitly select bypass approval for tool calls; the choice is snapshotted and recorded, while MCP sampling and elicitation remain approval-gated. Session trust is scoped to the exact tool revision hash and target; editing either invalidates it. MCP roots default to none, and imported prompt/resource content remains untrusted until explicitly selected.

## Reproducible artifacts

Harness and finding exports are versioned ZIP bundles with a manifest, Markdown summary, role-separated content, and SHA-256 checksums. Import validation rejects unsafe paths, hash mismatches, malformed schemas, unsupported ZIP features, and configured size/expansion limits. Credentials are redacted or replaced by symbolic references; imported scripts are disabled and untrusted.

Do not treat export redaction as a substitute for review. Inspect a bundle before sharing it: transcripts, prompts, tool output, attachments, and model responses can contain sensitive information that is not a stored credential.

## Development commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Build shared packages, then run the server and Vite UI in watch mode. |
| `pnpm build` | Build every workspace package and app. |
| `pnpm check:deps` | Verify exact stable pins, toolchain integrity, and pnpm supply-chain policy. |
| `pnpm typecheck` | Build shared packages and type-check all workspaces. |
| `pnpm test` | Build shared packages and run Vitest suites. |
| `pnpm test:postgres` | Build shared packages and run the PostgreSQL repository contract. |
| `pnpm test:watch` | Run Vitest in watch mode. |
| `pnpm test:e2e` | Build/start an isolated app and deterministic provider, then run the full Chromium acceptance flow. |

Set `LATHE_TEST_POSTGRES_URL` to include the PostgreSQL repository contract in local tests:

```sh
LATHE_TEST_POSTGRES_URL='postgresql://lathe:lathe@127.0.0.1:5432/lathe_test' \
pnpm test:postgres
```

CI installs from the committed lockfile with `--frozen-lockfile`, verifies Linux and macOS on Node 24, exercises PostgreSQL on Linux, and runs the full Chromium acceptance workflow.

## Dependency policy

Every external workspace dependency resolves through the root catalog, whose entries use exact stable versions, and the workspace pins a stable override for the only upstream prerelease edge. `pnpm check:deps` enforces that shape. Workspace policy delays newly released packages for seven days, rejects missing release timestamps, blocks exotic transitive sources, prevents trust-policy downgrades, and fails on undeclared dependency build scripts. The audited build allowlist is intentionally small: `better-sqlite3`, `esbuild`, and `@tailwindcss/oxide`.

The workspace also records one narrow peer-compatibility exception: `@tailwindcss/vite` 4.1.13 predates Vite 8 in its published peer range, while Lathe's pinned Vite 8 build is verified by CI. Keep that exception package-scoped and remove it when the pinned Tailwind release declares Vite 8 support.

Lockfile changes should be isolated and reviewed. In particular, confirm registry/tarball origins, new lifecycle scripts, native code, and additions to `allowBuilds`. Drizzle ORM is pinned to `0.45.2`, the patched release selected for the SQL identifier escaping advisory.

## v1 scope and boundaries

The current v1 is source-run, single-operator, and loopback-only. It targets macOS and Linux. It has no accounts, collaboration, cloud deployment, desktop packaging, or Windows support.

Out of scope:

- autonomous attack planning or scanning;
- automatic provider retries;
- legacy OpenAI `/v1/completions`;
- MCP OAuth, deprecated MCP HTTP+SSE transport, or third-party MCP apps/extensions;
- scraping live Claude Code or Codex installations for proprietary prompts;
- treating QuickJS isolation or approval UX as a security boundary around commands the operator authorizes.

The implementation is organized as independently testable layers so later milestones can deepen automation, MCP surface area, artifact workflows, and UI polish without changing the immutable graph model or evidence contracts.

## License

[MIT](./LICENSE)
