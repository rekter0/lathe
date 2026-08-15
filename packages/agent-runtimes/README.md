# `@lathe/agent-runtimes`

This package contains process-backed generation runtimes that are deliberately
separate from Lathe's HTTP provider adapters. Its initial adapter embeds the
official Codex App Server over newline-delimited JSON-RPC on stdio.

## Codex App Server boundary

- Profiles contain an absolute executable path and the literal
  `chatgpt-subscription` auth policy. They never contain API keys, OAuth tokens,
  access tokens, cookies, account IDs, or auth-cache contents.
- Profiles may point at a dedicated, already-authenticated absolute `codexHome`.
  This is the preferred isolation boundary because it avoids loading unrelated
  user-wide Codex configuration. Codex may still refresh credentials in that
  externally managed home; Lathe never reads, copies, returns, or exports them.
- Codex remains responsible for its existing local ChatGPT login, credential
  store, refresh lifecycle, and vendor policy. The adapter calls `account/read`
  for every probe and generation and fails closed unless the observed auth type
  is explicitly `chatgpt`.
- Only a small non-secret environment allowlist is inherited. In particular,
  OpenAI API keys and Codex access-token environment variables are not passed to
  the child. An API-key account cannot silently pass the subscription gate.
- Each generation uses an ephemeral App Server process, an ephemeral Codex
  thread, `approvalPolicy: "never"`, disabled web search, and a structured
  read-only sandbox policy with restricted readable roots. Isolated mode uses a
  disposable empty 0700 directory unless the caller supplies an empty absolute
  directory. Project mode adds only the explicitly selected workspace to the
  platform-default readable roots. This is a request to the installed Codex
  runtime, not an independent operating-system security boundary supplied by
  Lathe.
- A generation can explicitly fork or resume a documented native Codex thread
  ID. Fork is the preferred mapping for Lathe because it preserves the source;
  resume appends to the vendor-owned native thread. Fork can optionally target a
  completed source turn. Continuity failures are errors unless the caller
  explicitly selects `fresh-with-warning`, in which case the run and
  `runtime.ready` event report `lossy-fresh` and emit a visible lossy-boundary
  warning. Fork/resume responses request `excludeTurns` so hidden history is not
  duplicated into ordinary traces.
- The process is launched with direct argv and `shell: false`. Cancellation asks
  App Server to `turn/interrupt`, then terminates the detached process group with
  SIGTERM and a bounded SIGKILL fallback.
- Every server-initiated JSON-RPC request is rejected. This includes command and
  file approvals, user-input requests, dynamic tools, MCP elicitation, app calls,
  external-auth refresh, and unknown future request methods. No custom tool or
  MCP bridge is enabled by this package.
- App Server stdout, stderr, requests, responses, and notifications are redacted
  before crossing the package boundary. Account emails/IDs, auth fields, URL
  credentials, query secrets, bearer tokens, common key formats, and Codex home
  paths are removed. The package writes no traces or credentials to disk.

## Evidence and compatibility warnings

The trace is the App Server protocol trace, not the raw upstream Responses API
transport. Codex owns its internal prompt, tools, model request, retries, and
credential storage. A finding must record the Codex version and treat replay as
runtime-version-bound.

The adapter implements the current stable method names (`initialize`,
`account/read`, `model/list`, `thread/start`, `turn/start`, and
`turn/interrupt`) and current text/reasoning notifications. Parsing tolerates a
small set of documented older/alternate response fields and punctuation/casing
changes in notification names. Unknown notifications remain in the redacted raw
trace. Missing or ambiguous authentication, thread IDs, turn IDs, malformed
JSON, oversized frames, and process crashes fail closed.

The SHA-256 reported by probes covers only the resolved executable entry file.
For script launchers or package-managed installations, it does not attest the
entire dependency tree; callers should also pin and record the tested Codex
version.
