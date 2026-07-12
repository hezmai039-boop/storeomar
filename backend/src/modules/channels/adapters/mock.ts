import crypto from "node:crypto";
import { ChannelAdapter, NormalizedInboundMessage } from "./types";
import { timingSafeStringEqual } from "../../../lib/timingSafeEqual";

// Local-dev / demo adapter — lets the whole customer-message -> AI-reply ->
// unified-inbox flow be exercised without any real WhatsApp/Meta/TikTok
// account. Registered under channel type key "mock".
interface MockWebhookPayload {
  externalCustomerId: string;
  customerName?: string;
  text: string;
}

export const mockAdapter: ChannelAdapter = {
  key: "mock-console",

  verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
    if (!signatureHeader) return false;
    const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
    return timingSafeStringEqual(expected, signatureHeader, "hex");
  },

  parseWebhook(payload) {
    const body = payload as MockWebhookPayload;
    const out: NormalizedInboundMessage[] = [];
    if (body.text) {
      out.push({ externalCustomerId: body.externalCustomerId, customerName: body.customerName, text: body.text });
    }
    return out;
  },

  async sendMessage(_credentials, message) {
    // eslint-disable-next-line no-console
    console.log(`[mock channel] -> ${message.toExternalId}: ${message.text}`);
    return { externalMessageId: `mock-${Date.now()}` };
  },
};
