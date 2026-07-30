import { useEffect, useState } from "react";
import { api } from "../api/client";

/**
 * Runtime flags the app needs before anyone is logged in.
 *
 * These cannot be Vite env vars: the SPA is built once and served by
 * whatever deployment is configured, so build-time constants would bake one
 * environment's answer into every environment's bundle.
 */
export interface PublicConfig {
  signupEnabled: boolean;
}

// Closed is the safe default here for the same reason it is on the server:
// a signup link shown while signup is off leads to a form that can only
// 403 on submit, which reads as a broken product rather than a closed door.
const FALLBACK: PublicConfig = { signupEnabled: false };

// Cached at module scope: both the login and signup screens ask for this,
// and it cannot change without a backend restart, so re-fetching it per
// mount would be a request per navigation for a value that never moves.
let cached: PublicConfig | null = null;
let inFlight: Promise<PublicConfig> | null = null;

export function fetchPublicConfig(): Promise<PublicConfig> {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;

  inFlight = api
    .get<{ data: PublicConfig }>("/v1/public/config")
    .then((resp) => {
      cached = resp.data;
      return cached;
    })
    .catch(() => {
      // An unreachable backend must not blank the login screen. Fall back to
      // the safe default and let the login form itself surface the outage.
      inFlight = null;
      return FALLBACK;
    });

  return inFlight;
}

export function usePublicConfig(): PublicConfig {
  const [config, setConfig] = useState<PublicConfig>(cached ?? FALLBACK);

  useEffect(() => {
    let alive = true;
    fetchPublicConfig().then((c) => {
      if (alive) setConfig(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  return config;
}
