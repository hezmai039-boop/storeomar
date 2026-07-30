import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";
import { api } from "../api/client";
import type { KnowledgeSuggestion, PlanRequest } from "../api/types";
import { usePermissions, PERMISSIONS } from "../lib/permissions";
import { LogoLockup } from "./Logo";
import "./AppShell.css";

const PENDING_REVIEW_POLL_MS = 45_000;

export function AppShell() {
  const { me, logout } = useAuth();
  const { activeStore, setActiveStoreId } = useStore();
  const { can } = usePermissions();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [leadCount, setLeadCount] = useState(0);
  const navigate = useNavigate();

  // Polling, not the backend's SSE /realtime endpoint — that route requires
  // a Bearer Authorization header (src/middleware/auth.ts), which the
  // browser's native EventSource API cannot attach. A 45s poll for "is
  // there anything to review" is a deliberately simple, robust choice
  // here — this is an attention cue for managers, not a live chat
  // stream that needs sub-second delivery.
  useEffect(() => {
    if (!activeStore) {
      setPendingCount(0);
      return;
    }
    let cancelled = false;
    const load = () => {
      api
        .get<{ data: KnowledgeSuggestion[] }>(`/v1/stores/${activeStore.id}/knowledge/suggestions?status=pending_review`)
        .then((resp) => {
          if (!cancelled) setPendingCount(resp.data.length);
        })
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, PENDING_REVIEW_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeStore]);

  // Landing-page plan requests, for platform staff only. With self-serve
  // signup closed this IS the inbound channel — a lead that sits unseen
  // until someone happens to open /billing is a customer who went
  // elsewhere — so it gets the same standing attention cue the knowledge
  // queue has.
  //
  // 403 is the expected answer for every ordinary customer and is swallowed
  // silently: not being platform staff is not an error, it just means no
  // badge. The endpoint's `meta.openCount` is used rather than the array
  // length because the list is capped at 200 rows.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .get<{ data: PlanRequest[]; meta: { openCount: number } }>("/v1/billing/admin/plan-requests?status=new")
        .then((resp) => {
          if (!cancelled) setLeadCount(resp.meta?.openCount ?? resp.data.length);
        })
        .catch(() => {
          if (!cancelled) setLeadCount(0);
        });
    };
    load();
    const interval = setInterval(load, PENDING_REVIEW_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!me) return null;

  return (
    <div className="app" dir="rtl" lang="ar">
      <header className="topbar">
        <div className="breadcrumb">
          {activeStore && <span>{activeStore.name} /</span>}
        </div>
        <div className="topbar-actions" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <NavLink
            to="/account"
            title="حسابي وكلمة المرور"
            style={({ isActive }) => ({
              fontSize: 13,
              color: isActive ? "var(--primary-strong)" : "var(--text-dim)",
              textDecoration: "none",
              fontWeight: isActive ? 700 : 500,
            })}
          >
            حسابي
          </NavLink>
          <button className="avatar" title={`${me.name} — تسجيل الخروج`} onClick={logout}>
            {me.name.slice(0, 1)}
          </button>
        </div>
      </header>

      <main className="content">
        <Outlet />
      </main>

      <nav className="sidebar">
        {/* One source of truth for the mark — see components/Logo.tsx. The
            sidebar used to draw its own letter tile, which is exactly how a
            brand drifts out of sync with its own app icon. */}
        <div className="brand">
          <LogoLockup size={34} />
        </div>

        {me.stores.length > 1 && (
          <div className={`switcher ${switcherOpen ? "open" : ""}`}>
            <button className="switcher-btn" onClick={() => setSwitcherOpen((o) => !o)}>
              <span>▾</span>
              <span className="label">{activeStore ? activeStore.name : "كل المتاجر"}</span>
            </button>
            {switcherOpen && (
              <div className="switcher-menu">
                {me.isOwner && (
                  <button
                    className={!activeStore ? "active" : ""}
                    onClick={() => {
                      setActiveStoreId(null);
                      setSwitcherOpen(false);
                      navigate("/overview");
                    }}
                  >
                    كل المتاجر (نظرة عامة)
                  </button>
                )}
                {me.stores.map((s) => (
                  <button
                    key={s.id}
                    className={activeStore?.id === s.id ? "active" : ""}
                    onClick={() => {
                      setActiveStoreId(s.id);
                      setSwitcherOpen(false);
                      navigate("/inbox");
                    }}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {me.isOwner && (
          <>
            <div className="nav-group-label">المؤسسة</div>
            <ul className="nav">
              <li>
                <NavLink to="/overview" className={({ isActive }) => (isActive ? "is-active" : "")}>
                  <span className="ic">◧</span> نظرة عامة
                </NavLink>
              </li>
              <li>
                <NavLink to="/stores" className={({ isActive }) => (isActive ? "is-active" : "")}>
                  <span className="ic">▦</span> المتاجر
                </NavLink>
              </li>
              <li>
                <NavLink to="/onboarding" className={({ isActive }) => (isActive ? "is-active" : "")}>
                  <span className="ic">＋</span> إضافة متجر جديد
                </NavLink>
              </li>
            </ul>
          </>
        )}

        <div className="nav-group-label">{activeStore ? `متجر: ${activeStore.name}` : "اختر متجرًا"}</div>
        <ul className="nav">
          <li>
            <NavLink to="/inbox" className={({ isActive }) => (isActive ? "is-active" : "")} aria-disabled={!activeStore}>
              <span className="ic">✉</span> صندوق الوارد
            </NavLink>
          </li>
          <li>
            <NavLink to="/knowledge" className={({ isActive }) => (isActive ? "is-active" : "")}>
              <span className="ic">▤</span> قاعدة المعرفة
              {pendingCount > 0 && (
                <span className="nav-badge" title={`${pendingCount} بانتظار المراجعة`}>
                  {pendingCount}
                </span>
              )}
            </NavLink>
          </li>
          <li>
            <NavLink to="/tickets" className={({ isActive }) => (isActive ? "is-active" : "")}>
              <span className="ic">◎</span> التذاكر
            </NavLink>
          </li>
          {/* Front-line agents don't manage simulation links or store
              settings — hide what they can't use so no button ever 403s. */}
          {can(PERMISSIONS.SIMULATION_MANAGE) && (
            <li>
              <NavLink to="/simulation" className={({ isActive }) => (isActive ? "is-active" : "")}>
                <span className="ic">◐</span> المحاكاة
              </NavLink>
            </li>
          )}
          {can(PERMISSIONS.SETTINGS_MANAGE) && (
            <li>
              <NavLink to="/settings" className={({ isActive }) => (isActive ? "is-active" : "")}>
                <span className="ic">⚙</span> الإعدادات
              </NavLink>
            </li>
          )}
        </ul>

        {/* Billing is organization-scoped, not store-scoped: a store manager
            holds billing.view but never sees the owner-only «المؤسسة» group
            above, so it gets its own entry rather than living in either. */}
        {can(PERMISSIONS.BILLING_VIEW) && (
          <>
            <div className="nav-group-label">الاشتراك</div>
            <ul className="nav">
              <li>
                <NavLink to="/billing" className={({ isActive }) => (isActive ? "is-active" : "")}>
                  <span className="ic">◈</span> الاشتراك والفوترة
                  {leadCount > 0 && (
                    <span className="nav-badge" title={`${leadCount} طلب باقة جديد`}>
                      {leadCount}
                    </span>
                  )}
                </NavLink>
              </li>
            </ul>
          </>
        )}

        <div className="sidebar-foot">ميسور · MVP قيد التطوير</div>
      </nav>
    </div>
  );
}
