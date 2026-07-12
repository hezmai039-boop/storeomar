import crypto from "node:crypto";
import { IntegrationAdapter, SyncedOrderData, SyncedProductData } from "./types";
import { timingSafeStringEqual } from "../../../lib/timingSafeEqual";

// Salla Merchant API — https://docs.salla.dev/ (OAuth2 Bearer token per store).
export const sallaAdapter: IntegrationAdapter = {
  key: "salla",

  async fetchOrders(credentials) {
    const { accessToken } = credentials as { accessToken: string };
    const resp = await fetch("https://api.salla.dev/admin/v2/orders", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) throw new Error(`Salla orders fetch failed: ${resp.status}`);
    const json = (await resp.json()) as { data?: Array<Record<string, any>> };
    const out: SyncedOrderData[] = (json.data ?? []).map((o) => ({
      externalOrderId: String(o.id),
      customerRef: o.customer?.mobile ?? o.customer?.email,
      status: o.status?.name ?? "unknown",
      trackingUrl: o.shipments?.[0]?.tracking_link,
      rawPayload: o,
    }));
    return out;
  },

  async fetchProducts(credentials) {
    const { accessToken } = credentials as { accessToken: string };
    const resp = await fetch("https://api.salla.dev/admin/v2/products", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) throw new Error(`Salla products fetch failed: ${resp.status}`);
    const json = (await resp.json()) as { data?: Array<Record<string, any>> };
    const out: SyncedProductData[] = (json.data ?? []).map((p) => ({
      externalProductId: String(p.id),
      name: p.name,
      price: p.price?.amount,
      currency: p.price?.currency,
      rawPayload: p,
    }));
    return out;
  },

  verifyWebhookSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader) return false;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    return timingSafeStringEqual(expected, signatureHeader, "hex");
  },
};
