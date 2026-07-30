import { FormEvent, useEffect, useRef, useState } from "react";
import { api, ApiClientError } from "../api/client";
import type { PublicPlan } from "../api/types";

/**
 * The intake form behind every "اطلب الباقة" button on the landing page.
 *
 * Self-serve signup is closed (SIGNUP_ENABLED unset), so this is the only
 * path from a stranger to the platform: they pick a plan, leave contact
 * details, the owner arranges payment out of band and activates the plan
 * from /billing. It creates nothing but a lead — no account exists after
 * submitting, which is why the success copy promises a phone call rather
 * than a login.
 */
export function PlanRequestDialog({ plan, onClose }: { plan: PublicPlan | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", storeName: "", note: "", website: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // showModal(), not the `open` attribute: only the modal form puts the
  // dialog in the top layer and makes the rest of the page inert. Setting
  // `open` renders a non-modal dialog that the page can still scroll and
  // tab behind.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (plan && !el.open) {
      setForm({ name: "", email: "", phone: "", storeName: "", note: "", website: "" });
      setError(null);
      setSent(false);
      el.showModal();
    }
    if (!plan && el.open) el.close();
  }, [plan]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/public/plan-requests", {
        planKey: plan.key,
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        ...(form.storeName.trim() ? { storeName: form.storeName.trim() } : {}),
        ...(form.note.trim() ? { note: form.note.trim() } : {}),
        ...(form.website ? { website: form.website } : {}),
      });
      setSent(true);
    } catch (err) {
      // The backend now answers validation failures with the Arabic message
      // from the schema itself, so this shows the real reason ("رقم الجوال
      // غير صحيح") instead of a generic one.
      setError(err instanceof ApiClientError ? err.message : "تعذّر إرسال الطلب، حاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  }

  return (
    // onClose fires for Esc and for the backdrop-driven close too, so the
    // parent's state can never drift out of sync with the element's.
    <dialog ref={ref} className="lp-dialog" onClose={onClose} aria-labelledby="lp-req-title">
      <div className="lp-dialog-body">
        {sent ? (
          <>
            <h3 id="lp-req-title">وصلنا طلبك ✦</h3>
            <p className="ok">
              شكرًا لك. سنتواصل معك على الجوال أو البريد الذي أدخلته للاتفاق على طريقة الدفع وتفعيل حسابك — عادةً خلال
              ساعات العمل.
            </p>
            <div className="lp-dialog-actions">
              <button type="button" className="lp-btn lp-btn-primary lp-btn-sm" onClick={() => ref.current?.close()}>
                إغلاق
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
            <h3 id="lp-req-title">طلب باقة {plan?.name ?? ""}</h3>
            <p className="hint">اترك بياناتك ونتواصل معك للاتفاق على الدفع وتفعيل حسابك. لن يُخصم منك أي مبلغ الآن.</p>

            <label className="lp-field">
              الاسم
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                required
                autoComplete="name"
                maxLength={120}
              />
            </label>
            <label className="lp-field">
              البريد الإلكتروني
              <input
                type="email"
                dir="ltr"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                required
                autoComplete="email"
                maxLength={200}
              />
            </label>
            <label className="lp-field">
              رقم الجوال
              <input
                type="tel"
                dir="ltr"
                inputMode="tel"
                placeholder="05xxxxxxxx"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                required
                autoComplete="tel"
                maxLength={30}
              />
            </label>
            <label className="lp-field">
              اسم المتجر (اختياري)
              <input
                value={form.storeName}
                onChange={(e) => setForm((f) => ({ ...f, storeName: e.target.value }))}
                maxLength={200}
              />
            </label>
            <label className="lp-field">
              ملاحظة (اختياري)
              <textarea
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                maxLength={2000}
              />
            </label>

            {/* Honeypot — see .lp-hp in LandingPage.css. aria-hidden and
                tabIndex={-1} keep it away from people; autoComplete="off"
                keeps the browser from helpfully filling it. */}
            <div className="lp-hp" aria-hidden="true">
              <label>
                لا تملأ هذا الحقل
                <input
                  tabIndex={-1}
                  autoComplete="off"
                  value={form.website}
                  onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
                />
              </label>
            </div>

            {error && <p className="err">{error}</p>}

            <div className="lp-dialog-actions">
              <button type="submit" className="lp-btn lp-btn-primary lp-btn-sm" disabled={busy}>
                {busy ? "جارٍ الإرسال…" : "إرسال الطلب"}
              </button>
              <button type="button" className="lp-btn lp-btn-ghost lp-btn-sm" onClick={() => ref.current?.close()}>
                إلغاء
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
