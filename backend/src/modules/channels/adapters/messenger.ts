import { ChannelAdapter, NormalizedInboundMessage } from "./types";
import { verifyMetaSignature } from "./metaSignature";

// Facebook Messenger Platform — https://developers.facebook.com/docs/messenger-platform
interface MessengerWebhookPayload {
  entry?: Array<{
    messaging?: Array<{ sender: { id: string }; message?: { mid: string; text?: string } }>;
  }>;
}

export const messengerAdapter: ChannelAdapter = {
  key: "meta-messenger",

  verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
    return verifyMetaSignature(rawBody, signatureHeader, appSecret);
  },

  parseWebhook(payload) {
    const body = payload as MessengerWebhookPayload;
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
    const { pageAccessToken } = credentials as { pageAccessToken: string };
    const resp = await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${pageAccessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: message.toExternalId },
        message: { text: message.text },
      }),
    });
    if (!resp.ok) throw new Error(`Messenger send failed: ${resp.status} ${await resp.text()}`);
    const json = (await resp.json()) as { message_id?: string };
    return { externalMessageId: json.message_id ?? "" };
  },
};
