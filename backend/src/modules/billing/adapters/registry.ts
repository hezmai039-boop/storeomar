import { PaymentProvider } from "./types";
import { manualProvider } from "./manual";

// Adding a payment provider = write an adapter + add one line here. Nothing
// in service.ts or routes.ts names a provider directly, so the gateway
// migration (manual → moyasar/tap) never touches the invoice, quota or
// subscription logic. Mirrors src/modules/channels/adapters/registry.ts.
const providers: Record<string, PaymentProvider> = {
  [manualProvider.key]: manualProvider,
};

export function getPaymentProvider(key: string): PaymentProvider {
  const provider = providers[key];
  if (!provider) throw new Error(`No payment provider registered for key "${key}"`);
  return provider;
}

/** Everything a customer could be offered — used to render the checkout choices. */
export function listPaymentProviders(): PaymentProvider[] {
  return Object.values(providers);
}
