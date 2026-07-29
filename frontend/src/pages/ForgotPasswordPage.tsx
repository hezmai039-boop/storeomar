import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import "./LoginPage.css";

/**
 * Password reset request.
 *
 * The backend answers 200 with an identical body whether or not the address
 * exists — otherwise the endpoint becomes an account-existence oracle. This
 * page must not undo that: the success message is shown for ANY accepted
 * submission and deliberately says "if an account exists", never "we sent
 * you an email". Wording that confirms delivery would leak exactly what the
 * uniform response was protecting.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/auth/forgot-password", { email: email.trim() });
      setSent(true);
    } catch {
      // A failure here is a transport/rate-limit problem, not "no such
      // account" — the endpoint does not distinguish, and neither do we.
      setError("تعذّر إرسال الطلب، حاول بعد قليل");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div dir="rtl" lang="ar" className="login-page">
      <span className="login-blob b1" />
      <span className="login-blob b2" />
      <span className="login-blob b3" />

      <form onSubmit={onSubmit} className="login-card atlas-enter">
        <div className="login-mark">A</div>
        <div>
          <div className="login-title">استعادة كلمة المرور</div>
          <div className="login-sub">سنرسل لك رابط إعادة تعيين</div>
        </div>

        {sent ? (
          <>
            <div
              style={{
                background: "var(--surface-2, #f4f6f8)",
                borderRadius: 8,
                padding: 14,
                fontSize: 14,
                lineHeight: 1.7,
              }}
            >
              إذا كان هناك حساب مرتبط بهذا البريد، فقد أُرسل إليه رابط لإعادة تعيين كلمة المرور. الرابط صالح لمدة ساعة
              واحدة.
              <div style={{ marginTop: 8, opacity: 0.75, fontSize: 13 }}>
                تحقق من مجلد البريد غير المرغوب فيه إن لم تجده.
              </div>
            </div>
            <Link className="btn btn-primary login-submit" to="/login" style={{ textAlign: "center" }}>
              العودة لتسجيل الدخول
            </Link>
          </>
        ) : (
          <>
            <label className="login-field">
              البريد الإلكتروني
              <input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>

            {error && <div className="login-error">{error}</div>}

            <button className="btn btn-primary login-submit" type="submit" disabled={submitting}>
              {submitting ? "جارٍ الإرسال…" : "إرسال رابط الاستعادة"}
            </button>

            <div className="login-footer">
              <Link to="/login">العودة لتسجيل الدخول</Link>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
