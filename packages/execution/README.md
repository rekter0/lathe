# @lathe/execution

Backend-only execution primitives for Lathe. Commands are represented as a
program and argv vector and are always spawned with `shell: false`. If a tool
author wants shell syntax, the handler must explicitly return a shell program,
for example `{ "program": "/bin/sh", "args": ["-c", "..."] }`, so the
approval screen can show that boundary.

Host targets do not inherit Lathe's process environment by default. Use an
absolute program path or configure an explicit `PATH`; full inheritance is an
opt-in target setting that should be visible during approval.

## Real tool handlers

A handler is synchronous CommonJS-style JavaScript. It can assign an object to
`module.exports`, attach methods to `exports`, or declare top-level `build` and
`formatResult` functions:

```js
function build(input) {
  return {
    program: "/usr/bin/printf",
    args: ["%s", input.text],
    timeoutMs: 10_000,
  };
}

function formatResult(result) {
  return {
    output: result.stdout.text,
    exitCode: result.exitCode,
  };
}
```

Production evaluation creates a disposable Node worker and a fresh
QuickJS/Wasm runtime for each phase. Handlers receive JSON and get no host
imports, filesystem, network, process, or environment bindings. QuickJS CPU,
heap, stack, input, source, and output limits are backed by a wall-clock worker
termination deadline.

The QuickJS sandbox protects the Lathe process from handler code. It does not
make an approved command safe: host, container, and SSH commands have their own
approval and target policies.

## Cancellation

Host commands are placed in a process group and Lathe sends SIGTERM followed by
SIGKILL after a short grace period. Killing a Docker/Podman or SSH client cannot
prove that the container/remote child stopped, so those results explicitly use
`best_effort` cancellation certainty.
