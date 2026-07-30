import { FormEvent, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import { LogoLockup } from "../components/Logo";
import "./LoginPage.css";

/**
 * Consumes a password-reset token from the emailed link (?token=...).
 *
 * Deliberately does NOT log the user in on success — it sends them to the
 * login screen to sign in with the new password. Whoever clicks the link
 * has only proven they can read that inbox; making the link itself grant a
 * session would turn a forwarded or cached email into an account takeover.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError("كلمتا المرور غير متطابقتين");
      return;
    }
    if (password.length < 8) {
      setError("كلمة المرور 8 أحرف على الأقل");
      return;
    }

    setSubmitting(true);
    try {
      await api.post("/v1/auth/reset-password", { token, newPassword: password });
      setDone(true);
      setTimeout(() => navigate("/login"), 2500);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "تعذّر تعيين كلمة المرور — قد يكون الرابط منتهيًا أو مستخدمًا من قبل"
      );
    } finally {
      setSubmitting(false);
    }
  }

  // A missing token means the user landed here directly rather than from the
  // email. Say so plainly instead of showing a form that can only ever fail.
  if (!token) {
    return (
      <div dir="rtl" lang="ar" className="login-page">
        <div className="login-card ms-enter">
          <div className="login-brand">
            <LogoLockup size={38} tone="light" />
          </div>
          <div className="login-title">رابط غير صالح</div>
          <div className="login-sub">هذا الرابط لا يحتوي على رمز إعادة تعيين.</div>
          <Link className="btn btn-primary login-submit" to="/forgot-password" style={{ textAlign: "center" }}>
            طلب رابط جديد
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div dir="rtl" lang="ar" className="login-page">
      <span className="login-blob b1" />
      <span className="login-blob b2" />
      <span className="login-blob b3" />

      <form onSubmit={onSubmit} className="login-card ms-enter">
        <div className="login-brand">
          <LogoLockup size={38} tone="light" />
        </div>
        <div>
          <div className="login-title">تعيين كلمة مرور جديدة</div>
          <div className="login-sub">اختر كلمة مرور قوية لا تستخدمها في مكان آخر</div>
        </div>

        {done ? (
          <div className="login-note">تم تعيين كلمة المرور بنجاح. سيتم تحويلك لتسجيل الدخول…</div>
        ) : (
          <>
            <label className="login-field">
              كلمة المرور الجديدة
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </label>

            <label className="login-field">
              تأكيد كلمة المرور
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </label>

            {error && <div className="login-error">{error}</div>}

            <button className="btn btn-primary login-submit" type="submit" disabled={submitting}>
              {submitting ? "جارٍ الحفظ…" : "حفظ كلمة المرور"}
            </button>
          </>
        )}

        <div className="login-footer">
          <Link to="/login">العودة لتسجيل الدخول</Link>
        </div>
      </form>
    </div>
  );
}
