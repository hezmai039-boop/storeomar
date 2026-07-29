import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiClientError, setAuthToken } from "../api/client";
import { useAuth } from "../context/AuthContext";
import "./LoginPage.css";

interface SignupResponse {
  data: {
    token: string;
    user: { id: string; name: string; email: string };
    organization: { id: string; name: string; slug: string };
    store: { id: string; name: string; slug: string };
  };
}

/**
 * Public self-serve signup — the endpoint that turns Atlas from something we
 * provision by hand into a platform anyone can join.
 *
 * The backend does all of it in one transaction (organization, store, owner
 * login, AI agent, free subscription) and hands back a JWT, so this page
 * stores that token and goes straight to the dashboard. Deliberately NOT a
 * "check your email to continue" wall: verification matters for connecting a
 * real channel, not for looking around, and an email gate at this exact step
 * is where signup funnels lose people.
 */
export function SignupPage() {
  const { refreshMe } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    organizationName: "",
    storeName: "",
    name: "",
    email: "",
    password: "",
    confirm: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Checked here as well as server-side purely so the user finds out before
    // a round-trip; the server remains the real validator.
    if (form.password !== form.confirm) {
      setError("كلمتا المرور غير متطابقتين");
      return;
    }
    if (form.password.length < 8) {
      setError("كلمة المرور 8 أحرف على الأقل");
      return;
    }

    setSubmitting(true);
    try {
      const resp = await api.post<SignupResponse>("/v1/auth/signup", {
        organizationName: form.organizationName.trim(),
        storeName: form.storeName.trim(),
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      setAuthToken(resp.data.token);
      // Populate the auth context from /me rather than trusting the signup
      // payload — /me is what every other screen reads, so loading it here
      // means the dashboard never renders against a half-filled user.
      await refreshMe();
      navigate("/overview");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "تعذّر إنشاء الحساب، حاول مجددًا");
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
          <div className="login-title">إنشاء حساب جديد</div>
          <div className="login-sub">ابدأ مجانًا — بلا بطاقة ائتمانية</div>
        </div>

        <label className="login-field">
          اسم المنشأة
          <input
            value={form.organizationName}
            onChange={(e) => set("organizationName", e.target.value)}
            placeholder="مثال: مؤسسة الغذاء الطازج"
            required
            maxLength={200}
          />
        </label>

        <label className="login-field">
          اسم المتجر
          <input
            value={form.storeName}
            onChange={(e) => set("storeName", e.target.value)}
            placeholder="مثال: متجر الغذاء"
            required
            maxLength={200}
          />
        </label>

        <label className="login-field">
          اسمك
          <input value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={120} />
        </label>

        <label className="login-field">
          البريد الإلكتروني
          <input type="email" dir="ltr" value={form.email} onChange={(e) => set("email", e.target.value)} required />
        </label>

        <label className="login-field">
          كلمة المرور
          <input
            type="password"
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>

        <label className="login-field">
          تأكيد كلمة المرور
          <input
            type="password"
            value={form.confirm}
            onChange={(e) => set("confirm", e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>

        {error && <div className="login-error">{error}</div>}

        <button className="btn btn-primary login-submit" type="submit" disabled={submitting}>
          {submitting ? "جارٍ الإنشاء…" : "إنشاء الحساب"}
        </button>

        <div className="login-footer" style={{ display: "grid", gap: 8 }}>
          <div>
            لديك حساب؟ <Link to="/login">تسجيل الدخول</Link>
          </div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            بإنشائك حسابًا فأنت توافق على <Link to="/terms">الشروط</Link> و
            <Link to="/privacy"> سياسة الخصوصية</Link>
          </div>
        </div>
      </form>
    </div>
  );
}
