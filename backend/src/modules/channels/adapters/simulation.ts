import { ChannelAdapter } from "./types";

// Registered under channel type key "simulation" (see
// modules/simulation/service.ts's SIMULATION_CHANNEL_TYPE_KEY) so a
// simulated conversation is a real channel_account row and shows up in the
// normal Inbox like any other channel — including letting staff reply to
// it from POST /v1/stores/:storeId/conversations/:id/messages
// (channels/routes.ts), which always calls getAdapter(...).sendMessage(...)
// before persisting the reply, regardless of which channel it's on.
//
// There is nothing to actually "send" to: a simulated visitor's browser
// picks up new agent messages by polling GET /v1/public/simulate/:token/
// messages, not through any outbound API call. sendMessage is a no-op that
// returns a synthetic id purely so the reply-message row has a non-null
// externalMessageId, matching every other channel's shape.
//
// verifyWebhookSignature/parseWebhook are unreachable in practice —
// simulation traffic never goes through the shared webhook route
// (modules/channels/webhook.ts); it has its own public routes
// (modules/simulation/publicRoutes.ts). Implemented only to satisfy the
// ChannelAdapter interface.
export const simulationAdapter: ChannelAdapter = {
  key: "simulation",

  verifyWebhookSignature() {
    return false;
  },

  parseWebhook() {
    return [];
  },

  async sendMessage(_credentials, _message) {
    return { externalMessageId: `simulation-${Date.now()}` };
  },
};
