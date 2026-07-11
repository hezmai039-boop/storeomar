import crypto from "node:crypto";
import { IntegrationAdapter, SyncedOrderData, SyncedProductData } from "./types";

// WooCommerce REST API — https://woocommerce.github.io/woocommerce-rest-api-docs/
export const woocommerceAdapter: IntegrationAdapter = {
  key: "woocommerce",

  async fetchOrders(credentials) {
    const { storeUrl, consumerKey, consumerSecret } = credentials as {
      storeUrl: string;
      consumerKey: string;
      consumerSecret: string;
    };
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const resp = await fetch(`${storeUrl}/wp-json/wc/v3/orders`, { headers: { Authorization: `Basic ${auth}` } });
    if (!resp.ok) throw new Error(`WooCommerce orders fetch failed: ${resp.status}`);
    const orders = (await resp.json()) as Array<Record<string, any>>;
    const out: SyncedOrderData[] = orders.map((o) => ({
      externalOrderId: String(o.id),
      customerRef: o.billing?.phone ?? o.billing?.email,
      status: o.status,
      rawPayload: o,
    }));
    return out;
  },

  async fetchProducts(credentials) {
    const { storeUrl, consumerKey, consumerSecret } = credentials as {
      storeUrl: string;
      consumerKey: string;
      consumerSecret: string;
    };
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const resp = await fetch(`${storeUrl}/wp-json/wc/v3/products`, { headers: { Authorization: `Basic ${auth}` } });
    if (!resp.ok) throw new Error(`WooCommerce products fetch failed: ${resp.status}`);
    const products = (await resp.json()) as Array<Record<string, any>>;
    const out: SyncedProductData[] = products.map((p) => ({
      externalProductId: String(p.id),
      name: p.name,
      price: p.price ? Number(p.price) : undefined,
      rawPayload: p,
    }));
    return out;
  },

  verifyWebhookSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader) return false;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    return expected === signatureHeader;
  },
};
