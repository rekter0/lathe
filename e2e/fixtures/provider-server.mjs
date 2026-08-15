import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.LATHE_E2E_PROVIDER_PORT ?? 4319);
const requests = [];
let responseSequence = 0;

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

function lastUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const message = messages.findLast((item) => item && typeof item === "object" && item.role === "user");
  return textContent(message?.content);
}

async function sendSse(response, frames, delayMs = 0) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  for (const frame of frames) {
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  response.end("data: [DONE]\n\n");
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { ok: true, service: "lathe-e2e-provider" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    json(response, 200, { object: "list", data: [{ id: "fixture-model", object: "model", owned_by: "lathe-e2e" }] });
    return;
  }

  if (request.method === "GET" && url.pathname === "/__requests") {
    const nonce = url.searchParams.get("nonce");
    json(response, 200, {
      requests: nonce ? requests.filter((item) => item.body.fixture_nonce === nonce) : requests
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body;
    try {
      body = await readJson(request);
    } catch {
      json(response, 400, { error: { message: "Fixture expected a JSON body", type: "invalid_request_error" } });
      return;
    }

    responseSequence += 1;
    requests.push({
      sequence: responseSequence,
      body,
      authorizationPresent: request.headers.authorization?.startsWith("Bearer ") === true,
      fixtureHeader: request.headers["x-lathe-fixture"] ?? null
    });

    const prompt = lastUserText(body);
    if (prompt.includes("[fable-block]")) {
      await sendSse(response, [
        {
          id: `chatcmpl-${responseSequence}`,
          model: "anthropic/claude-fable-5",
          choices: [{ index: 0, delta: { role: "assistant", reasoning: "Classifier is evaluating the request." }, finish_reason: null }]
        },
        {
          id: `chatcmpl-${responseSequence}`,
          model: "anthropic/claude-fable-5",
          choices: [{ index: 0, delta: { content: "Partial output before intervention." }, finish_reason: null }]
        },
        {
          id: `chatcmpl-${responseSequence}`,
          model: "anthropic/claude-fable-5",
          choices: [{ index: 0, delta: { content: "", refusal: "This request triggered restrictions on violative cyber content." }, finish_reason: null }]
        },
        {
          id: `chatcmpl-${responseSequence}`,
          model: "anthropic/claude-fable-5",
          choices: [{ index: 0, delta: { content: "" }, finish_reason: "content_filter", native_finish_reason: "refusal" }]
        }
      ], 350);
      return;
    }

    if (prompt.includes("[fable-continue]")) {
      await sendSse(response, [
        {
          id: `chatcmpl-${responseSequence}`,
          model: "anthropic/claude-fable-5",
          choices: [{ index: 0, delta: { refusal: "Primary model declined this attempt." }, finish_reason: "content_filter", native_finish_reason: "refusal" }]
        },
        {
          id: `chatcmpl-${responseSequence}`,
          model: "fallback-model",
          choices: [{ index: 0, delta: { content: "Continued output after the policy signal." }, finish_reason: null }]
        },
        {
          id: `chatcmpl-${responseSequence}`,
          model: "fallback-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "end_turn" }]
        }
      ], 350);
      return;
    }

    if (prompt.includes("[call-tool]")) {
      const callId = `fixture-call-${responseSequence}`;
      await sendSse(response, [
        {
          id: `chatcmpl-${responseSequence}`,
          model: "fixture-model",
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0,
                id: callId,
                type: "function",
                function: {
                  name: "shell",
                  arguments: JSON.stringify({ program: "/bin/echo", args: ["fixture"] })
                }
              }]
            },
            finish_reason: null
          }]
        },
        {
          id: `chatcmpl-${responseSequence}`,
          model: "fixture-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
        }
      ]);
      return;
    }

    if (prompt.includes("[stream-chat]")) {
      await sendSse(response, [
        {
          id: `chatcmpl-${responseSequence}`,
          model: "fixture-model",
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              reasoning: "Streaming **reasoning**: ",
              content: "Streaming **answer**: "
            },
            finish_reason: null
          }]
        },
        {
          id: `chatcmpl-${responseSequence}`,
          model: "fixture-model",
          choices: [{
            index: 0,
            delta: { reasoning: prompt, content: prompt },
            finish_reason: null
          }]
        },
        {
          id: `chatcmpl-${responseSequence}`,
          model: "fixture-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }
      ], 600);
      return;
    }

    await sendSse(response, [
      {
        id: `chatcmpl-${responseSequence}`,
        model: "fixture-model",
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            reasoning: `Fixture **reasoning** for: ${prompt}`,
            content: `Fixture **response**: ${prompt}`
          },
          finish_reason: null
        }]
      },
      {
        id: `chatcmpl-${responseSequence}`,
        model: "fixture-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }
    ]);
    return;
  }

  json(response, 404, { error: { message: `No fixture route for ${request.method} ${url.pathname}` } });
});

server.listen(port, host, () => {
  console.log(`Lathe deterministic provider fixture listening on http://${host}:${port}`);
});

const shutdown = () => server.close();
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
