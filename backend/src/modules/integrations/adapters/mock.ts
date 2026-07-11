import crypto from "node:crypto";
import { IntegrationAdapter } from "./types";

// Demo adapter so /sync and the orders lookup work with zero external
// accounts — returns a couple of fixed sample orders/products.
export const mockIntegrationAdapter: IntegrationAdapter = {
  key: "mock",

  async fetchOrders() {
    return [
      {
        externalOrderId: "DEMO-1042",
        customerRef: "+9665XXXXXX42",
        status: "shipped",
        trackingUrl: "https://example.com/track/DEMO-1042",
        rawPayload: { note: "demo order" },
      },
    ];
  },

  async fetchProducts() {
    return [
      { externalProductId: "DEMO-P1", name: "فستان أزرق", price: 249, currency: "SAR", rawPayload: {} },
    ];
  },

  verifyWebhookSignature(rawBody, signatureHeader, secret) {
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    return signatureHeader === expected;
  },
};
