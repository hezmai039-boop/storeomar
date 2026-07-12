import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./LoginPage.css";

export function LoginPage() {
  const { login, error } = useAuth();
  const [email, setEmail] = useState("hezmai039@gmail.com");
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

      <form onSubmit={onSubmit} className="login-card atlas-enter">
        <div className="login-mark">A</div>
        <div>
          <div className="login-title">Atlas</div>
          <div className="login-sub">تسجيل الدخول إلى منصة إدارة المتاجر</div>
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

        <div className="login-footer">Atlas · منصة إدارة خدمة العملاء متعددة المتاجر</div>
      </form>
    </div>
  );
}
