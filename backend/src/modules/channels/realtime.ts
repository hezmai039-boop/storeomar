import { EventEmitter } from "node:events";
import { Response } from "express";
import { getRedis, getRedisSubscriber } from "../../lib/redis";

// Pub/sub for the unified inbox's live updates (docs/02-architecture.md §5).
//
// Always emits on a local EventEmitter — that's what the SSE handlers below
// actually listen to. When REDIS_URL is set it ALSO relays through Redis
// pub/sub, so an event published by instance A reaches SSE connections held
// by instance B. Without that relay, a browser only sees live updates for
// messages that happened to land on its own instance and the inbox looks
// frozen for everything else.
const bus = new EventEmitter();
bus.setMaxListeners(0);

const CHANNEL = "atlas:realtime";

export type RealtimeEvent =
  | { type: "message.created"; conversationId: string; messageId: string }
  | { type: "conversation.updated"; conversationId: string };

interface WireMessage {
  storeId: string;
  event: RealtimeEvent;
  // Identifies the emitting process so it can ignore its own relayed message
  // (it already emitted locally) instead of delivering every event twice.
  origin: string;
}

const ORIGIN = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
let subscribed = false;

// Subscribes this process to the shared channel, once, lazily. Failures are
// logged, never thrown: losing the cross-instance relay degrades to
// local-only live updates (the previous behaviour) and must not break the API.
function ensureSubscribed() {
  if (subscribed) return;
  const sub = getRedisSubscriber();
  if (!sub) return;
  subscribed = true;
  sub.subscribe(CHANNEL).catch((err) => console.error(`[realtime] subscribe failed: ${err.message}`));
  sub.on("message", (channel, raw) => {
    if (channel !== CHANNEL) return;
    try {
      const msg = JSON.parse(raw) as WireMessage;
      if (msg.origin === ORIGIN) return; // this process already emitted it locally
      bus.emit(msg.storeId, msg.event);
    } catch (err) {
      console.error(`[realtime] bad payload: ${(err as Error).message}`);
    }
  });
}

export function publish(storeId: string, event: RealtimeEvent) {
  // Local listeners first — never let Redis latency or an outage delay the
  // live update for browsers connected to this very process.
  bus.emit(storeId, event);

  const redis = getRedis();
  if (!redis) return;
  ensureSubscribed();
  const payload: WireMessage = { storeId, event, origin: ORIGIN };
  redis.publish(CHANNEL, JSON.stringify(payload)).catch((err) => {
    console.error(`[realtime] publish failed: ${err.message}`);
  });
}

export function subscribeSse(storeId: string, res: Response) {
  ensureSubscribed();

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
