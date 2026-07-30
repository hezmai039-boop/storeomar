import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import "./LoginPage.css";

type State = "working" | "done" | "failed" | "missing";

/**
 * Redeems the email-verification token from the signup email (?token=...).
 *
 * Public on purpose: the link is often opened in a different browser (phone
 * mail app) from the one holding the session, so requiring auth here would
 * strand people on a login screen holding a single-use token.
 */
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<State>(token ? "working" : "missing");
  const [message, setMessage] = useState<string | null>(null);

  // Verification tokens are single-use, and React 18's StrictMode mounts
  // effects twice in development. Without this guard the second run redeems
  // an already-consumed token and shows a failure on a verification that
  // actually succeeded.
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    api
      .post("/v1/auth/verify-email", { token })
      .then(() => setState("done"))
      .catch((err) => {
        setState("failed");
        setMessage(
          err instanceof ApiClientError ? err.message : "تعذّر تأكيد البريد — قد يكون الرابط منتهيًا أو مستخدمًا"
        );
      });
  }, [token]);

  const body = {
    missing: {
      title: "رابط غير صالح",
      sub: "هذا الرابط لا يحتوي على رمز تأكيد.",
    },
    working: {
      title: "جارٍ تأكيد بريدك…",
      sub: "لحظة من فضلك",
    },
    done: {
      title: "تم تأكيد بريدك ✓",
      sub: "يمكنك الآن ربط قنوات التواصل الحقيقية بمتجرك.",
    },
    failed: {
      title: "تعذّر التأكيد",
      sub: message ?? "الرابط غير صالح.",
    },
  }[state];

  return (
    <div dir="rtl" lang="ar" className="login-page">
      <span className="login-blob b1" />
      <span className="login-blob b2" />

      <div className="login-card atlas-enter">
        <div className="login-mark">A</div>
        <div>
          <div className="login-title">{body.title}</div>
          <div className="login-sub">{body.sub}</div>
        </div>

        {state !== "working" && (
          <Link className="btn btn-primary login-submit" to="/overview" style={{ textAlign: "center" }}>
            الذهاب إلى لوحة التحكم
          </Link>
        )}

        {state === "failed" && (
          <div className="login-footer">
            سجّل الدخول ثم اطلب رابطًا جديدًا من صفحة <Link to="/account">حسابي</Link>
          </div>
        )}
      </div>
    </div>
  );
}
