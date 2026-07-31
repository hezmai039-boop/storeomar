import { PaymentProvider } from "./types";
import { manualProvider } from "./manual";
import { contactProvider } from "./contact";

// Adding a payment provider = write an adapter + add one line here. Nothing
// in service.ts or routes.ts names a provider directly, so the gateway
// migration (manual → moyasar/tap) never touches the invoice, quota or
// subscription logic. Mirrors src/modules/channels/adapters/registry.ts.
//
// `contact` is the default (see DEFAULT_BILLING_PROVIDER below). `manual`
// stays registered even though nothing selects it by default: invoices
// already issued against it resolve their provider from the ROW, not from
// the current env var, so deleting it would 500 the checkout of every
// customer holding an open bank-transfer invoice. It is also how a
// deployment that does want to publish an IBAN switches back — one env var.
const providers: Record<string, PaymentProvider> = {
  [contactProvider.key]: contactProvider,
  [manualProvider.key]: manualProvider,
};

/**
 * What BILLING_PROVIDER falls back to. Lives here rather than inline in
 * routes.ts so the default and the registry cannot disagree — a default
 * naming an unregistered key throws on the first subscribe.
 */
export const DEFAULT_BILLING_PROVIDER = contactProvider.key;

export function getPaymentProvider(key: string): PaymentProvider {
  const provider = providers[key];
  if (!provider) throw new Error(`No payment provider registered for key "${key}"`);
  return provider;
}

/** Everything a customer could be offered — used to render the checkout choices. */
export function listPaymentProviders(): PaymentProvider[] {
  return Object.values(providers);
}
