import { ChannelAdapter } from "./types";
import { whatsappAdapter } from "./whatsapp";
import { instagramAdapter } from "./instagram";
import { messengerAdapter } from "./messenger";
import { tiktokAdapter } from "./tiktok";
import { mockAdapter } from "./mock";
import { simulationAdapter } from "./simulation";

// Adding a channel = write an adapter + add one line here + insert a
// channel_types row (see prisma/seed.ts) — nothing else in the codebase
// changes, per the extensibility requirement in docs/02-architecture.md §3.
const adapters: Record<string, ChannelAdapter> = {
  [whatsappAdapter.key]: whatsappAdapter,
  [instagramAdapter.key]: instagramAdapter,
  [messengerAdapter.key]: messengerAdapter,
  [tiktokAdapter.key]: tiktokAdapter,
  [mockAdapter.key]: mockAdapter,
  [simulationAdapter.key]: simulationAdapter,
};

export function getAdapter(adapterKey: string): ChannelAdapter {
  const adapter = adapters[adapterKey];
  if (!adapter) throw new Error(`No channel adapter registered for key "${adapterKey}"`);
  return adapter;
}
