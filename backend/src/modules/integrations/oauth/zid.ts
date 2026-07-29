import { env } from "../../../config/env";
import { OAuthProvider, OAuthTokens, asSeconds, postForm, redirectUriFor } from "./types";

// ---------------------------------------------------------------------------
// Zid OAuth2 endpoints — CHANGE THESE TWO LINES IF ZID MOVES THEM.
// Official docs: https://docs.zid.sa/ ("Authorization") and Zid's own
// developer material (github.com/zidsa/zid-agent-skill, zidsa/demo-app-python),
// which both use these exact two URLs. Same reasoning as salla.ts: one
// obvious line to fix rather than a hunt.
// ---------------------------------------------------------------------------
const ZID_AUTHORIZE_URL = "https://oauth.zid.sa/oauth/authorize";
const ZID_TOKEN_URL = "https://oauth.zid.sa/oauth/token";

interface ZidTokenResponse {
  /** Confusingly named: this is the STORE-scoping token, sent as X-Manager-Token. */
  access_token?: string;
  /** The actual bearer credential, sent as `Authorization: Bearer <this>`. */
  authorization?: string;
  refresh_token?: string;
  expires_in?: number | string;
}

/**
 * The single most error-prone line in this whole flow, so it gets its own
 * function: Zid's `access_token` is NOT the bearer token. Zid returns two
 * credentials and they are crossed relative to their names —
 * `authorization` goes in the Authorization header, `access_token` goes in
 * X-Manager-Token (which is what identifies WHICH store the call is for).
 * Wiring them the intuitive way produces a 401 on every request with no
 * hint as to why.
 *
 * adapters/zid.ts destructures `{ accessToken, managerToken }`, so those are
 * the two key names produced here.
 */
function toTokens(json: Record<string, unknown>): OAuthTokens {
  const body = json as ZidTokenResponse;
  if (!body.authorization) throw new Error("Zid token response contained no `authorization` value");
  if (!body.access_token) throw new Error("Zid token response contained no `access_token` (manager token)");
  return {
    accessToken: body.authorization,
    refreshToken: body.refresh_token,
    expiresInSeconds: asSeconds(body.expires_in),
    extra: { managerToken: body.access_token },
  };
}

export const zidOAuthProvider: OAuthProvider = {
  key: "zid",

  isConfigured() {
    return Boolean(env.zidClientId && env.zidClientSecret);
  },

  authorizeUrl(state) {
    // No `scope` parameter: Zid grants whatever the app is approved for in
    // the Partner Dashboard, so scopes are configuration there rather than
    // something this URL negotiates.
    const params = new URLSearchParams({
      client_id: env.zidClientId ?? "",
      redirect_uri: redirectUriFor("zid"),
      response_type: "code",
      state,
    });
    return `${ZID_AUTHORIZE_URL}?${params.toString()}`;
  },

  async exchangeCode(code) {
    return toTokens(
      await postForm(ZID_TOKEN_URL, {
        grant_type: "authorization_code",
        client_id: env.zidClientId ?? "",
        client_secret: env.zidClientSecret ?? "",
        redirect_uri: redirectUriFor("zid"),
        code,
      })
    );
  },

  async refresh(refreshToken) {
    // Zid wants redirect_uri on the refresh call too, unlike most OAuth2
    // servers — omitting it is rejected.
    return toTokens(
      await postForm(ZID_TOKEN_URL, {
        grant_type: "refresh_token",
        client_id: env.zidClientId ?? "",
        client_secret: env.zidClientSecret ?? "",
        redirect_uri: redirectUriFor("zid"),
        refresh_token: refreshToken,
      })
    );
  },
};
