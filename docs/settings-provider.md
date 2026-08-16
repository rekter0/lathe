# Provider settings

Provider profiles tell Lathe how to call a model endpoint. They are shared
across projects, stored as immutable revisions, and selected separately in each
session.

The protocol must match the endpoint's wire format, not the company that made
the model. For example, a Claude or DeepSeek model routed through OpenRouter's
Chat Completions endpoint still uses **OpenAI Chat Completions** in Lathe.

## Add a provider

Open **Settings → Providers**, then complete the **New provider profile** form:

1. Give the profile a recognizable label.
2. Select the protocol implemented by the endpoint.
3. Enter the base URL and, only if necessary, a generation endpoint override.
4. Enter the API credential and any required custom headers.
5. Enter at least one exact model ID, or save the profile and use **Discover
   models**.
6. Put provider-specific request options, such as reasoning controls, in
   **Extra request body (JSON)**.
7. Save the profile, create or open a session, and select its provider and
   model under **Config → Provider / model**.

Provider parameters are not standardized across every model or gateway. A JSON
object that works for one model can be rejected by another model behind the
same endpoint. Verify the selected model's current documentation and inspect
the redacted request trace after a test run.

## Field reference

| Field | Behavior |
| --- | --- |
| **Label** | Required display name, 1–120 characters. Include the service, purpose, or revision intent when that helps distinguish profiles. |
| **Protocol** | Selects Lathe's request compiler and stream parser. See [Protocols and URLs](#protocols-and-urls). |
| **Base URL** | Required absolute `http://` or `https://` URL. URL usernames and passwords are rejected. Lathe appends the protocol's default generation or model-list path. |
| **Generation endpoint override** | Optional absolute URL for generation when a compatible gateway uses a nonstandard path. It does not change model discovery. |
| **API credential** | Sent as a bearer token for both OpenAI-style protocols and as `x-api-key` for Anthropic Messages. It may be blank for an unauthenticated local endpoint. |
| **Initial/Add model ID** | Exact model identifier sent to the endpoint. Initial save allows an empty catalog, but a model is needed for normal session selection. Editing appends a new, nonduplicate ID; leaving it blank preserves the catalog. |
| **Custom headers (JSON)** | JSON object whose values must all be strings. Use for gateway-specific routing, attribution, or authentication headers. Header names are validated and CR/LF is rejected. |
| **Extra request body (JSON)** | JSON object merged into every generation made through this exact provider revision. Use it for supported provider-specific options such as reasoning, service tier, routing, or safety metadata. |

Both JSON editors require strict JSON: double-quoted keys and strings, with no
comments or trailing commas.

## Protocols and URLs

| Lathe protocol | Default generation request | Default model discovery request |
| --- | --- | --- |
| **OpenAI Responses** | `POST /v1/responses` | `GET /v1/models` |
| **OpenAI Chat Completions** | `POST /v1/chat/completions` | `GET /v1/models` |
| **Anthropic Messages** | `POST /v1/messages` | `GET /v1/models` |

Lathe avoids duplicating `/v1` when the base URL already ends in `/v1`.
Typical base URLs are:

```text
https://api.openai.com
https://api.anthropic.com
https://openrouter.ai/api/v1
http://127.0.0.1:8000/v1
```

Use **Generation endpoint override** only when appending the default path would
be wrong. It affects generation only. Model discovery still uses the base URL
plus `/v1/models`, and currently recognizes the OpenAI-style
`{"data":[{"id":"..."}]}` response shape.

## Credentials and headers

For OpenAI Responses and OpenAI Chat Completions, a nonempty API credential is
sent as:

```http
Authorization: Bearer <credential>
```

For Anthropic Messages it is sent as `x-api-key`; Lathe also supplies
`anthropic-version: 2023-06-01`. Lathe always sets
`content-type: application/json`.

Use the credential field rather than embedding a secret in a URL or request
body. If a compatible gateway requires another header, add it under **Custom
headers**. For example, optional OpenRouter attribution headers can be written
as:

```json
{
  "HTTP-Referer": "http://127.0.0.1",
  "X-OpenRouter-Title": "Lathe"
}
```

Credentials are stored in plaintext in the local Lathe database in v1. They
and custom header values are redacted from ordinary API responses and exports,
but the local database and running process must still be protected. See
[SECURITY.md](../SECURITY.md).

The global **Interface settings → Evidence redaction** switch controls
heuristic filtering of new model output, tool-shaped content, and raw evidence.
It is enabled by default. Disable it only when synthetic credential-shaped
content is part of the test and must remain exact. Exact credentials, custom
header values, and sensitive provider options already configured in Lathe stay
scrubbed in either mode. The setting does not rewrite earlier runs and is not a
substitute for reviewing traces or exports before sharing them.

When editing a profile, leaving **API credential** blank preserves the stored
credential. Select **Clear the stored credential in the new revision** to
remove it. Redacted header/body markers likewise preserve the stored value when
left untouched; remove a key to delete it or replace its marker to update it.

## Models and discovery

The model ID is sent exactly as entered. Examples include an OpenAI model ID,
an Anthropic model ID, or an OpenRouter slug such as
`deepseek/deepseek-chat-v3.1`.

After saving a provider, use its refresh button to call the authenticated model
list endpoint. Lathe previews the discovered IDs and warnings. **Save discovered
catalog** creates a new immutable provider revision; merely discovering models
does not change the profile.

Remote discovery results are merged with manually entered model IDs, with the
manual entry winning on conflicts. Lathe's current provider editor does not
show all gateway-specific model metadata—for example, OpenRouter's per-model
reasoning capabilities—so consult the service's model page or model-list JSON
before choosing an effort or token budget.

## Provider-wide options and session overrides

There are two places to add provider-specific body fields:

- **Settings → Providers → Extra request body** applies to every request using
  that immutable provider revision.
- **Session → Config → Protocol overrides** applies only to that session draft
  and is captured in every generation snapshot.

The Protocol overrides editor expects a map keyed by Lathe protocol, not a raw
request body. For example, this changes only OpenAI Chat-compatible requests in
the current session:

```json
{
  "openai-chat": {
    "reasoning": {
      "effort": "high",
      "exclude": false
    }
  }
}
```

Valid keys are `openai-responses`, `openai-chat`, and
`anthropic-messages`. Only the currently selected provider protocol is used.

The merge order is:

1. Provider profile **Extra request body**.
2. The current session's matching **Protocol overrides**; duplicate top-level
   keys replace the provider value.
3. Lathe's canonical request settings, including a nonblank session
   Temperature or Max output value.

The merge is shallow. If both layers contain `reasoning`, the entire later
`reasoning` object replaces the earlier one.

Lathe owns the fields that carry conversation state and tools. Trying to put a
protected field in Extra request body or Protocol overrides fails compilation
instead of silently replacing Lathe's value:

| Protocol | Protected top-level fields |
| --- | --- |
| OpenAI Responses | `model`, `input`, `instructions`, `tools`, `tool_choice`, `stream` |
| OpenAI Chat Completions | `model`, `messages`, `tools`, `tool_choice`, `stream` |
| Anthropic Messages | `model`, `messages`, `system`, `tools`, `tool_choice`, `stream`, `max_tokens` |

Set Temperature and Max output with the session's dedicated controls. When Max
output is blank, the Anthropic adapter must still send `max_tokens`, so Lathe
uses `4096` and records a compile warning.

## Reasoning and thinking

"Reasoning enabled" and "reasoning visible" are different properties. An
endpoint can perform internal reasoning without returning readable reasoning
text. Lathe displays only textual reasoning or summaries that the provider
actually returns; it does not reconstruct or reveal hidden chain of thought.

Use the recipes below in a provider's **Extra request body** for a
revision-wide default, or wrap them in the matching protocol key under a
session's **Protocol overrides** for a session-specific setting.

### OpenAI Responses

For a model that supports reasoning, request an effort level and a returned
summary with:

```json
{
  "reasoning": {
    "effort": "high",
    "summary": "auto"
  }
}
```

OpenAI reasoning effort support is model-specific. Current values can include
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; a given model
may support only a subset. `none` disables reasoning only where the selected
model permits it. A returned reasoning summary is not raw hidden chain of
thought.

Lathe renders Responses reasoning-summary and reasoning-text stream events in
the message's Reasoning section. OpenAI recommends Responses for new reasoning,
tool-calling, and multi-turn integrations. See the official
[OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
and [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create).

### Direct OpenAI Chat Completions

For a Chat Completions model that documents reasoning support, use its
top-level `reasoning_effort` field:

```json
{
  "reasoning_effort": "high"
}
```

The current API enum includes `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, and `max`, but support varies by model. This controls how much internal
reasoning the model performs; it does not guarantee that OpenAI returns readable
reasoning text. Prefer OpenAI Responses when the model and workflow support it.
See the official [Chat Completions request
reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

### OpenRouter Chat Completions

Configure OpenRouter with:

```text
Protocol: OpenAI Chat Completions
Base URL: https://openrouter.ai/api/v1
Model ID: provider/model
```

Enable the model's default reasoning configuration:

```json
{
  "reasoning": {
    "enabled": true
  }
}
```

Or choose an effort and explicitly keep returned reasoning visible:

```json
{
  "reasoning": {
    "effort": "high",
    "exclude": false
  }
}
```

For models with a direct reasoning budget, use `max_tokens` instead:

```json
{
  "reasoning": {
    "max_tokens": 8000,
    "exclude": false
  }
}
```

Use either `effort` or `max_tokens`, not both. `exclude: true` lets the model
reason but prevents the reasoning from being returned, so Lathe has nothing to
display. `effort: "none"` disables reasoning only when the selected model does
not require it. OpenRouter normalizes these controls to provider-native options;
consult the model-list response's `reasoning` metadata for supported efforts,
the default, whether a direct token budget is supported, and whether reasoning
is mandatory.

Lathe's Chat adapter recognizes streamed `reasoning`, `reasoning_content`, and
text/summary entries in `reasoning_details`. See OpenRouter's official
[reasoning-token guide](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

### Direct Anthropic Messages

Current adaptive-thinking models use `thinking.type` to select the thinking
mode and `output_config.effort` to steer depth:

```json
{
  "thinking": {
    "type": "adaptive",
    "display": "summarized"
  },
  "output_config": {
    "effort": "high"
  }
}
```

`display: "summarized"` matters for observability: on the newest models,
including Claude Fable 5, the default is `omitted`, which returns no readable
thinking text. Fable 5 has thinking on by default and rejects
`thinking: {"type":"disabled"}`. Effort levels and disable behavior remain
model-specific.

Older models that support manual extended thinking instead use a token budget:

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 4096,
    "display": "summarized"
  }
}
```

For manual thinking, the budget is at least 1024 tokens and the session Max
output must leave room for both thinking and the final answer. New adaptive-only
models reject manual `type: "enabled"`, while older extended-thinking-only
models reject `type: "adaptive"`.

Leave Lathe's session Temperature blank for current adaptive-thinking models.
Anthropic documents that some current models reject nondefault `temperature`,
`top_p`, or `top_k` values. Lathe renders returned `thinking` blocks and
`thinking_delta` events, but not encrypted signatures or redacted blocks.

See Anthropic's official [thinking
guide](https://platform.claude.com/docs/en/build-with-claude/thinking), [effort
reference](https://platform.claude.com/docs/en/build-with-claude/effort), and
[manual extended-thinking
guide](https://platform.claude.com/docs/en/build-with-claude/extended-thinking).

### Other compatible endpoints

Choose the protocol matching the endpoint and use only the request fields that
its documentation accepts. A local OpenAI-compatible server might need no
credential and may use a custom base such as `http://127.0.0.1:8000/v1`.
Reasoning fields are not inferred from the model name: put the gateway's exact
options in Extra request body or the matching session Protocol override.

## Payload Workbench helper profiles

The Payload Workbench's HTTP generator profile reuses a provider revision, but
its **Reasoning → Capture/Disable** setting supplies its own request-level
reasoning object. Because request-level options are merged after provider Extra
request body, this control replaces a provider-level `reasoning` or `thinking`
object for helper-model generations. A session's Protocol overrides configure
the target conversation and are not applied to the separate helper call.

The current mappings are:

| HTTP protocol | Capture | Disable |
| --- | --- | --- |
| OpenAI Responses | `{"reasoning":{"effort":"medium","summary":"auto"}}` | `{"reasoning":{"effort":"none"}}` |
| OpenAI Chat Completions | `{"reasoning":{"enabled":true}}` | `{"reasoning":{"enabled":false}}` |
| Anthropic Messages | `{"thinking":{"type":"adaptive"}}` | `{"thinking":{"type":"disabled"}}` |

These are broad compatibility defaults, not a precise thinking-level selector.
In particular:

- Direct OpenAI Chat uses `reasoning_effort`, so the HTTP generator's current
  OpenAI Chat mapping is intended for compatible gateways such as OpenRouter,
  not guaranteed for the direct OpenAI endpoint.
- Anthropic Capture does not currently add `display: "summarized"`; newest
  models can reason without returning visible reasoning. Fable 5 also rejects
  Disable. A separate provider-wide `output_config.effort` is retained, but the
  generator replaces the `thinking` object that would carry `display`.
- The generator maps Low/Balanced/High diversity to temperature. Diversity is
  not reasoning effort. For Anthropic models that reject nondefault sampling,
  set all three mapped temperatures to `1`.

The Codex App Server generator backend has a separate explicit **Reasoning
effort** selector (`low`, `medium`, `high`, or `xhigh`). Read
[payload-workbench.md](./payload-workbench.md) for the complete helper-generator
workflow.

## Revisions and deletion

Editing and saving a provider creates a new immutable revision. Existing
sessions, checkpoints, configuration snapshots, generations, and automation
plans remain pinned to the exact old revision until the operator selects the
new one. This makes old findings reproducible and means that fixing a profile
does not silently fix sessions using its earlier revision.

Deleting a provider revision uses the confirmation dialog. Lathe refuses the
deletion when anything still references the revision and reports those
references instead of silently breaking them.

## Current reasoning-state limitation

Lathe preserves normalized reasoning text and raw provider evidence with the
run, but target-conversation replay currently reconstructs history from text,
attachments, tool calls, and tool results. It does not reinsert provider-native
OpenAI reasoning items, OpenRouter reasoning details, or Anthropic
thinking/signature blocks into the next request.

This matters most inside a tool-use turn, where a provider may require its
reasoning blocks to be returned unchanged. A thinking-enabled tool continuation
can therefore lose reasoning continuity or be rejected by the provider. Treat
v1 traces as evidence, not as proof that native reasoning state was replayed
exactly, and inspect the request trace when testing these flows.

## Troubleshooting

### The endpoint returns “unknown field” or HTTP 400

- Confirm the protocol matches the endpoint rather than the model vendor.
- Check that the selected model supports the exact reasoning mode and effort.
- Remove provider-specific options, test a minimal request, then add them back
  one at a time.
- Check whether the session Protocol override replaced the provider's whole
  top-level `reasoning` or `thinking` object.
- For Anthropic, leave Temperature blank and make Max output large enough for
  thinking plus answer text.

### Lathe reports a protected-field compile error

Remove the named field from Extra request body and Protocol overrides. Configure
model, system prompt, messages, tools, streaming, Temperature, and Max output
through Lathe's dedicated controls.

### The model reasons, but no Reasoning section appears

- OpenRouter: ensure `exclude` is `false` and confirm that the model/provider
  actually exposes reasoning.
- Anthropic: use `display: "summarized"` on models that support it.
- Direct OpenAI Chat: reasoning effort does not guarantee readable reasoning
  output; use Responses and request a supported summary when appropriate.
- Inspect **Run → raw events** and the downloadable NDJSON trace to see
  the provider's actual response shape.

### Model discovery fails

Generation endpoint overrides do not change discovery. Verify that the base URL
serves an authenticated OpenAI-style `GET /v1/models`, or maintain exact model
IDs manually. Discovery warnings do not alter the saved catalog until **Save
discovered catalog** is selected.

### A corrected provider still behaves like the old one

Saving an edit creates a new revision. Reopen the session's **Config** panel,
select the new provider revision/model, and save the session draft. Existing
checkpoints and historical runs intentionally retain the old revision.

Lathe does not retry provider requests automatically. A stream can return useful
partial text or reasoning and then fail or be blocked; Lathe retains that
partial evidence and its terminal classification for inspection.
