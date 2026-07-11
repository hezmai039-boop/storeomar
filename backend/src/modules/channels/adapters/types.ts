// Every channel plugs into the same shape (docs/02-architecture.md §3) so
// adding a new one is: implement this interface + register it in
// registry.ts + insert a channel_types row. Nothing else in the codebase
// (routes, unified inbox, AI pipeline) needs to change.

export interface NormalizedInboundMessage {
  externalCustomerId: string;
  customerName?: string;
  customerPhone?: string;
  text: string;
  externalMessageId?: string;
}

export interface OutboundMessage {
  toExternalId: string;
  text: string;
}

export interface ChannelCredentials {
  [key: string]: unknown;
}

export interface ChannelAdapter {
  key: string;

  /** HMAC/signature check on the raw webhook body — must run before parseWebhook touches the DB. */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean;

  /** Turn the channel's native webhook payload into our normalized shape. */
  parseWebhook(payload: unknown): NormalizedInboundMessage[];

  /** Send a reply out through the channel's real API. */
  sendMessage(credentials: ChannelCredentials, message: OutboundMessage): Promise<{ externalMessageId: string }>;
}
