import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { KnowledgeSource, KnowledgeSuggestion } from "../api/types";
import { useStore } from "../context/StoreContext";

export function KnowledgePage() {
  const { activeStore } = useStore();
  const [tab, setTab] = useState<"pending" | "active">("pending");
  const [suggestions, setSuggestions] = useState<KnowledgeSuggestion[]>([]);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);

  const reload = useCallback(() => {
    if (!activeStore) return;
    api
      .get<{ data: KnowledgeSuggestion[] }>(`/v1/stores/${activeStore.id}/knowledge/suggestions?status=pending_review`)
      .then((resp) => setSuggestions(resp.data));
    api
      .get<{ data: KnowledgeSource[] }>(`/v1/stores/${activeStore.id}/knowledge/sources`)
      .then((resp) => setSources(resp.data));
  }, [activeStore]);

  useEffect(() => reload(), [reload]);

  if (!activeStore) return <div style={{ color: "var(--text-dim)" }}>اختر متجرًا من القائمة الجانبية أولًا.</div>;

  async function decide(id: string, action: "approve" | "reject") {
    await api.post(`/v1/stores/${activeStore!.id}/knowledge/suggestions/${id}/${action}`);
    reload();
  }

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>قاعدة المعرفة</h1>
        <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>
          {activeStore.name} — لا تحديث تلقائي؛ كل إضافة تمر بموافقتك
        </p>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 18, borderBottom: "1px solid var(--border)" }}>
        <button
          onClick={() => setTab("pending")}
          style={{
            background: "none",
            border: "none",
            padding: "10px 4px",
            marginInlineEnd: 20,
            fontSize: 13.5,
            cursor: "pointer",
            color: tab === "pending" ? "var(--accent-strong)" : "var(--text-dim)",
            fontWeight: tab === "pending" ? 700 : 400,
            borderBottom: tab === "pending" ? "2px solid var(--accent)" : "2px solid transparent",
          }}
        >
          بانتظار المراجعة ({suggestions.length})
        </button>
        <button
          onClick={() => setTab("active")}
          style={{
            background: "none",
            border: "none",
            padding: "10px 4px",
            fontSize: 13.5,
            cursor: "pointer",
            color: tab === "active" ? "var(--accent-strong)" : "var(--text-dim)",
            fontWeight: tab === "active" ? 700 : 400,
            borderBottom: tab === "active" ? "2px solid var(--accent)" : "2px solid transparent",
          }}
        >
          المصادر النشطة
        </button>
      </div>

      {tab === "pending" &&
        (suggestions.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: 13 }}>لا اقتراحات بانتظار المراجعة.</div>
        ) : (
          suggestions.map((s) => (
            <div key={s.id} className="card" style={{ padding: "16px 18px", marginBottom: 12 }}>
              <div style={{ fontSize: 14, whiteSpace: "pre-wrap", marginBottom: 12 }}>{s.content}</div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="btn btn-danger btn-sm" onClick={() => decide(s.id, "reject")}>
                  رفض
                </button>
                <button className="btn btn-good btn-sm" onClick={() => decide(s.id, "approve")}>
                  موافقة وفهرسة
                </button>
              </div>
            </div>
          ))
        ))}

      {tab === "active" && (
        <div className="card">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["المصدر", "النوع", "عدد المقاطع", "الحالة"].map((h) => (
                  <th key={h} style={{ textAlign: "right", fontSize: 11.5, color: "var(--text-faint)", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>{s.title}</td>
                  <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>{s.type}</td>
                  <td className="mono" style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                    {s._count?.chunks ?? 0}
                  </td>
                  <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                    <span className="badge badge-good">{s.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
