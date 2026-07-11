import { ChannelAdapter, NormalizedInboundMessage } from "./types";
import { verifyMetaSignature } from "./metaSignature";

// Instagram Messaging (via Meta Graph API) — https://developers.facebook.com/docs/messenger-platform/instagram
// Webhook shape mirrors Messenger's entry[].messaging[] format.
interface InstagramWebhookPayload {
  entry?: Array<{
    messaging?: Array<{ sender: { id: string }; message?: { mid: string; text?: string } }>;
  }>;
}

export const instagramAdapter: ChannelAdapter = {
  key: "meta-instagram-messaging",

  verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
    return verifyMetaSignature(rawBody, signatureHeader, appSecret);
  },

  parseWebhook(payload) {
    const body = payload as InstagramWebhookPayload;
    const out: NormalizedInboundMessage[] = [];
    for (const entry of body.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        if (!event.message?.text) continue;
        out.push({
          externalCustomerId: event.sender.id,
          text: event.message.text,
          externalMessageId: event.message.mid,
        });
      }
    }
    return out;
  },

  async sendMessage(credentials, message) {
    const { igUserId, accessToken } = credentials as { igUserId: string; accessToken: string };
    const resp = await fetch(`https://graph.facebook.com/v20.0/${igUserId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: message.toExternalId },
        message: { text: message.text },
      }),
    });
    if (!resp.ok) throw new Error(`Instagram send failed: ${resp.status} ${await resp.text()}`);
    const json = (await resp.json()) as { message_id?: string };
    return { externalMessageId: json.message_id ?? "" };
  },
};
