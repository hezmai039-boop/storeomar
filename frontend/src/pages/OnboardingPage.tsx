import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import type { Store } from "../api/types";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";

// Turn an Arabic (or any) store name into a URL-safe slug suggestion. The
// backend enforces ^[a-z0-9-]+$, so we can only carry over latin chars/
// digits; for a purely-Arabic name this yields "" and the owner types one.
function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generatePassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = () => chars[Math.floor(Math.random() * chars.length)];
  return `${Array.from({ length: 10 }, pick).join("")}!`;
}

interface OnboardResult {
  store: Store;
  ownerEmail: string;
  ownerAccountCreated: boolean;
}

export function OnboardingPage() {
  const { me, refreshMe } = useAuth();
  const { setActiveStoreId } = useStore();
  const navigate = useNavigate();

  const [storeName, setStoreName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<OnboardResult | null>(null);

  if (!me) return null;
  if (!me.isOwner) return <div style={{ color: "var(--text-dim)" }}>هذه الصفحة متاحة لمالك المنصة فقط.</div>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const resp = await api.post<{ data: OnboardResult }>(`/v1/organizations/${me!.organizationId}/onboard-store`, {
        storeName,
        slug,
        ownerName,
        ownerEmail,
        ownerPassword,
      });
      await refreshMe();
      setDone(resp.data);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "تعذّرت إضافة المتجر");
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setStoreName("");
    setSlug("");
    setSlugEdited(false);
    setOwnerName("");
    setOwnerEmail("");
    setOwnerPassword("");
    setDone(null);
    setError(null);
  }

  if (done) {
    return (
      <div style={{ maxWidth: 640 }}>
        <div className="card atlas-enter" style={{ padding: 24, borderColor: "var(--good)", boxShadow: "0 8px 24px rgba(22,163,74,0.15)" }}>
          <h1 style={{ fontSize: 20, margin: "0 0 6px" }}>✅ تم إنشاء المتجر بنجاح</h1>
          <p style={{ margin: "0 0 18px", color: "var(--text-dim)", fontSize: 13.5 }}>
            المتجر ووكيل الذكاء الاصطناعي وحساب دخول صاحبه — كلها جاهزة الآن.
          </p>

          <div style={{ background: "var(--surface-2)", borderRadius: 10, padding: "14px 16px", marginBottom: 18, fontSize: 13.5, lineHeight: 2 }}>
            <div>🏬 المتجر: <b>{done.store.name}</b></div>
            <div>👤 دخول صاحب المتجر: <b className="mono">{done.ownerEmail}</b></div>
            {done.ownerAccountCreated ? (
              <div style={{ color: "var(--warn)" }}>
                🔑 كلمة المرور التي أدخلتها فعّالة الآن — سلّمها لصاحب المتجر عبر قناة آمنة. لن تُعرض مرة أخرى.
              </div>
            ) : (
              <div style={{ color: "var(--text-dim)" }}>
                ℹ️ هذا البريد كان لديه حساب سابق — أُضيف له المتجر الجديد بنفس كلمة مروره الحالية.
              </div>
            )}
          </div>

          <div style={{ fontSize: 13.5, marginBottom: 8, fontWeight: 700 }}>الخطوة التالية: ربط واتساب</div>
          <p style={{ margin: "0 0 16px", color: "var(--text-dim)", fontSize: 12.5, lineHeight: 1.9 }}>
            افتح إعدادات المتجر الجديد لربط رقم واتساب الخاص به (تحتاج Phone Number ID و Access Token — الخطوات في
            docs/22-whatsapp-store-onboarding-manual.md).
          </p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                setActiveStoreId(done.store.id);
                navigate("/settings");
              }}
            >
              فتح إعدادات المتجر لربط واتساب
            </button>
            <button className="btn btn-ghost btn-sm" onClick={reset}>
              إضافة متجر آخر
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>إضافة متجر جديد</h1>
        <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>
          إنشاء متجر عميل جديد وحساب دخول صاحبه في خطوة واحدة. ربط واتساب يتم بعدها من إعدادات المتجر.
        </p>
      </div>

      <form onSubmit={submit} className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-dim)" }}>بيانات المتجر</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            اسم المتجر
            <input
              value={storeName}
              onChange={(e) => {
                setStoreName(e.target.value);
                if (!slugEdited) setSlug(suggestSlug(e.target.value));
              }}
              required
              placeholder="مثال: متجر غذائك"
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            المعرّف (slug) — إنجليزي
            <input
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugEdited(true);
              }}
              required
              placeholder="ghidhaak"
              className="mono"
              dir="ltr"
            />
          </label>
        </div>

        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-dim)", marginTop: 4 }}>حساب دخول صاحب المتجر</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            اسم صاحب المتجر
            <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required placeholder="الاسم الكامل" />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            البريد الإلكتروني (اسم الدخول)
            <input type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} required placeholder="owner@example.com" dir="ltr" />
          </label>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          كلمة المرور (8 أحرف على الأقل)
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={ownerPassword}
              onChange={(e) => setOwnerPassword(e.target.value)}
              required
              minLength={8}
              className="mono"
              dir="ltr"
              style={{ flex: 1 }}
              placeholder="********"
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOwnerPassword(generatePassword())}>
              توليد
            </button>
          </div>
          <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
            ستُسلَّم لصاحب المتجر ليدخل بها. لن تُعرض بعد الإنشاء — انسخها إن ولّدتها.
          </span>
        </label>

        {error && <div style={{ color: "var(--critical)", fontSize: 13 }}>{error}</div>}

        <div>
          <button className="btn btn-primary btn-sm" type="submit" disabled={submitting}>
            {submitting ? "جارٍ الإنشاء…" : "إنشاء المتجر وحساب صاحبه"}
          </button>
        </div>
      </form>
    </div>
  );
}
