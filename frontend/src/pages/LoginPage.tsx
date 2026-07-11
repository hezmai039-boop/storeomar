import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

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
    <div
      dir="rtl"
      lang="ar"
      style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}
    >
      <form
        onSubmit={onSubmit}
        className="card"
        style={{ width: 360, padding: 32, display: "flex", flexDirection: "column", gap: 16 }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: 20 }}>Atlas</div>
          <div style={{ color: "var(--text-dim)", fontSize: 13 }}>تسجيل الدخول إلى منصة إدارة المتاجر</div>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
          البريد الإلكتروني
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
          كلمة المرور
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div style={{ color: "var(--critical)", fontSize: 13 }}>{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? "جارٍ الدخول…" : "دخول"}
        </button>
      </form>
    </div>
  );
}
