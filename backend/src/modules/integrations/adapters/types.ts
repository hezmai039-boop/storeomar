export interface SyncedOrderData {
  externalOrderId: string;
  customerRef?: string;
  status: string;
  trackingUrl?: string;
  rawPayload: unknown;
}

export interface SyncedProductData {
  externalProductId: string;
  name: string;
  price?: number;
  currency?: string;
  sizes?: string[];
  rawPayload: unknown;
}

export interface IntegrationAdapter {
  key: string;
  fetchOrders(credentials: Record<string, unknown>): Promise<SyncedOrderData[]>;
  fetchProducts(credentials: Record<string, unknown>): Promise<SyncedProductData[]>;
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean;
}
