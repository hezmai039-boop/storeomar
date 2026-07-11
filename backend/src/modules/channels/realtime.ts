import { EventEmitter } from "node:events";
import { Response } from "express";

// In-process pub/sub for the unified inbox's live updates (docs/02-architecture.md §5).
// Fine for a single backend instance; move to Redis pub/sub the moment
// there's more than one process, since EventEmitter doesn't cross processes.
const bus = new EventEmitter();
bus.setMaxListeners(0);

export type RealtimeEvent =
  | { type: "message.created"; conversationId: string; messageId: string }
  | { type: "conversation.updated"; conversationId: string };

export function publish(storeId: string, event: RealtimeEvent) {
  bus.emit(storeId, event);
}

export function subscribeSse(storeId: string, res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const onEvent = (event: RealtimeEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  bus.on(storeId, onEvent);

  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25000);

  res.req.on("close", () => {
    clearInterval(heartbeat);
    bus.off(storeId, onEvent);
  });
}
