const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

let authToken: string | null = localStorage.getItem("atlas_token");

export function setAuthToken(token: string | null) {
  authToken = token;
  if (token) localStorage.setItem("atlas_token", token);
  else localStorage.removeItem("atlas_token");
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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const resp = await fetch(`${BASE_URL}${path}`, { ...options, headers });
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
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export { BASE_URL };
