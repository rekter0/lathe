# Tools and execution targets

Lathe separates a model-visible tool into three independently versioned pieces:

1. A **tool specification** describes the name, purpose, and JSON input schema sent to the model.
2. A **tool implementation** is either manual, a deterministic mock, a synchronous QuickJS handler, or an MCP binding.
3. An **execution target** decides where a real command runs: the Lathe host, an existing Docker/Podman container, or an SSH destination.

Editing any library item creates a new immutable revision. Existing session bindings remain pinned until the operator selects the new revision.

## Bash tool for an existing container

Under **Settings → Tools**, create a tool specification with:

- Label: `bash`
- Description: `Run a Bash command in the selected execution target`
- JSON Schema:

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "Bash source passed to /bin/bash -lc"
    },
    "stdin": {
      "type": "string",
      "description": "Optional standard input"
    }
  },
  "required": ["command"],
  "additionalProperties": false
}
```

Create a **real** tool implementation with this synchronous QuickJS source:

```js
function build(input) {
  var request = {
    program: "/bin/bash",
    args: ["-lc", String(input.arguments.command)],
    timeoutMs: 60000
  };
  if (typeof input.arguments.stdin === "string") {
    request.stdin = input.arguments.stdin;
  }
  return request;
}

function formatResult(input) {
  return {
    status: input.status,
    stdout: input.stdout.text,
    stderr: input.stderr.text,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    cancellation: input.cancellation
  };
}
```

The QuickJS handler only builds an execution request and formats the result. It has no filesystem, network, process, environment, or import access. `/bin/bash` must exist inside the selected container.

Create a container target under **Settings → Targets & MCP**:

```json
{
  "id": "app-container",
  "label": "Application container",
  "kind": "container",
  "runtime": "docker",
  "container": "my-running-container",
  "user": "1000:1000",
  "defaultCwd": "/workspace"
}
```

`runtime` may be `docker` or `podman`. `container` is the name or ID of an already-running container. `user` accepts the same username or `UID[:GID]` form as `docker exec --user`; numeric IDs are usually more reproducible. The selected user must be able to access `defaultCwd` and any files used by the command.

With the example above, a call is launched equivalently to:

```sh
docker exec -i --user 1000:1000 --workdir /workspace -- \
  my-running-container /bin/bash -lc '...model-provided command...'
```

The target user applies to every real tool bound to that target. If tools need different identities, create separate targets such as `container-appuser` and `container-root`. Do not hide the identity change inside the QuickJS implementation with `sudo` or `su`; keeping it in the target makes the effective launcher visible in approval evidence.

Finally, open the session’s **Config** inspector, set the tool mode to **real**, select the implementation revision, select the container target revision, and save the draft.

## Tool execution permission

Each session config has a **Tool execution permission** selector:

- **Manual approval** is the default. Every real or MCP tool call waits for the operator to approve once, trust the exact tool/target revisions for the session, or reject it.
- **Bypass approval** automatically runs real and MCP tool calls using their snapshotted tool and target revisions. Calls, arguments, resolved launchers, output, and the bypass decision are still recorded as evidence.

Bypass approval does not enable untrusted imported scripts, targets, or MCP profiles, and it does not bypass MCP sampling or elicitation approval. Manual tools still need an operator-supplied result; deterministic mocks still need the operator to use the saved mock result.

Be especially careful when combining **Bypass approval** with **Automatic tool continuation**: the model can issue and execute a bounded sequence of commands without stopping at each call. Use a narrowly privileged target, a non-root container user, explicit working directories, and the smallest practical continuation limit.

## Target environment

Optional target-level environment values are merged into every command executed on that target:

```json
{
  "id": "app-container",
  "label": "Application container",
  "kind": "container",
  "runtime": "docker",
  "container": "my-running-container",
  "user": "1000:1000",
  "environment": {
    "APP_ENV": "test"
  }
}
```

Lathe’s ordinary API and UI expose environment variable names but redact their values. When an operator edits the latest target revision, unchanged redaction markers preserve the prior server-side values; deleting a key removes it.
