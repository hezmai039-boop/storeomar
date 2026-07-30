import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "./AuthContext";
import type { StoreSummary } from "../api/types";

interface StoreContextValue {
  activeStore: StoreSummary | null;
  /** null = owner viewing the cross-store overview, not a single store. */
  setActiveStoreId: (id: string | null) => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

// Renamed with the rebrand and NOT migrated. This is a UI preference, and
// the effect below already repairs an absent/unknown value on first render —
// an owner lands on the cross-store overview, anyone else on their first
// store — so the one-time reset costs a single click at most.
const ACTIVE_STORE_KEY = "maysoor_active_store";

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const { me } = useAuth();
  const [activeStoreId, setActiveStoreId] = useState<string | null>(() => localStorage.getItem(ACTIVE_STORE_KEY));

  useEffect(() => {
    if (activeStoreId) localStorage.setItem(ACTIVE_STORE_KEY, activeStoreId);
    else localStorage.removeItem(ACTIVE_STORE_KEY);
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
