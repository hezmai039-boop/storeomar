import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiClientError, getAuthToken, setAuthToken } from "../api/client";
import type { Me } from "../api/types";

interface AuthContextValue {
  me: Me | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    if (!getAuthToken()) {
      setLoading(false);
      return;
    }
    try {
      const resp = await api.get<{ data: Me }>("/v1/me");
      setMe(resp.data);
    } catch {
      setAuthToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const resp = await api.post<{ data: { token: string } }>("/v1/auth/login", { email, password });
      setAuthToken(resp.data.token);
      const meResp = await api.get<{ data: Me }>("/v1/me");
      setMe(meResp.data);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "تعذّر تسجيل الدخول");
      throw err;
    }
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    setMe(null);
  }, []);

  return <AuthContext.Provider value={{ me, loading, error, login, logout, refreshMe: loadMe }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
