#!/usr/bin/env node
import { spawn } from "node:child_process";
import { basename } from "node:path";

const scenario = basename(process.argv[1] ?? "").replace(/^fake-codex-/u, "");

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 9.9.9-fixture\n");
  process.exit(0);
}

if (process.argv[2] !== "app-server") {
  process.stderr.write("expected app-server\n");
  process.exit(2);
}

const requiredConfigOverrides = [
  "mcp_servers={}",
  "shell_environment_policy.inherit=none",
  'web_search="disabled"',
  "check_for_update_on_startup=false",
];
if (!requiredConfigOverrides.every((value) => process.argv.includes(value))) {
  process.stderr.write("missing safe app-server config override\n");
  process.exit(2);
}

let output = Promise.resolve();
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sendBytes(bytes, fragmented = scenario === "fragmented") {
  output = output.then(async () => {
    if (!fragmented || bytes.length < 5) {
      process.stdout.write(bytes);
      return;
    }
    const first = Math.max(1, Math.floor(bytes.length / 3));
    const second = Math.max(first + 1, Math.floor(bytes.length * 2 / 3));
    process.stdout.write(bytes.subarray(0, first));
    await delay(2);
    process.stdout.write(bytes.subarray(first, second));
    await delay(2);
    process.stdout.write(bytes.subarray(second));
  });
  return output;
}

function send(message, fragmented) {
  return sendBytes(Buffer.from(`${JSON.stringify(message)}\n`, "utf8"), fragmented);
}

const account = {
  account: {
    type: "chatgpt",
    planType: "plus",
    email: "operator@example.test",
    accountId: "account-private-123",
  },
  accessToken: "sk-fixture-super-secret",
  requiresOpenaiAuth: true,
};

const models = {
  data: [{
    id: "gpt-fixture",
    model: "gpt-fixture",
    displayName: "Fixture GPT",
    description: "deterministic fixture",
    hidden: false,
    isDefault: true,
    inputModalities: ["text"],
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low" },
      { reasoningEffort: "high", description: "High" },
    ],
  }],
  nextCursor: null,
};

let input = "";
let inputQueue = Promise.resolve();
let activeThreadId = "thread-fixture";
let experimentalApiEnabled = false;
const rejectedIds = new Set(["server-approval", "server-tool", "server-mcp", "server-app"]);
const observedRejections = new Set();
let childProcess;

const experimentalFieldsByMethod = new Map([
  ["thread/start", ["runtimeWorkspaceRoots", "environments"]],
  ["thread/fork", ["runtimeWorkspaceRoots", "excludeTurns"]],
  ["thread/resume", ["runtimeWorkspaceRoots", "excludeTurns"]],
  ["turn/start", ["runtimeWorkspaceRoots", "environments"]],
]);

async function rejectUnnegotiatedExperimentalField(id, method, params) {
  if (experimentalApiEnabled) return false;
  const field = experimentalFieldsByMethod.get(method)?.find((candidate) => candidate in params);
  if (field === undefined) return false;
  await send({
    id,
    error: {
      code: -32602,
      message: `${method}.${field} requires experimentalApi capability`,
    },
  });
  return true;
}

async function finishTurn(text = "hello") {
  await send({ method: "turn/started", params: { threadId: activeThreadId, turn: { id: "turn-fixture" } } });
  await send({
    method: "item/agentMessage/delta",
    params: { threadId: activeThreadId, turnId: "turn-fixture", itemId: "message-1", delta: text.slice(0, 3) },
  });
  await send({
    method: "item/agentMessage/delta",
    params: { threadId: activeThreadId, turnId: "turn-fixture", itemId: "message-1", delta: text.slice(3) },
  });
  await send({
    method: "item/reasoning/textDelta",
    params: { threadId: activeThreadId, turnId: "turn-fixture", itemId: "reason-1", contentIndex: 0, delta: "analysis" },
  });
  await send({
    method: "item/reasoning/summaryTextDelta",
    params: { threadId: activeThreadId, turnId: "turn-fixture", itemId: "reason-1", summaryIndex: 0, delta: "summary" },
  });
  await send({
    method: "item/completed",
    params: {
      threadId: activeThreadId,
      turnId: "turn-fixture",
      item: { id: "message-1", type: "agentMessage", text },
    },
  });
  await send({
    method: "turn/completed",
    params: {
      threadId: activeThreadId,
      turn: {
        id: "turn-fixture",
        status: "completed",
        items: [
          { id: "message-1", type: "agentMessage", text },
          { id: "reason-1", type: "reasoning", content: ["analysis"], summary: ["summary"] },
        ],
      },
    },
  });
}

async function handle(message) {
  if (typeof message?.id === "string" && rejectedIds.has(message.id)) {
    if (message.error && !message.result) observedRejections.add(message.id);
    if (observedRejections.size === rejectedIds.size) await finishTurn("safe");
    return;
  }
  const { id, method, params = {} } = message ?? {};
  if (method === "initialize") {
    experimentalApiEnabled = params.capabilities?.experimentalApi === true;
    const forbiddenEnvironment = [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "ANTHROPIC_API_KEY",
    ].find((name) => process.env[name]);
    if (forbiddenEnvironment) {
      await send({ id, error: { code: -32091, message: `inherited forbidden environment ${forbiddenEnvironment}` } });
      return;
    }
    await send({
      id,
      result: {
        userAgent: "codex-app-server/9.9.9-fixture",
        codexHome: "/Users/private-account/.codex",
        platformFamily: "unix",
        platformOs: "fixture",
      },
    });
    return;
  }
  if (method === "initialized") return;
  if (await rejectUnnegotiatedExperimentalField(id, method, params)) return;
  if (method === "account/read") {
    if (scenario === "malformed") {
      await sendBytes(Buffer.from(`{"id":${JSON.stringify(id)},"result":\n`, "utf8"), true);
      return;
    }
    await send({ id, result: scenario === "auth-mismatch" ? { account: { type: "apiKey" } } : account });
    return;
  }
  if (method === "model/list") {
    await send({ id, result: models });
    return;
  }
  if (method === "thread/start") {
    const valid = params.sandbox === "read-only"
      && !("sandboxPolicy" in params)
      && params.approvalPolicy === "never"
      && params.ephemeral === true
      && Array.isArray(params.environments)
      && params.environments.length === 0
      && Array.isArray(params.runtimeWorkspaceRoots);
    activeThreadId = "thread-fixture";
    await send(valid
      ? { id, result: { thread: { id: activeThreadId } } }
      : { id, error: { code: -32090, message: "unsafe thread settings" } });
    return;
  }
  if (method === "thread/fork" || method === "thread/resume") {
    if (scenario === "continuity-unsupported") {
      await send({ id, error: { code: -32601, message: `${method} unsupported` } });
      return;
    }
    const valid = params.sandbox === "read-only"
      && !("sandboxPolicy" in params)
      && params.approvalPolicy === "never"
      && params.excludeTurns === true
      && Array.isArray(params.runtimeWorkspaceRoots);
    if (!valid) {
      await send({ id, error: { code: -32090, message: "unsafe continuity settings" } });
      return;
    }
    activeThreadId = method === "thread/fork" ? "thread-forked" : params.threadId;
    await send({
      id,
      result: {
        thread: {
          id: activeThreadId,
          turns: [{ id: "hidden-turn", items: [{ type: "agentMessage", text: "native-history-secret" }] }],
        },
      },
    });
    return;
  }
  if (method === "turn/start") {
    const safeTurn = params.sandboxPolicy?.type === "readOnly"
      && params.sandboxPolicy?.access?.type === "restricted"
      && params.sandboxPolicy?.access?.includePlatformDefaults === true
      && Array.isArray(params.sandboxPolicy?.access?.readableRoots)
      && params.sandboxPolicy.access.readableRoots.length === 1
      && params.approvalPolicy === "never"
      && !("sandbox" in params)
      && Array.isArray(params.environments)
      && params.environments.length === 0
      && Array.isArray(params.runtimeWorkspaceRoots);
    if (!safeTurn) {
      await send({ id, error: { code: -32090, message: "unsafe turn settings" } });
      return;
    }
    if (scenario === "crash") {
      process.exit(17);
      return;
    }
    await send({ id, result: { turn: { id: "turn-fixture", status: "inProgress", items: [] } } });
    if (scenario === "cancellation") {
      childProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      process.stderr.write(`CHILD_PID=${childProcess.pid} account_id=account-private-123 token=sk-fixture-super-secret operator@example.test\n`);
      return;
    }
    if (scenario === "rejections") {
      await send({ id: "server-approval", method: "item/commandExecution/requestApproval", params: { command: "touch forbidden" } });
      await send({ id: "server-tool", method: "item/tool/call", params: { name: "unsafe" } });
      await send({ id: "server-mcp", method: "mcpServer/elicitation/request", params: { secret: "do not return" } });
      await send({ id: "server-app", method: "app/request", params: { accountId: "account-private-123" } });
      return;
    }
    await finishTurn();
    return;
  }
  if (method === "turn/interrupt") {
    await send({ id, result: {} });
    return;
  }
  if (id !== undefined) await send({ id, error: { code: -32601, message: `unknown method ${method}` } });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\n");
    if (newline === -1) break;
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (line.length === 0) continue;
    inputQueue = inputQueue.then(async () => await handle(JSON.parse(line)));
  }
});

process.stdin.on("end", () => {
  childProcess?.kill("SIGTERM");
  process.exit(0);
});
