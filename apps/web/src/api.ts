let launchToken = "";

export function initializeLaunchToken(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    sessionStorage.setItem("lathe.launch-token", fromUrl);
    url.searchParams.delete("token");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  launchToken = fromUrl ?? sessionStorage.getItem("lathe.launch-token") ?? "";
  return launchToken;
}

export function hasLaunchToken(): boolean {
  return launchToken.length > 0;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${launchToken}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new ApiError(response.status, body?.error?.message ?? `Request failed (${response.status})`, body);
  }
  return response.json() as Promise<T>;
}

export async function downloadApiFile(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${launchToken}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new ApiError(response.status, body?.error?.message ?? `Download failed (${response.status})`, body);
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quotedName = disposition.match(/filename="([^"]+)"/i)?.[1];
  const fileName = encodedName ? decodeURIComponent(encodedName) : quotedName ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}

export async function consumeEvents(channel: string, signal: AbortSignal, onEvent: (event: unknown) => void): Promise<void> {
  const response = await fetch(`/api/events/${encodeURIComponent(channel)}`, {
    headers: { Authorization: `Bearer ${launchToken}` },
    signal
  });
  if (!response.ok || !response.body) throw new ApiError(response.status, "Could not open event stream");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += value;
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (data) onEvent(JSON.parse(data));
      boundary = buffer.indexOf("\n\n");
    }
  }
}
