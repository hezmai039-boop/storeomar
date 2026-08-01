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
  // `hasOwn` before the index, for the same reason as
  // lib/industryTemplates.ts: `providers` is an object literal, so a bare
  // lookup walks the prototype chain and `providers["__proto__"]` returns an
  // object while `providers["constructor"]` returns a function — both TRUTHY,
  // both sailing past every `if (!provider)` guard below and then throwing
  // `provider.isConfigured is not a function`. `:platform` is user-supplied
  // in both call sites, one of which is a PUBLIC callback, so the difference
  // is a clean 404 versus a 500 anyone can trigger from a URL bar.
  if (!Object.hasOwn(providers, platform)) return undefined;
  return providers[platform];
}

/** Every platform installable via an app store — shopify/woocommerce/mock still paste credentials. */
export function oauthPlatformKeys(): string[] {
  return Object.keys(providers);
}
