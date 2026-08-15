import { describe, expect, it } from "vitest";

import {
  buildContainerExecCommand,
  ContainerExecutionAdapter,
} from "../src/targets/container.js";
import {
  buildRemoteCommand,
  buildSshCommand,
  quotePosixArgument,
  SshExecutionAdapter,
} from "../src/targets/ssh.js";
import type {
  ContainerExecutionTarget,
  SshExecutionTarget,
} from "../src/types.js";

describe("container target", () => {
  it("builds docker exec argv without exposing environment values", () => {
    const target: ContainerExecutionTarget = {
      id: "container-1",
      label: "Existing app container",
      kind: "container",
      runtime: "docker",
      container: "lathe-target",
      user: "1000:1000",
      environment: { TARGET_SECRET: "do-not-put-in-argv" },
    };
    const command = buildContainerExecCommand(target, {
      program: "/usr/bin/printf",
      args: ["%s", "hello; exit 9"],
      cwd: "/work",
      environment: { REQUEST_VALUE: "request-secret" },
    });

    expect(command.program).toBe("docker");
    expect(command.args).toEqual([
      "exec",
      "-i",
      "--user",
      "1000:1000",
      "--workdir",
      "/work",
      "--env",
      "REQUEST_VALUE",
      "--env",
      "TARGET_SECRET",
      "--",
      "lathe-target",
      "/usr/bin/printf",
      "%s",
      "hello; exit 9",
    ]);
    expect(command.args.join(" ")).not.toContain("do-not-put-in-argv");
    expect(command.args.join(" ")).not.toContain("request-secret");
    expect(command.environment.TARGET_SECRET).toBe("do-not-put-in-argv");
  });

  it("executes through the configured runtime and records best-effort cancellation", async () => {
    const adapter = new ContainerExecutionAdapter();
    const target: ContainerExecutionTarget = {
      id: "fixture-container",
      label: "Fixture container",
      kind: "container",
      runtime: "docker",
      runtimePath: "/bin/echo",
      container: "fixture",
    };
    const completed = await adapter.execute(target, { program: "true" });
    expect(completed).toMatchObject({ status: "completed", cancellation: "not_requested" });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await adapter.execute(target, { program: "true" }, { signal: controller.signal });
    expect(cancelled).toMatchObject({ status: "cancelled", cancellation: "best_effort" });
  });
});

describe("SSH target", () => {
  const target: SshExecutionTarget = {
    id: "ssh-1",
    label: "Lab machine",
    kind: "ssh",
    destination: "operator@lab.example",
    identityFile: "/keys/lab key",
  };

  it("uses the standard single-quote codec", () => {
    expect(quotePosixArgument("a'b")).toBe(`'a'\"'\"'b'`);
  });

  it("quotes every remote cwd, environment value, program, and arg", () => {
    const remote = buildRemoteCommand(target, {
      program: "/usr/bin/printf",
      args: ["%s", "hello'; printf hacked"],
      cwd: "/tmp/a b",
      environment: { VALUE: "x' && uname" },
    });

    expect(remote).toBe(
      `cd -- '/tmp/a b' && exec env -- 'VALUE=x'\"'\"' && uname' '/usr/bin/printf' '%s' 'hello'\"'\"'; printf hacked'`,
    );
  });

  it("enables noninteractive strict host checking by default", () => {
    const command = buildSshCommand(target, {
      program: "cat",
      args: [],
    });

    expect(command.args).toContain("BatchMode=yes");
    expect(command.args).toContain("StrictHostKeyChecking=yes");
    expect(command.args).toContain("ClearAllForwardings=yes");
    expect(command.args.at(-2)).toBe("operator@lab.example");
    expect(command.args).not.toContain("/keys/lab key=anything");
  });

  it("does not allow an operator profile to disable host-key checking", () => {
    expect(() => buildSshCommand({ ...target, strictHostKeyChecking: false }, { program: "true" }))
      .toThrow("strict host-key checking cannot be disabled");
  });

  it("executes through system OpenSSH and marks remote cancellation uncertain", async () => {
    const adapter = new SshExecutionAdapter();
    const fixtureTarget: SshExecutionTarget = {
      ...target,
      id: "fixture-ssh",
      sshPath: "/bin/echo",
    };
    const completed = await adapter.execute(fixtureTarget, { program: "true" });
    expect(completed).toMatchObject({ status: "completed", cancellation: "not_requested" });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await adapter.execute(fixtureTarget, { program: "true" }, { signal: controller.signal });
    expect(cancelled).toMatchObject({ status: "cancelled", cancellation: "best_effort" });
  });
});
