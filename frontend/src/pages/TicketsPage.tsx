import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { Ticket } from "../api/types";
import { useStore } from "../context/StoreContext";

const STATUSES: Array<{ key: string; label: string }> = [
  { key: "open", label: "مفتوحة" },
  { key: "in_progress", label: "قيد المعالجة" },
  { key: "resolved", label: "محلولة" },
  { key: "closed", label: "مغلقة" },
];

const PRIORITY_BADGE: Record<string, string> = {
  urgent: "badge-critical",
  high: "badge-critical",
  medium: "badge-warn",
  low: "badge-good",
};

export function TicketsPage() {
  const { activeStore } = useStore();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<Ticket | null>(null);

  const reload = useCallback(() => {
    if (!activeStore) return;
    api.get<{ data: Ticket[] }>(`/v1/stores/${activeStore.id}/tickets`).then((resp) => setTickets(resp.data));
  }, [activeStore]);

  useEffect(() => reload(), [reload]);

  if (!activeStore) return <div style={{ color: "var(--text-dim)" }}>اختر متجرًا من القائمة الجانبية أولًا.</div>;

  async function updateTicket(id: string, patch: Record<string, unknown>) {
    if (!activeStore) return;
    await api.patch(`/v1/stores/${activeStore.id}/tickets/${id}`, patch);
    setSelected(null);
    reload();
  }

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>التذاكر</h1>
        <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>{activeStore.name}</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, alignItems: "start" }}>
        {STATUSES.map((col) => {
          const inColumn = tickets.filter((t) => t.status === col.key);
          return (
            <div key={col.key}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-dim)", padding: "4px 6px 12px" }}>
                {col.label} <span className="mono">{inColumn.length}</span>
              </div>
              {inColumn.map((t) => (
                <div
                  key={t.id}
                  className="card"
                  style={{ padding: "12px 14px", marginBottom: 10, cursor: "pointer" }}
                  onClick={() => setSelected(t)}
                >
                  <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 6 }}>
                    {t.id.slice(0, 8)}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                    {t.escalationReason ?? "تذكرة عميل"}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span className={`badge ${PRIORITY_BADGE[t.priority] ?? "badge-neutral"}`}>{t.priority}</span>
                    <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{t.department?.name ?? "—"}</span>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {selected && (
        <>
          <div
            onClick={() => setSelected(null)}
            style={{ position: "fixed", inset: 0, background: "rgba(10,14,20,.4)", zIndex: 60 }}
          />
          <aside
            style={{
              position: "fixed",
              top: 0,
              bottom: 0,
              left: 0,
              width: 400,
              maxWidth: "90vw",
              background: "var(--surface)",
              boxShadow: "var(--shadow-3)",
              zIndex: 61,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", padding: "18px 20px", borderBottom: "1px solid var(--border)" }}>
              <div>
                <div className="mono" style={{ fontSize: 12, color: "var(--text-faint)" }}>
                  {selected.id.slice(0, 8)}
                </div>
                <h2 style={{ fontSize: 15.5, margin: 0 }}>{selected.escalationReason ?? "تذكرة عميل"}</h2>
              </div>
              <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", fontSize: 16, cursor: "pointer" }}>
                ✕
              </button>
            </div>
            <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 18, flex: 1, overflowY: "auto" }}>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 6 }}>بيانات العميل</div>
                <div style={{ fontSize: 13.5 }}>{selected.customer.name ?? selected.customer.externalId}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 6 }}>توصية الذكاء الاصطناعي</div>
                <div className="badge-info badge" style={{ padding: "8px 12px", fontSize: 13, display: "block" }}>
                  {selected.aiRecommendation ?? "لا توصية"}
                </div>
              </div>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                الحالة
                <select value={selected.status} onChange={(e) => updateTicket(selected.id, { status: e.target.value })}>
                  {STATUSES.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                الأولوية
                <select value={selected.priority} onChange={(e) => updateTicket(selected.id, { priority: e.target.value })}>
                  {["low", "medium", "high", "urgent"].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
