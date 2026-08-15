import type {
  DuplexExecutionRequest,
  DuplexProcess,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResult,
  ExecutionTarget,
} from "../types.js";
import { ContainerExecutionAdapter } from "./container.js";
import { HostExecutionAdapter } from "./host.js";
import { SshExecutionAdapter } from "./ssh.js";

export * from "./container.js";
export * from "./host.js";
export * from "./ssh.js";

export class ExecutionTargets {
  readonly host = new HostExecutionAdapter();
  readonly container = new ContainerExecutionAdapter();
  readonly ssh = new SshExecutionAdapter();

  async execute(
    target: ExecutionTarget,
    request: ExecutionRequest,
    context?: ExecutionContext,
  ): Promise<ExecutionResult> {
    switch (target.kind) {
      case "host":
        return await this.host.execute(target, request, context);
      case "container":
        return await this.container.execute(target, request, context);
      case "ssh":
        return await this.ssh.execute(target, request, context);
    }
  }

  async spawnDuplex(
    target: ExecutionTarget,
    request: DuplexExecutionRequest,
  ): Promise<DuplexProcess> {
    switch (target.kind) {
      case "host":
        return await this.host.spawnDuplex(target, request);
      case "container":
        return await this.container.spawnDuplex(target, request);
      case "ssh":
        return await this.ssh.spawnDuplex(target, request);
    }
  }
}
