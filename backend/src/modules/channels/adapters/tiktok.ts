import crypto from "node:crypto";
import { ChannelAdapter, NormalizedInboundMessage } from "./types";

// TikTok Business Messaging — TikTok's messaging API is newer and less
// publicly standardized than Meta's; this shape follows their published
// webhook/signature conventions as of writing, but MUST be re-verified
// against https://business-api.tiktok.com/portal/docs before going live —
// unlike the three Meta adapters, this one hasn't been checked against a
// live sandbox.
interface TikTokWebhookPayload {
  messages?: Array<{ message_id: string; sender_id: string; content?: { text?: string } }>;
}

export const tiktokAdapter: ChannelAdapter = {
  key: "tiktok-business-messaging",

  verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
    if (!signatureHeader) return false;
    const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
    if (expected.length !== signatureHeader.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signatureHeader, "hex"));
  },

  parseWebhook(payload) {
    const body = payload as TikTokWebhookPayload;
    const out: NormalizedInboundMessage[] = [];
    for (const msg of body.messages ?? []) {
      if (!msg.content?.text) continue;
      out.push({ externalCustomerId: msg.sender_id, text: msg.content.text, externalMessageId: msg.message_id });
    }
    return out;
  },

  async sendMessage(credentials, message) {
    const { accessToken, businessId } = credentials as { accessToken: string; businessId: string };
    const resp = await fetch(`https://business-api.tiktok.com/open_api/v1.3/business/messages/send/`, {
      method: "POST",
      headers: { "Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        business_id: businessId,
        recipient_id: message.toExternalId,
        content: { text: message.text },
      }),
    });
    if (!resp.ok) throw new Error(`TikTok send failed: ${resp.status} ${await resp.text()}`);
    const json = (await resp.json()) as { data?: { message_id?: string } };
    return { externalMessageId: json.data?.message_id ?? "" };
  },
};
