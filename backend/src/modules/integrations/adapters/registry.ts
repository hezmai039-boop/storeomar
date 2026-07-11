import { IntegrationAdapter } from "./types";
import { sallaAdapter } from "./salla";
import { zidAdapter } from "./zid";
import { shopifyAdapter } from "./shopify";
import { woocommerceAdapter } from "./woocommerce";
import { mockIntegrationAdapter } from "./mock";

const adapters: Record<string, IntegrationAdapter> = {
  [sallaAdapter.key]: sallaAdapter,
  [zidAdapter.key]: zidAdapter,
  [shopifyAdapter.key]: shopifyAdapter,
  [woocommerceAdapter.key]: woocommerceAdapter,
  [mockIntegrationAdapter.key]: mockIntegrationAdapter,
};

export function getIntegrationAdapter(platform: string): IntegrationAdapter {
  const adapter = adapters[platform];
  if (!adapter) throw new Error(`No integration adapter registered for platform "${platform}"`);
  return adapter;
}
