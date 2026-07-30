import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { usePublicConfig } from "../lib/publicConfig";
import { LogoLockup } from "../components/Logo";
import "./LoginPage.css";

export function LoginPage() {
  const { login, error } = useAuth();
  const { signupEnabled } = usePublicConfig();
  // Was prefilled with the platform owner's address as a dev convenience.
  // Harmless while the only way in was an account we created by hand —
  // but signup is public now, so that prefill hands the owner's email to
  // every visitor and pre-seeds the field brute-force attempts start from.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/overview");
    } catch {
      // error already surfaced via useAuth().error
    } finally {
      setSubmitting(false);
    }
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
          <div className="login-title">تسجيل الدخول</div>
          <div className="login-sub">إلى منصة ميسور لإدارة متاجرك وخدمة عملائها</div>
        </div>

        <label className="login-field">
          البريد الإلكتروني
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="login-field">
          كلمة المرور
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>

        {error && <div className="login-error">{error}</div>}

        <button className="btn btn-primary login-submit" type="submit" disabled={submitting}>
          {submitting ? "جارٍ الدخول…" : "دخول"}
        </button>

        <div className="login-footer" style={{ display: "grid", gap: 10 }}>
          <div>
            <Link to="/forgot-password">نسيت كلمة المرور؟</Link>
          </div>
          {signupEnabled && (
            <div>
              ليس لديك حساب؟ <Link to="/signup">إنشاء حساب جديد</Link>
            </div>
          )}
          <div style={{ opacity: 0.75 }}>ميسور · منصة إدارة خدمة العملاء متعددة المتاجر</div>
        </div>
      </form>
    </div>
  );
}
