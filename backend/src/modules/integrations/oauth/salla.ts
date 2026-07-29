import { env } from "../../../config/env";
import { OAuthProvider, OAuthTokens, asSeconds, postForm, redirectUriFor } from "./types";

// ---------------------------------------------------------------------------
// Salla OAuth2 endpoints — CHANGE THESE TWO LINES IF SALLA MOVES THEM.
// Official docs: https://docs.salla.dev/ ("Apps → Authorization").
// Cross-checked against Salla's own OAuth clients (github.com/SallaApp/
// oauth2-merchant and SallaApp/passport-strategy), which hard-code the same
// two URLs. Kept as named constants at the top of the file on purpose: a
// platform that renames an endpoint should cost one obvious edit, not a hunt
// through string concatenation.
// ---------------------------------------------------------------------------
const SALLA_AUTHORIZE_URL = "https://accounts.salla.sa/oauth2/auth";
const SALLA_TOKEN_URL = "https://accounts.salla.sa/oauth2/token";

// Salla runs an Ory Hydra server: without `offline_access` the token
// response comes back with NO refresh_token, and the connection silently
// dies the first time the ~14-day access token expires. The functional
// scopes (orders.read, products.read, …) are NOT requested here — Salla
// takes them from the app's own configuration in the Partner dashboard, so
// listing them in this URL would only risk drifting out of sync with it.
const SALLA_SCOPE = "offline_access";

interface SallaTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  token_type?: string;
}

function toTokens(json: Record<string, unknown>): OAuthTokens {
  const body = json as SallaTokenResponse;
  if (!body.access_token) throw new Error("Salla token response contained no access_token");
  // `accessToken` is exactly what adapters/salla.ts destructures for its
  // `Authorization: Bearer` header — see toCredentialBlob's comment.
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresInSeconds: asSeconds(body.expires_in),
  };
}

export const sallaOAuthProvider: OAuthProvider = {
  key: "salla",

  isConfigured() {
    return Boolean(env.sallaClientId && env.sallaClientSecret);
  },

  authorizeUrl(state) {
    const params = new URLSearchParams({
      client_id: env.sallaClientId ?? "",
      response_type: "code",
      redirect_uri: redirectUriFor("salla"),
      scope: SALLA_SCOPE,
      state,
    });
    return `${SALLA_AUTHORIZE_URL}?${params.toString()}`;
  },

  async exchangeCode(code) {
    // client_secret_post, not HTTP Basic — Salla's Hydra client is
    // registered with token_endpoint_auth_method=client_secret_post, and
    // sending Basic instead fails with a bare `invalid_client`.
    return toTokens(
      await postForm(SALLA_TOKEN_URL, {
        grant_type: "authorization_code",
        client_id: env.sallaClientId ?? "",
        client_secret: env.sallaClientSecret ?? "",
        redirect_uri: redirectUriFor("salla"),
        scope: SALLA_SCOPE,
        code,
      })
    );
  },

  async refresh(refreshToken) {
    return toTokens(
      await postForm(SALLA_TOKEN_URL, {
        grant_type: "refresh_token",
        client_id: env.sallaClientId ?? "",
        client_secret: env.sallaClientSecret ?? "",
        refresh_token: refreshToken,
      })
    );
  },
};
