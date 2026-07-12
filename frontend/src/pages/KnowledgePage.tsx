import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiClientError } from "../api/client";
import type { KnowledgeSource, KnowledgeSuggestion } from "../api/types";
import { useStore } from "../context/StoreContext";

const FILE_TYPES = new Set(["pdf", "word", "excel"]);
const SOURCE_TYPE_LABELS: Record<string, string> = {
  pdf: "ملف PDF",
  word: "ملف Word",
  excel: "ملف Excel",
  faq: "أسئلة شائعة",
  webpage: "صفحة موقع",
  product: "صفحة منتج",
  shipping_policy: "سياسة الشحن",
  return_policy: "سياسة الاسترجاع",
};

export function KnowledgePage() {
  const { activeStore } = useStore();
  const [tab, setTab] = useState<"pending" | "active">("pending");
  const [suggestions, setSuggestions] = useState<KnowledgeSuggestion[]>([]);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [sourceType, setSourceType] = useState("faq");
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const isFileType = FILE_TYPES.has(sourceType);

  async function submitSource(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      if (isFileType) {
        const file = fileInputRef.current?.files?.[0];
        if (!file) throw new Error("أرفق ملفًا أولًا");
        const form = new FormData();
        form.set("type", sourceType);
        form.set("title", title);
        form.set("file", file);
        await api.postForm(`/v1/stores/${activeStore!.id}/knowledge/sources`, form);
      } else {
        await api.post(`/v1/stores/${activeStore!.id}/knowledge/sources`, { type: sourceType, title, rawText });
      }
      setTitle("");
      setRawText("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setShowAddForm(false);
      setTab("active");
      reload();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "تعذّرت إضافة المصدر");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22, gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>قاعدة المعرفة</h1>
          <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>
            {activeStore.name} — لا تحديث تلقائي؛ كل إضافة تمر بموافقتك
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowAddForm((v) => !v)}>
          {showAddForm ? "إغلاق" : "+ إضافة مصدر معرفة"}
        </button>
      </div>

      {showAddForm && (
        <form onSubmit={submitSource} className="card" style={{ padding: 20, marginBottom: 22, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              نوع المصدر
              <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
                {Object.entries(SOURCE_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              العنوان
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="مثال: سياسة الشحن والاسترجاع" />
            </label>
          </div>

          {isFileType ? (
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              الملف ({sourceType === "pdf" ? ".pdf" : sourceType === "word" ? ".docx" : ".xlsx"})
              <input
                ref={fileInputRef}
                type="file"
                required
                accept={sourceType === "pdf" ? ".pdf" : sourceType === "word" ? ".docx" : ".xlsx"}
              />
              <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
                يُستخرَج النص تلقائيًا من الملف ويُفهرَس فورًا. الحد الأقصى 10 ميجابايت.
              </span>
            </label>
          ) : (
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              النص
              <textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                required
                rows={6}
                placeholder="الصق النص هنا — سيُقسَّم ويُفهرَس تلقائيًا"
                style={{ resize: "vertical", fontFamily: "inherit" }}
              />
            </label>
          )}

          {formError && <div style={{ color: "var(--critical)", fontSize: 13 }}>{formError}</div>}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={submitting}>
              {submitting ? "جارٍ الإضافة…" : "إضافة وفهرسة"}
            </button>
          </div>
        </form>
      )}

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
            color: tab === "pending" ? "var(--primary-strong)" : "var(--text-dim)",
            fontWeight: tab === "pending" ? 700 : 400,
            borderBottom: tab === "pending" ? "2px solid var(--primary)" : "2px solid transparent",
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
            color: tab === "active" ? "var(--primary-strong)" : "var(--text-dim)",
            fontWeight: tab === "active" ? 700 : 400,
            borderBottom: tab === "active" ? "2px solid var(--primary)" : "2px solid transparent",
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
