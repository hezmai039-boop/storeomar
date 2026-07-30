import { OAuthProvider } from "./types";
import { sallaOAuthProvider } from "./salla";
import { zidOAuthProvider } from "./zid";

// Mirrors adapters/registry.ts, with one deliberate difference: that one
// throws for an unknown platform, this one returns undefined. Its callers
// are a PUBLIC callback route and a background refresh, where an unknown
// `:platform` in the URL is attacker-controlled input to be answered with a
// redirect/no-op — not an exception that would log a stack trace on demand.
const providers: Record<string, OAuthProvider> = {
  [sallaOAuthProvider.key]: sallaOAuthProvider,
  [zidOAuthProvider.key]: zidOAuthProvider,
};

export function getOAuthProvider(platform: string): OAuthProvider | undefined {
  return providers[platform];
}

/** Every platform installable via an app store — shopify/woocommerce/mock still paste credentials. */
export function oauthPlatformKeys(): string[] {
  return Object.keys(providers);
}
