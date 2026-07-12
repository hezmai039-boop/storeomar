import crypto from "node:crypto";
import { IntegrationAdapter, SyncedOrderData, SyncedProductData } from "./types";
import { timingSafeStringEqual } from "../../../lib/timingSafeEqual";

// Zid Open API — https://docs.zid.sa/ (Bearer token + X-Manager-Token per store).
export const zidAdapter: IntegrationAdapter = {
  key: "zid",

  async fetchOrders(credentials) {
    const { accessToken, managerToken } = credentials as { accessToken: string; managerToken: string };
    const resp = await fetch("https://api.zid.sa/v1/managers/store/orders", {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Manager-Token": managerToken },
    });
    if (!resp.ok) throw new Error(`Zid orders fetch failed: ${resp.status}`);
    const json = (await resp.json()) as { orders?: Array<Record<string, any>> };
    return (json.orders ?? []).map((o) => ({
      externalOrderId: String(o.id),
      customerRef: o.customer?.phone ?? o.customer?.email,
      status: o.status?.code ?? "unknown",
      trackingUrl: o.shipment?.tracking_url,
      rawPayload: o,
    }));
  },

  async fetchProducts(credentials) {
    const { accessToken, managerToken } = credentials as { accessToken: string; managerToken: string };
    const resp = await fetch("https://api.zid.sa/v1/products", {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Manager-Token": managerToken },
    });
    if (!resp.ok) throw new Error(`Zid products fetch failed: ${resp.status}`);
    const json = (await resp.json()) as { results?: Array<Record<string, any>> };
    return (json.results ?? []).map((p) => ({
      externalProductId: String(p.id),
      name: p.name,
      price: p.price,
      currency: "SAR",
      rawPayload: p,
    }));
  },

  verifyWebhookSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader) return false;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    return timingSafeStringEqual(expected, signatureHeader, "hex");
  },
};
