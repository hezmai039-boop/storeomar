import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "./AuthContext";
import type { StoreSummary } from "../api/types";

interface StoreContextValue {
  activeStore: StoreSummary | null;
  /** null = owner viewing the cross-store overview, not a single store. */
  setActiveStoreId: (id: string | null) => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const { me } = useAuth();
  const [activeStoreId, setActiveStoreId] = useState<string | null>(() => localStorage.getItem("atlas_active_store"));

  useEffect(() => {
    if (activeStoreId) localStorage.setItem("atlas_active_store", activeStoreId);
    else localStorage.removeItem("atlas_active_store");
  }, [activeStoreId]);

  // If the remembered store isn't in this user's list anymore, fall back.
  useEffect(() => {
    if (!me) return;
    if (activeStoreId && !me.stores.some((s) => s.id === activeStoreId)) {
      setActiveStoreId(me.isOwner ? null : me.stores[0]?.id ?? null);
    }
    if (!activeStoreId && !me.isOwner) {
      setActiveStoreId(me.stores[0]?.id ?? null);
    }
  }, [me, activeStoreId]);

  const activeStore = useMemo(() => me?.stores.find((s) => s.id === activeStoreId) ?? null, [me, activeStoreId]);

  return <StoreContext.Provider value={{ activeStore, setActiveStoreId }}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
