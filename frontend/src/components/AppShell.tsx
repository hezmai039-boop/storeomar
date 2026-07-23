import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";
import { api } from "../api/client";
import type { KnowledgeSuggestion } from "../api/types";
import { usePermissions, PERMISSIONS } from "../lib/permissions";
import "./AppShell.css";

const PENDING_REVIEW_POLL_MS = 45_000;

export function AppShell() {
  const { me, logout } = useAuth();
  const { activeStore, setActiveStoreId } = useStore();
  const { can } = usePermissions();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
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

  if (!me) return null;

  return (
    <div className="app" dir="rtl" lang="ar">
      <header className="topbar">
        <div className="breadcrumb">
          {activeStore && <span>{activeStore.name} /</span>}
        </div>
        <div className="topbar-actions">
          <button className="avatar" title={`${me.name} — تسجيل الخروج`} onClick={logout}>
            {me.name.slice(0, 1)}
          </button>
        </div>
      </header>

      <main className="content">
        <Outlet />
      </main>

      <nav className="sidebar">
        <div className="brand">
          <div className="mark">A</div>
          <div>
            <div className="name">Atlas</div>
            <div className="tag">store ops control tower</div>
          </div>
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

        <div className="sidebar-foot">Atlas · MVP قيد التطوير</div>
      </nav>
    </div>
  );
}
