import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { StoreOverview, StoreChannelHealth } from "../api/types";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";

// A connected channel is healthy; anything else needs the owner's attention
// (most often an expired WhatsApp Access Token → rotate in Settings).
const CHANNEL_STATUS: Record<string, { label: string; badge: string }> = {
  connected: { label: "متصلة", badge: "badge-good" },
  error: { label: "خطأ — تحقق من التوكن", badge: "badge-critical" },
  disconnected: { label: "مفصولة", badge: "badge-warn" },
  pending: { label: "قيد الإعداد", badge: "badge-neutral" },
};

export function OverviewPage() {
  const { me } = useAuth();
  const { setActiveStoreId } = useStore();
  const navigate = useNavigate();
  const [stores, setStores] = useState<StoreOverview[] | null>(null);
  const [health, setHealth] = useState<StoreChannelHealth[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    api
      .get<{ data: { stores: StoreOverview[] } }>(`/v1/organizations/${me.organizationId}/reports/overview?range=7d`)
      .then((resp) => setStores(resp.data.stores))
      .catch(() => setError("تعذّر تحميل التقرير"));
    api
      .get<{ data: { stores: StoreChannelHealth[] } }>(`/v1/organizations/${me.organizationId}/reports/channel-health`)
      .then((resp) => setHealth(resp.data.stores))
      .catch(() => {
        /* channel-health is a secondary panel; its failure must not blank the page */
      });
  }, [me]);

  // Stores with at least one non-connected channel — surfaced first so an
  // expired token anywhere is impossible to miss.
  const needsAttention = (health ?? []).filter((s) => s.channels.some((c) => c.status !== "connected"));

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>نظرة عامة</h1>
        <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>كل المتاجر — آخر 7 أيام</p>
      </div>

      {error && <div style={{ color: "var(--critical)" }}>{error}</div>}
      {!stores && !error && <div style={{ color: "var(--text-dim)" }}>جارٍ التحميل…</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 16 }}>
        {stores?.map((s, i) => (
          <div
            key={s.id}
            className="card card-hover atlas-enter"
            style={{ padding: "18px 20px", cursor: "pointer", animationDelay: `${Math.min(i, 6) * 40}ms` }}
            onClick={() => {
              setActiveStoreId(s.id);
              navigate("/inbox");
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  background: "var(--primary-gradient)",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 14,
                  flexShrink: 0,
                  boxShadow: "0 4px 14px var(--primary-glow)",
                }}
              >
                {s.name.slice(0, 1)}
              </div>
              <b style={{ fontSize: 14.5, flex: 1 }}>{s.name}</b>
              <span className={`badge ${s.escalationRate > 30 ? "badge-warn" : "badge-good"}`}>
                {s.escalationRate > 30 ? "تحتاج انتباهًا" : "بخير"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-dim)" }}>
              <div>
                محادثات
                <b className="mono" style={{ display: "block", fontSize: 15, color: "var(--text)", marginTop: 2 }}>
                  {s.totalConversations}
                </b>
              </div>
              <div>
                رد آلي
                <b className="mono" style={{ display: "block", fontSize: 15, color: "var(--text)", marginTop: 2 }}>
                  {s.aiResolvedRate}٪
                </b>
              </div>
              <div>
                تذاكر مفتوحة
                <b className="mono" style={{ display: "block", fontSize: 15, color: "var(--text)", marginTop: 2 }}>
                  {s.openTickets}
                </b>
              </div>
            </div>
          </div>
        ))}
      </div>

      {health && (
        <section style={{ marginTop: 34 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <h2 style={{ fontSize: 16, margin: 0 }}>صحة القنوات</h2>
            {needsAttention.length > 0 && (
              <span className="badge badge-critical">{needsAttention.length} متجر يحتاج انتباهًا</span>
            )}
          </div>
          <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>
            حالة اتصال قنوات كل متجر. أي قناة بحالة «خطأ» غالبًا يعني انتهاء صلاحية Access Token — حدّثها من
            إعدادات ذلك المتجر.
          </p>

          <div className="card" style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["المتجر", "القناة", "المعرّف", "الحالة"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "right",
                        fontSize: 11.5,
                        color: "var(--text-faint)",
                        padding: "10px 14px",
                        borderBottom: "1px solid var(--border)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {health.flatMap((store) =>
                  store.channels.length === 0
                    ? [
                        <tr key={store.id}>
                          <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>{store.name}</td>
                          <td colSpan={3} style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 12.5, color: "var(--text-faint)" }}>
                            لا قنوات مربوطة بعد
                          </td>
                        </tr>,
                      ]
                    : store.channels.map((c, idx) => {
                        const meta = CHANNEL_STATUS[c.status] ?? { label: c.status, badge: "badge-neutral" };
                        return (
                          <tr
                            key={c.id}
                            style={{ cursor: "pointer" }}
                            onClick={() => {
                              setActiveStoreId(store.id);
                              navigate("/settings");
                            }}
                          >
                            <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                              {idx === 0 ? store.name : ""}
                            </td>
                            <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>{c.channelType}</td>
                            <td className="mono" style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--text-dim)" }}>
                              {c.externalAccountId}
                            </td>
                            <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                              <span className={`badge ${meta.badge}`}>{meta.label}</span>
                            </td>
                          </tr>
                        );
                      })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
