import { FormEvent, useState } from "react";
import { api, ApiClientError } from "../api/client";
import { useAuth } from "../context/AuthContext";

export function AccountPage() {
  const { me } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!me) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirm) {
      setError("كلمتا المرور الجديدتان غير متطابقتين");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/v1/auth/change-password", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "تعذّر تغيير كلمة المرور");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 520 }}>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>حسابي</h1>
        <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>
          {me.name} — {me.email}
        </p>
      </div>

      <section>
        <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>تغيير كلمة المرور</h2>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>
          يُنصح بشدة بتغيير كلمة المرور الافتراضية قبل استخدام المنصة فعليًا.
        </p>

        <form onSubmit={submit} className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            كلمة المرور الحالية
            <input type="password" dir="ltr" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoComplete="current-password" />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            كلمة المرور الجديدة (8 أحرف على الأقل)
            <input type="password" dir="ltr" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            تأكيد كلمة المرور الجديدة
            <input type="password" dir="ltr" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" />
          </label>

          {error && <div style={{ color: "var(--critical)", fontSize: 13 }}>{error}</div>}
          {done && <div style={{ color: "var(--good)", fontSize: 13 }}>✓ تم تغيير كلمة المرور بنجاح. استخدمها في تسجيل الدخول القادم.</div>}

          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={submitting}>
              {submitting ? "جارٍ الحفظ…" : "تغيير كلمة المرور"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
