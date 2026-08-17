# Lathe

Lathe is a local, operator-driven workbench for manual AI red teaming. It keeps each conversation as an immutable tree so you can fork, rewind, compare, and reproduce an attack path without losing the evidence behind it.

Lathe is not an autonomous scanner or agent. The operator chooses the prompts, models, tools, branches, and approvals; Lathe manages execution, history, and evidence.

> **Early v1 software.** Run Lathe only on a trusted macOS or Linux machine. Provider and static MCP credentials are stored plaintext in the local database, and approved commands run with the authority of their selected target. Read [SECURITY.md](./SECURITY.md) before using real credentials or tools.

![Lathe workbench showing a branched conversation, a blocked model turn, and session configuration](./docs/images/workbench-overview.jpg)

## Highlights

- Immutable conversation nodes with named branches, checkpoints, rewind/fork, graph navigation, and side-by-side comparison.
- OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages adapters, including compatible gateways such as OpenRouter.
- Revisioned prompts, harnesses, tool definitions, execution targets, MCP profiles, and provider configurations.
- Manual, mock, host, existing container, SSH, and MCP tool execution with approval or explicit session bypass.
- Streamed text/reasoning, provider refusal and fallback classification, tool evidence, raw traces, annotations, and findings.
- Project-scoped attachments, provider-native branch JSON exports, and checksum-verified `.lathe-harness` and `.lathe-finding` bundles.
- A Payload Workbench for deterministic transforms, context-aware helper generation, candidate refinement/comparison, and immutable payload lineage.
- Persistent replay, fan-out, and batch jobs with bounded concurrency and partial-result retention.
- SQLite by default, with PostgreSQL available for relational storage.

## Requirements

- Node.js 24.x
- pnpm 11.4.0 (pinned with its integrity digest)
- macOS or Linux

## Run locally

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

If Node does not provide Corepack, install the pinned pnpm release using pnpm's documented standalone method, then run the final two commands.

The server prints a tokenized loopback URL. Open that exact URL; the UI moves the token into tab-scoped session storage and removes it from the address bar. Development uses Vite on `127.0.0.1:5173` and the API on `127.0.0.1:4317`.

For a built, single-process run:

```sh
pnpm start
```

## Data and configuration

Lathe reads configuration from the launching process and does not load `.env` files automatically. See [`.env.example`](./.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `LATHE_HOST` | `127.0.0.1` | Bind host; v1 accepts loopback hosts only. |
| `LATHE_PORT` | `4317` | API and built-UI port. |
| `LATHE_API_TOKEN` | Random per launch | API bearer token. Set a stable value only for controlled automation. |
| `LATHE_WEB_URL` | `http://127.0.0.1:5173` | Development UI URL used in the printed launch link. |
| `LATHE_DATA_DIR` | Platform data directory | SQLite, attachments, traces, exports, and staging data. |
| `LATHE_DATABASE_URL` | Unset | Unset or a file/SQLite path selects SQLite; `postgres://` or `postgresql://` selects PostgreSQL. |

Default data directories:

- macOS: `~/Library/Application Support/Lathe`
- Linux: `$XDG_DATA_HOME/lathe`, or `~/.local/share/lathe` when `XDG_DATA_HOME` is unset

Lathe creates the data directory as `0700` and SQLite as `0600` where supported. PostgreSQL replaces relational storage only; attachments and trace blobs remain under `LATHE_DATA_DIR`. Migrations run automatically at startup.

## First session

1. Open **Settings → Providers** and add a provider with the protocol its endpoint actually implements, its base URL and credential, and at least one model ID.
2. Create a project and session, then start from a built-in harness or select prompt/tool revisions manually.
3. Choose the provider/model, configure prompts and tools, preview the compiled configuration, and save the session draft.
4. Send an operator payload. Inspect its compiled request from the operator turn, streamed response/evidence from the model turn, and any tool approvals in the run inspector.
5. Fork or rewind from any node, compare branches, create checkpoints, and export a branch in the selected provider's request format.
6. Record useful outcomes as findings, or open the magic-wand Payload Workbench to transform, generate, refine, and explicitly reuse candidate payloads.

## Guides

| Guide | Covers |
| --- | --- |
| [Provider settings](./docs/settings-provider.md) | Protocols, endpoints, credentials, discovery, reasoning controls, and revisions. |
| [Tools and targets](./docs/tools.md) | Tool definitions, QuickJS implementations, host/container/SSH targets, approvals, and MCP behavior. |
| [Payload Workbench](./docs/payload-workbench.md) | Transform/Generate/History, context budgets, techniques, HTTP helpers, and Codex App Server profiles. |
| [Architecture](./ARCHITECTURE.md) | Package boundaries, graph and persistence model, generation flow, and artifacts. |
| [Security](./SECURITY.md) | Deployment assumptions, secrets, execution trust, helper runtimes, attachments, and exports. |
| [Agent guide](./AGENTS.md) | Repository invariants, coding conventions, dependency policy, and validation expectations. |

## Security essentials

- Keep the server loopback-only and treat `LATHE_DATA_DIR` and the database as sensitive plaintext data.
- Use narrow, revocable provider/MCP credentials and constrained execution targets. Approval UX is an audit and intent-control layer, not a sandbox.
- Heuristic evidence redaction is enabled by default and can be disabled for new safety-test operations. Exact credentials managed by Lathe remain protected, but unknown sensitive content may still appear in traces and exports.
- Codex helper profiles execute a trusted local binary as the Lathe OS user and rely on the installed App Server to enforce their read-only permission profile.
- Review every branch export, harness, finding, trace, and attachment before sharing it.

## Development

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Build packages and run the server and Vite UI in watch mode. |
| `pnpm start` | Build everything and run the production server locally. |
| `pnpm typecheck` | Check dependency policy, build packages, and type-check all workspaces. |
| `pnpm test` | Build packages and run the Vitest suite. |
| `pnpm test:postgres` | Run the repository contract against `LATHE_TEST_POSTGRES_URL`. |
| `pnpm test:e2e` | Run the Chromium acceptance suite and deterministic provider fixture. |
| `pnpm build` | Build all packages and applications. |
| `pnpm check:deps` | Verify dependency pins and supply-chain policy. |

Read [AGENTS.md](./AGENTS.md) before contributing. It contains the repository's implementation invariants, migration rules, dependency requirements, and change-specific validation checklist.

## v1 boundaries

Lathe v1 is source-run, single-operator, loopback-only software for macOS and Linux. It does not provide accounts, collaboration, cloud deployment, desktop packaging, or Windows support.

Out of scope:

- autonomous attack planning or scanning;
- automatic provider retries;
- legacy OpenAI `/v1/completions`;
- MCP OAuth, deprecated HTTP+SSE transport, or third-party MCP apps/extensions;
- extraction of proprietary prompts from installed coding agents;
- treating QuickJS or approval dialogs as a sandbox around an authorized command.

## License

[MIT](./LICENSE)
