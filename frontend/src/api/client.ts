const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const TOKEN_KEY = "maysoor_token";
/** The pre-rebrand key. Only the migration block below and logout touch it. */
const LEGACY_TOKEN_KEY = "atlas_token";

// ── One-time rebrand migration — DELIBERATELY TEMPORARY ────────────────────
// Renaming the storage key outright would sign out every session created
// before the ميسور rebrand, including the owner's own, mid-work: the browser
// would still be holding a perfectly valid JWT under a name nothing reads
// anymore. So the first load after the rename carries the value across and
// drops the old key.
//
// This block is safe to DELETE once no live session predates the rebrand.
// Sessions are JWTs with a finite TTL, so that moment arrives on its own —
// after the longest token lifetime has elapsed since deploy, nothing can
// still be storing `atlas_token`. Delete LEGACY_TOKEN_KEY and its removal in
// setAuthToken() at the same time.
if (!localStorage.getItem(TOKEN_KEY)) {
  const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (legacy) localStorage.setItem(TOKEN_KEY, legacy);
}
// Unconditional: whether it was just copied across, or was sitting stale
// beside an already-current maysoor_token, the old key has no reason to
// survive this load.
localStorage.removeItem(LEGACY_TOKEN_KEY);

let authToken: string | null = localStorage.getItem(TOKEN_KEY);

export function setAuthToken(token: string | null) {
  authToken = token;
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    // BOTH keys, always. If logout left atlas_token behind, the migration
    // above would find it on the next page load and silently sign the user
    // back in — a "log out" that does not log you out.
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
}

export function getAuthToken() {
  return authToken;
}

export class ApiClientError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * How long a request may hang before we give up on it.
 *
 * 60s, which is deliberately long: this app is deployed on a host that
 * suspends idle instances, and waking one takes ~50 seconds. A 30s timeout
 * would abort exactly the request that was about to succeed, and the user
 * would learn nothing except that the product is broken.
 *
 * Its real job is not speed, it is CLOSURE. `fetch` has no timeout of its
 * own, so before this a hung request left every page spinning forever —
 * neither `.then` nor `.catch` ever ran, so the error handling those pages
 * already had could not fire. An infinite spinner tells the user nothing
 * and gives them nothing to do; a message that names the likely cause lets
 * them act.
 */
const REQUEST_TIMEOUT_MS = 60_000;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  // FormData bodies must NOT get an explicit Content-Type — the browser
  // sets it (with the multipart boundary) only when left unset.
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (options.body && !headers["Content-Type"] && !isFormData) headers["Content-Type"] = "application/json";

  // AbortController rather than Promise.race: race leaves the real request
  // running in the background, so a slow endpoint keeps burning a connection
  // (and can still resolve and mutate state) long after the user gave up.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(`${BASE_URL}${path}`, { ...options, headers, signal: controller.signal });
  } catch (err) {
    // Two very different failures arrive here identically, and telling them
    // apart is the whole point — "the server is asleep" and "you are
    // offline" need opposite reactions from the user.
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiClientError(
        0,
        "TIMEOUT",
        "الخادم لم يستجب خلال دقيقة. قد يكون في وضع السكون — أعد المحاولة بعد لحظات، فأول طلب بعد فترة خمول يستغرق وقتًا أطول."
      );
    }
    throw new ApiClientError(
      0,
      "NETWORK_ERROR",
      "تعذّر الوصول إلى الخادم. تحقّق من اتصالك بالإنترنت، أو أن الخادم يعمل."
    );
  } finally {
    // In the finally so it runs on the success path too — otherwise every
    // completed request leaves a live timer behind, and a long session
    // accumulates thousands of them.
    clearTimeout(timer);
  }
  if (resp.status === 204) return undefined as T;

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const err = json?.error ?? { code: "UNKNOWN", message: "حدث خطأ غير متوقع" };
    throw new ApiClientError(resp.status, err.code, err.message);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, extraHeaders?: Record<string, string>) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined, headers: extraHeaders }),
  postForm: <T>(path: string, formData: FormData) => request<T>(path, { method: "POST", body: formData }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export { BASE_URL };
