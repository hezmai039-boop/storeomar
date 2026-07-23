import { FormEvent, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import type { Store } from "../api/types";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";

function generatePassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => chars[Math.floor(Math.random() * chars.length)];
  return `${Array.from({ length: 10 }, pick).join("")}!`;
}

export function StoresAdminPage() {
  const { me, refreshMe } = useAuth();
  const { setActiveStoreId } = useStore();
  const navigate = useNavigate();

  const [stores, setStores] = useState<Store[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // per-store inline edit state
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [assignId, setAssignId] = useState<string | null>(null);
  const [assign, setAssign] = useState({ ownerName: "", ownerEmail: "", ownerPassword: "" });

  const reload = useCallback(() => {
    api.get<{ data: Store[] }>("/v1/stores").then((r) => setStores(r.data)).catch(() => setError("تعذّر تحميل المتاجر"));
  }, []);
  useEffect(() => reload(), [reload]);

  if (!me) return null;
  if (!me.isOwner) return <div style={{ color: "var(--text-dim)" }}>هذه الصفحة متاحة لمالك المنصة فقط.</div>;

  function flash(msg: string) {
    setOkMsg(msg);
    setTimeout(() => setOkMsg((c) => (c === msg ? null : c)), 4000);
  }

  async function rename(store: Store) {
    setBusyId(store.id);
    setError(null);
    try {
      await api.patch(`/v1/stores/${store.id}`, { name: renameVal });
      setRenameId(null);
      await refreshMe();
      reload();
      flash(`تم تغيير الاسم إلى «${renameVal}»`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "تعذّر تغيير الاسم");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleStatus(store: Store) {
    const next = store.status === "disabled" ? "active" : "disabled";
    if (next === "disabled" && !window.confirm(`إيقاف متجر «${store.name}»؟ يمكن إعادة تفعيله في أي وقت بلا فقد بيانات.`)) return;
    setBusyId(store.id);
    setError(null);
    try {
      await api.patch(`/v1/stores/${store.id}/status`, { status: next });
      reload();
      flash(next === "disabled" ? `تم إيقاف «${store.name}»` : `تم تفعيل «${store.name}»`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "تعذّر تغيير الحالة");
    } finally {
      setBusyId(null);
    }
  }

  async function assignManager(e: FormEvent, store: Store) {
    e.preventDefault();
    setBusyId(store.id);
    setError(null);
    try {
      const resp = await api.post<{ data: { ownerEmail: string; ownerAccountCreated: boolean } }>(
        `/v1/organizations/${me!.organizationId}/stores/${store.id}/assign-manager`,
        assign
      );
      setAssignId(null);
      setAssign({ ownerName: "", ownerEmail: "", ownerPassword: "" });
      flash(
        resp.data.ownerAccountCreated
          ? `تم إنشاء حساب صاحب المتجر (${resp.data.ownerEmail}) وربطه بـ«${store.name}» — سلّمه كلمة المرور`
          : `تم ربط الحساب (${resp.data.ownerEmail}) بـ«${store.name}»`
      );
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "تعذّر تعيين صاحب المتجر");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22, gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>المتاجر</h1>
          <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>
            فعّل أي متجر لعميل حقيقي: غيّر اسمه، عيّن له حساب دخول صاحبه، أو أوقفه — كلها قابلة للتراجع بلا فقد بيانات.
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => navigate("/onboarding")}>
          ＋ متجر جديد
        </button>
      </div>

      {error && <div style={{ color: "var(--critical)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {okMsg && <div style={{ color: "var(--good)", fontSize: 13, marginBottom: 12 }}>{okMsg}</div>}
      {!stores && !error && <div style={{ color: "var(--text-dim)" }}>جارٍ التحميل…</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {stores?.map((s) => (
          <div key={s.id} className="card" style={{ padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                {renameId === s.id ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <input value={renameVal} onChange={(e) => setRenameVal(e.target.value)} style={{ flex: 1 }} autoFocus />
                    <button className="btn btn-primary btn-sm" disabled={busyId === s.id} onClick={() => rename(s)}>حفظ</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setRenameId(null)}>إلغاء</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <b style={{ fontSize: 15 }}>{s.name}</b>
                    <span className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)" }}>{s.slug}</span>
                    <span className={`badge ${s.status === "active" ? "badge-good" : "badge-warn"}`}>
                      {s.status === "active" ? "نشط" : "موقوف"}
                    </span>
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn btn-ghost btn-sm" onClick={() => { setRenameId(s.id); setRenameVal(s.name); }}>
                  إعادة تسمية
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setAssignId(assignId === s.id ? null : s.id); setAssign({ ownerName: "", ownerEmail: "", ownerPassword: "" }); }}
                >
                  تعيين صاحب المتجر
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setActiveStoreId(s.id); navigate("/settings"); }}>
                  الإعدادات
                </button>
                <button
                  className={`btn btn-sm ${s.status === "active" ? "btn-danger" : "btn-good"}`}
                  disabled={busyId === s.id}
                  onClick={() => toggleStatus(s)}
                >
                  {s.status === "active" ? "إيقاف" : "تفعيل"}
                </button>
              </div>
            </div>

            {assignId === s.id && (
              <form onSubmit={(e) => assignManager(e, s)} style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>أنشئ حساب دخول لصاحب هذا المتجر (يرى متجره فقط):</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <input placeholder="اسم صاحب المتجر" value={assign.ownerName} onChange={(e) => setAssign((a) => ({ ...a, ownerName: e.target.value }))} required />
                  <input type="email" placeholder="البريد الإلكتروني" dir="ltr" value={assign.ownerEmail} onChange={(e) => setAssign((a) => ({ ...a, ownerEmail: e.target.value }))} required />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input className="mono" dir="ltr" placeholder="كلمة المرور (8+)" minLength={8} value={assign.ownerPassword} onChange={(e) => setAssign((a) => ({ ...a, ownerPassword: e.target.value }))} required style={{ flex: 1 }} />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAssign((a) => ({ ...a, ownerPassword: generatePassword() }))}>توليد</button>
                </div>
                <div>
                  <button className="btn btn-primary btn-sm" type="submit" disabled={busyId === s.id}>
                    {busyId === s.id ? "جارٍ…" : "إنشاء وربط الحساب"}
                  </button>
                </div>
              </form>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
