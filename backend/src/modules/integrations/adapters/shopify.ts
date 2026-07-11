import crypto from "node:crypto";
import { IntegrationAdapter, SyncedOrderData, SyncedProductData } from "./types";

// Shopify Admin REST API — https://shopify.dev/docs/api/admin-rest
export const shopifyAdapter: IntegrationAdapter = {
  key: "shopify",

  async fetchOrders(credentials) {
    const { shopDomain, accessToken } = credentials as { shopDomain: string; accessToken: string };
    const resp = await fetch(`https://${shopDomain}/admin/api/2024-01/orders.json?status=any`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (!resp.ok) throw new Error(`Shopify orders fetch failed: ${resp.status}`);
    const json = (await resp.json()) as { orders?: Array<Record<string, any>> };
    return (json.orders ?? []).map((o) => ({
      externalOrderId: String(o.id),
      customerRef: o.customer?.phone ?? o.customer?.email,
      status: o.fulfillment_status ?? "unfulfilled",
      trackingUrl: o.fulfillments?.[0]?.tracking_url,
      rawPayload: o,
    }));
  },

  async fetchProducts(credentials) {
    const { shopDomain, accessToken } = credentials as { shopDomain: string; accessToken: string };
    const resp = await fetch(`https://${shopDomain}/admin/api/2024-01/products.json`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (!resp.ok) throw new Error(`Shopify products fetch failed: ${resp.status}`);
    const json = (await resp.json()) as { products?: Array<Record<string, any>> };
    return (json.products ?? []).map((p) => ({
      externalProductId: String(p.id),
      name: p.title,
      price: p.variants?.[0]?.price ? Number(p.variants[0].price) : undefined,
      currency: "USD",
      sizes: p.variants?.map((v: any) => v.title).filter(Boolean),
      rawPayload: p,
    }));
  },

  verifyWebhookSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader) return false;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    return expected === signatureHeader;
  },
};
