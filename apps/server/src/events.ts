import type { JsonValue } from "@lathe/domain";

export interface AppEvent {
  id: number;
  channel: string;
  type: string;
  timestamp: string;
  data: JsonValue;
}

interface Subscriber {
  channel: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
}

const encoder = new TextEncoder();

export class EventHub {
  private nextId = 1;
  private readonly backlog = new Map<string, AppEvent[]>();
  private readonly subscribers = new Set<Subscriber>();

  publish(channel: string, type: string, data: JsonValue): AppEvent {
    const event: AppEvent = { id: this.nextId, channel, type, timestamp: new Date().toISOString(), data };
    this.nextId += 1;
    const events = this.backlog.get(channel) ?? [];
    events.push(event);
    if (events.length > 500) events.splice(0, events.length - 500);
    this.backlog.set(channel, events);
    for (const subscriber of this.subscribers) {
      if (subscriber.channel === channel) subscriber.controller.enqueue(encoder.encode(this.serialize(event)));
    }
    return event;
  }

  stream(channel: string, afterId = 0, signal?: AbortSignal): ReadableStream<Uint8Array> {
    let subscriber: Subscriber | undefined;
    let abortHandler: (() => void) | undefined;
    const cleanup = (closeController: boolean) => {
      if (!subscriber) return;
      clearInterval(subscriber.heartbeat);
      this.subscribers.delete(subscriber);
      signal?.removeEventListener("abort", abortHandler!);
      if (closeController) {
        try {
          subscriber.controller.close();
        } catch {
          // The browser may already have cancelled the stream.
        }
      }
      subscriber = undefined;
    };
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const event of this.backlog.get(channel) ?? []) {
          if (event.id > afterId) controller.enqueue(encoder.encode(this.serialize(event)));
        }
        subscriber = {
          channel,
          controller,
          heartbeat: setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 15_000)
        };
        this.subscribers.add(subscriber);
        abortHandler = () => cleanup(true);
        signal?.addEventListener("abort", abortHandler, { once: true });
      },
      cancel: () => cleanup(false)
    });
  }

  private serialize(event: AppEvent): string {
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }
}
