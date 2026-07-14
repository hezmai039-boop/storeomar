import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiClientError } from "../api/client";
import type { SimulationLink } from "../api/types";
import { useStore } from "../context/StoreContext";

function simulationUrl(token: string) {
  return `${window.location.origin}/simulate/${token}`;
}

export function SimulationPage() {
  const { activeStore } = useStore();
  const [links, setLinks] = useState<SimulationLink[]>([]);
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!activeStore) return;
    api.get<{ data: SimulationLink[] }>(`/v1/stores/${activeStore.id}/simulation-links`).then((resp) => setLinks(resp.data));
  }, [activeStore]);

  useEffect(() => reload(), [reload]);

  if (!activeStore) return <div style={{ color: "var(--text-dim)" }}>اختر متجرًا من القائمة الجانبية أولًا.</div>;

  async function createLink(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await api.post(`/v1/stores/${activeStore!.id}/simulation-links`, { label });
      setLabel("");
      reload();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "تعذّر إنشاء الرابط");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggle(link: SimulationLink) {
    await api.patch(`/v1/stores/${activeStore!.id}/simulation-links/${link.id}`, { isActive: !link.isActive });
    reload();
  }

  async function copy(link: SimulationLink) {
    await navigator.clipboard.writeText(simulationUrl(link.token));
    setCopiedId(link.id);
    setTimeout(() => setCopiedId((id) => (id === link.id ? null : id)), 1800);
  }

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>المحاكاة</h1>
        <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>
          {activeStore.name} — روابط دردشة تجريبية تُشغِّل نفس الذكاء الاصطناعي الحقيقي، بلا حاجة لربط واتساب فعلي.
          كل رسالة تُخزَّن وتظهر في صندوق الوارد كأي محادثة حقيقية.
        </p>
      </div>

      <form onSubmit={createLink} className="card" style={{ padding: 20, marginBottom: 22, display: "flex", gap: 12, alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, flex: 1 }}>
          اسم الرابط (للتمييز فقط، لا يظهر للزائر)
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
            placeholder="مثال: اختبار فريق التسويق"
          />
        </label>
        <button className="btn btn-primary btn-sm" type="submit" disabled={submitting}>
          {submitting ? "جارٍ الإنشاء…" : "+ إنشاء رابط محاكاة"}
        </button>
      </form>
      {formError && <div style={{ color: "var(--critical)", fontSize: 13, marginBottom: 16 }}>{formError}</div>}

      {links.length === 0 ? (
        <div style={{ color: "var(--text-dim)", fontSize: 13 }}>لا روابط محاكاة بعد — أنشئ أول رابط أعلاه.</div>
      ) : (
        <div className="card">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["الاسم", "الرابط", "الحالة", "أُنشئ", ""].map((h) => (
                  <th
                    key={h}
                    style={{ textAlign: "right", fontSize: 11.5, color: "var(--text-faint)", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id}>
                  <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>{link.label}</td>
                  <td className="mono" style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--text-dim)" }}>
                    /simulate/{link.token.slice(0, 10)}…
                  </td>
                  <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                    <span className={`badge ${link.isActive ? "badge-good" : "badge-neutral"}`}>{link.isActive ? "فعّال" : "معطَّل"}</span>
                  </td>
                  <td className="mono" style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--text-dim)" }}>
                    {new Date(link.createdAt).toLocaleDateString("ar-SA")}
                  </td>
                  <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => copy(link)}>
                      {copiedId === link.id ? "تم النسخ ✓" : "نسخ الرابط"}
                    </button>
                    <button className={`btn btn-sm ${link.isActive ? "btn-danger" : "btn-good"}`} onClick={() => toggle(link)}>
                      {link.isActive ? "تعطيل" : "تفعيل"}
                    </button>
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
