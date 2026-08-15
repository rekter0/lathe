import type { ServerSentEvent } from "./types.js";

function boundary(buffer: string): { index: number; length: number } | undefined {
  const matches = [
    { index: buffer.indexOf("\r\n\r\n"), length: 4 },
    { index: buffer.indexOf("\n\n"), length: 2 },
    { index: buffer.indexOf("\r\r"), length: 2 },
  ].filter((match) => match.index >= 0);
  matches.sort((left, right) => left.index - right.index || right.length - left.length);
  return matches[0];
}

function parseFrame(frame: string, raw: string): ServerSentEvent | undefined {
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];

  for (const line of frame.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
  }

  if (data.length === 0 && event === undefined && id === undefined && retry === undefined) return undefined;
  return {
    data: data.join("\n"),
    raw,
    ...(event === undefined ? {} : { event }),
    ...(id === undefined ? {} : { id }),
    ...(retry === undefined ? {} : { retry }),
  };
}

/** Parse arbitrarily fragmented UTF-8 chunks without assuming one chunk per event. */
export async function* parseSseChunks(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let next = boundary(buffer);
    while (next !== undefined) {
      const raw = buffer.slice(0, next.index + next.length);
      const frame = buffer.slice(0, next.index);
      buffer = buffer.slice(next.index + next.length);
      const parsed = parseFrame(frame, raw);
      if (parsed !== undefined) yield parsed;
      next = boundary(buffer);
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    const parsed = parseFrame(buffer, buffer);
    if (parsed !== undefined) yield parsed;
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader();
  try {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        yield result.value;
      }
    }
    yield* parseSseChunks(chunks());
  } finally {
    reader.releaseLock();
  }
}
