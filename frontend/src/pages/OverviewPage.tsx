import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { StoreOverview } from "../api/types";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";

export function OverviewPage() {
  const { me } = useAuth();
  const { setActiveStoreId } = useStore();
  const navigate = useNavigate();
  const [stores, setStores] = useState<StoreOverview[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    api
      .get<{ data: { stores: StoreOverview[] } }>(`/v1/organizations/${me.organizationId}/reports/overview?range=7d`)
      .then((resp) => setStores(resp.data.stores))
      .catch(() => setError("تعذّر تحميل التقرير"));
  }, [me]);

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
    </div>
  );
}
