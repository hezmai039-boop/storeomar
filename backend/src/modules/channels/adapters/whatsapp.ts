import { ChannelAdapter, NormalizedInboundMessage } from "./types";
import { verifyMetaSignature } from "./metaSignature";

// WhatsApp Business Platform (Cloud API) — https://developers.facebook.com/docs/whatsapp/cloud-api
interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ id: string; from: string; text?: { body: string } }>;
        contacts?: Array<{ profile?: { name?: string }; wa_id: string }>;
      };
    }>;
  }>;
}

export const whatsappAdapter: ChannelAdapter = {
  key: "whatsapp-cloud-api",

  verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
    return verifyMetaSignature(rawBody, signatureHeader, appSecret);
  },

  parseWebhook(payload) {
    const body = payload as WhatsAppWebhookPayload;
    const out: NormalizedInboundMessage[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const contactsByWaId = new Map((change.value?.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
        for (const msg of change.value?.messages ?? []) {
          out.push({
            externalCustomerId: msg.from,
            customerName: contactsByWaId.get(msg.from),
            customerPhone: msg.from,
            text: msg.text?.body ?? "",
            externalMessageId: msg.id,
          });
        }
      }
    }
    return out;
  },

  async sendMessage(credentials, message) {
    const { phoneNumberId, accessToken } = credentials as { phoneNumberId: string; accessToken: string };
    const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: message.toExternalId,
        type: "text",
        text: { body: message.text },
      }),
    });
    if (!resp.ok) {
      throw new Error(`WhatsApp send failed: ${resp.status} ${await resp.text()}`);
    }
    const json = (await resp.json()) as { messages?: Array<{ id: string }> };
    return { externalMessageId: json.messages?.[0]?.id ?? "" };
  },
};
