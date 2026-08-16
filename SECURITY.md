# Lathe security model

Lathe is a local red-team workbench that intentionally handles adversarial text, model credentials, untrusted model output, and operator-approved command execution. Its controls reduce accidental exposure and preserve evidence; they do not turn a developer workstation into a hostile-code sandbox.

## Supported deployment

The v1 security model covers one trusted operator running Lathe from source on macOS or Linux. The server must remain loopback-only. Cloud hosting, LAN exposure, reverse proxies, shared accounts, untrusted local users, and multi-user authorization are unsupported.

At launch, Lathe:

- rejects non-loopback bind hosts;
- creates a random API bearer token unless `LATHE_API_TOKEN` is set;
- prints a tokenized launch URL, then the UI removes the token from the address bar and keeps it in tab-scoped session storage;
- requires the token for ordinary `/api` calls and checks browser origins against loopback names;
- emits a restrictive Content Security Policy, no-referrer policy, same-origin resource policy, and `nosniff` headers;
- renders model Markdown with raw HTML disabled and sanitization enabled.

`/api/health` is intentionally unauthenticated and returns only service health/version information.

## Secrets and local data

**Provider and static MCP credentials are stored plaintext in v1.** They are protected only by operating-system account and directory permissions. Do not use Lathe on a shared or untrusted host, and prefer narrow, revocable API keys with provider-side spending/rate limits.

The data directory is created as `0700` and the SQLite database as `0600` where the platform supports POSIX permissions. A PostgreSQL deployment protects relational data according to that server's configuration, but attachments and trace blobs still live in `LATHE_DATA_DIR`. Remote PostgreSQL connections must request TLS through `sslmode=require`, `verify-ca`, or `verify-full`; use certificate verification when possible.

Backups, filesystem snapshots, shell history, process inspection, database administration tools, and crash dumps may expose plaintext data. Treat the full data directory and database as sensitive.

Lathe omits credentials from ordinary provider APIs and redacts configured secret fields/values in traces and artifacts. Redaction is best-effort and context-aware, not a general data-loss-prevention system. A prompt, response, attachment, tool output, or operator note may contain a secret that Lathe was never told about. Review every export before sharing it.

## Provider requests

Provider profiles may point at arbitrary HTTP(S) endpoints. The selected endpoint receives the compiled system prompt, branch transcript, enabled tool schemas, supported attachments, and configured request metadata. A gateway compatible with an OpenAI or Anthropic wire format is still a separate trust domain; inspect its URL and policy before use.

Extra profile/request body fields cannot overwrite Lathe-owned fields such as `model`, `input`/`messages`, `tools`, or `stream`. There are no automatic retries, preventing Lathe from silently repeating a sensitive or costly request. Raw response frames are retained in redacted traces because failures may arrive after an HTTP 200 streaming response.

## Tool execution

QuickJS isolates the JavaScript that transforms a model tool call into an `ExecutionRequest` and formats the captured result. The handler has no imports, filesystem, network, process, or environment access, and runs with CPU, memory, stack, and serialized-output limits.

That isolation ends at the execution request. When the operator approves a host, container, or SSH target, the selected program runs with the permissions available to that target:

- host commands can read/change anything allowed to the Lathe process account;
- container commands run inside an **existing** Docker/Podman container with whatever mounts, privileges, and network access it already has;
- SSH commands run through the system OpenSSH configuration/agent/key reference and can affect the remote account;
- cancellation can be uncertain after a transport or remote-host failure.

Approval is required by default and displays the original arguments, edited arguments, resolved program/args, cwd, environment names, target, and timeout. Session-only trust is bound to an exact implementation/tool revision hash and target ID. Editing either invalidates trust.

A session may explicitly select **Bypass approval** for real and MCP tool calls. In that mode, commands start without a per-call operator decision, although the snapshotted policy, resolved launcher, arguments, output, and bypass decision remain evidence. Asset trust checks, handler isolation, execution limits, and separate MCP sampling/elicitation approvals still apply. Combining bypass approval with automatic tool continuation allows a bounded command sequence to run without stopping between calls; use a narrowly privileged target and a small turn limit. Never enable bypass for a command/target combination you would not run directly in a terminal.

A provider can emit a structured tool call before ending its stream with a
policy block or refusal. Lathe keeps the blocked classification and evidence,
but a structurally valid captured call still follows the configured approval
policy. Lathe does not reconstruct incomplete JSON or repair partial command
text: it presents or executes only the exact captured arguments. Under manual
approval, review that command as usual. Under bypass approval, a
provider-truncated but syntactically valid command may execute immediately and
fail or have effects before the block is shown; constrain bypass targets
accordingly. Natural execution errors remain evidence and may be returned to
the model when automatic continuation is enabled.

Private SSH keys are referenced by path and are not copied into Lathe. Strict host-key checking and batch mode are required; maintain a trustworthy `known_hosts` file and SSH configuration.

## MCP

MCP servers are code and content from another trust domain. A stdio server executes as a local/target process; a Streamable HTTP server receives requests over the configured URL. Lathe does not support MCP OAuth in v1, so static bearer/custom headers and stdio environment values are sensitive plaintext configuration.

Roots default to none and must be explicitly selected. Sampling and elicitation always require separate operator approval and never inherit normal tool trust. Prompts/resources are treated as untrusted content until the operator explicitly imports or attaches them. Negotiated schemas and JSON-RPC/progress/logging evidence are snapshotted and redacted, but may still contain sensitive task data.

## Attachments and artifacts

Attachments preserve exact bytes in a SHA-256-addressed content store. Lathe does not claim that uploaded files are malware-free. Opening an exported attachment in another application can invoke that application's parsers; use appropriate isolation for suspicious files.

Artifact import validates path safety, declared hashes and sizes, file counts, compression expansion, manifest schemas, and supported ZIP features. Imported scripts remain disabled/untrusted. These checks reduce archive attacks but do not make imported content trustworthy.

## Dependency integrity

The repository pins Node/pnpm compatibility, the pnpm release plus SHA-512 digest, every external workspace dependency through an exact stable root-catalog entry, a stable override for the only upstream prerelease edge, and the lockfile. `pnpm check:deps` enforces the manifest/catalog policy. pnpm workspace controls delay new releases for seven days, reject missing timestamps, block exotic transitive dependencies, prevent trust downgrades, and require an explicit lifecycle-build allowlist.

Dependency updates should be reviewed as security changes. Inspect lockfile origin/integrity changes and every package requesting a build script. Never broaden `allowBuilds` merely to make installation succeed.

## Operational checklist

Before a real engagement:

1. Use a dedicated OS account or disposable machine when the target material is sensitive.
2. Set restrictive provider credentials and verify every provider/MCP URL.
3. Choose an isolated `LATHE_DATA_DIR`; confirm its permissions and backup policy.
4. Prefer a constrained container or SSH account over host execution.
5. Review tool revisions and resolved commands before granting session trust or enabling bypass approval.
6. Keep MCP roots empty unless a server genuinely needs a specific directory.
7. Review traces and export contents before sharing or filing a report.
8. Stop Lathe when finished and revoke temporary provider credentials.

## Reporting vulnerabilities

Do not include real engagement data, provider keys, traces, or weaponized payloads in a public report. If this repository is hosted on a platform with private security advisories, use that channel. Otherwise contact the maintainer privately and provide the smallest synthetic reproduction needed to demonstrate the issue.
