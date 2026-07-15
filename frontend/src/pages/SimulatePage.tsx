import { FormEvent, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import "./SimulatePage.css";

interface ChatMessage {
  senderType: "customer" | "ai" | "agent" | "system";
  content: string;
  createdAt: string;
}

function visitorKey(token: string) {
  return `atlas_sim_visitor_${token}`;
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" });
}

export function SimulatePage() {
  const { token } = useParams<{ token: string }>();
  const [linkInfo, setLinkInfo] = useState<{ storeName: string; label: string } | null>(null);
  // "invalid" (404 — the link genuinely doesn't exist/was disabled) is a
  // dead end. "retryable" (rate-limited, cold-start network hiccup, 5xx)
  // is temporary and gets a "try again" button instead — collapsing both
  // into one permanent "invalid link" screen (the old behavior) misled a
  // tester into thinking a perfectly valid link was broken when the real
  // cause was e.g. the shared token rate limit or the backend waking up.
  const [loadState, setLoadState] = useState<"loading" | "ready" | "invalid" | "retryable">("loading");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Resolve the link once, and restore any prior history for this
  // browser's visitorId (if this token was already chatted with before).
  useEffect(() => {
    if (!token) return;
    setLoadState("loading");
    api
      .get<{ data: { storeName: string; label: string } }>(`/v1/public/simulate/${token}`)
      .then((resp) => {
        setLinkInfo(resp.data);
        setLoadState("ready");
        const visitorId = localStorage.getItem(visitorKey(token));
        if (visitorId) {
          api
            .get<{ data: ChatMessage[] }>(`/v1/public/simulate/${token}/messages?visitorId=${visitorId}`)
            .then((historyResp) => setMessages(historyResp.data))
            .catch(() => {});
        }
      })
      .catch((err) => setLoadState(err instanceof ApiClientError && err.status === 404 ? "invalid" : "retryable"));
  }, [token]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  if (loadState === "invalid") {
    return (
      <div className="sim-invalid">
        <div style={{ fontSize: 40 }}>⚠</div>
        <b>هذا الرابط غير صالح أو تم تعطيله</b>
        <span style={{ opacity: 0.8, fontSize: 13 }}>تواصل مع صاحب المتجر للحصول على رابط محاكاة جديد.</span>
      </div>
    );
  }

  if (loadState === "retryable") {
    return (
      <div className="sim-invalid">
        <div style={{ fontSize: 40 }}>⏳</div>
        <b>تعذّر الاتصال مؤقتًا</b>
        <span style={{ opacity: 0.8, fontSize: 13 }}>قد يكون الخادم مشغولًا أو بدأ للتو — حاول مجددًا خلال لحظات.</span>
        <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => location.reload()}>
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (loadState === "loading") {
    return <div className="sim-invalid" style={{ opacity: 0.7 }}>جارٍ التحميل…</div>;
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!token || !draft.trim() || sending) return;
    const text = draft.trim();
    setDraft("");
    setMessages((prev) => [...prev, { senderType: "customer", content: text, createdAt: new Date().toISOString() }]);
    setSending(true);
    try {
      const visitorId = localStorage.getItem(visitorKey(token)) ?? undefined;
      const resp = await api.post<{
        data: { visitorId: string; replyText: string | null; escalated: boolean };
      }>(`/v1/public/simulate/${token}/messages`, { visitorId, text });
      localStorage.setItem(visitorKey(token), resp.data.visitorId);

      if (resp.data.replyText) {
        setMessages((prev) => [
          ...prev,
          { senderType: "ai", content: resp.data.replyText as string, createdAt: new Date().toISOString() },
        ]);
      }
      if (resp.data.escalated) {
        setMessages((prev) => [
          ...prev,
          {
            senderType: "system",
            content: "⚠ تم تحويل هذه المحادثة لموظف بشري — الثقة في الإجابة الآلية كانت منخفضة.",
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          senderType: "system",
          content: err instanceof ApiClientError ? err.message : "تعذّر إرسال الرسالة، حاول مجددًا.",
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="sim-page" dir="rtl" lang="ar">
      <header className="sim-header">
        <div className="sim-avatar">{(linkInfo?.storeName ?? "؟").slice(0, 1)}</div>
        <div className="sim-header-text">
          <b>{linkInfo?.storeName ?? "جارٍ التحميل…"}</b>
          {linkInfo && <span className="sim-online">متصل الآن</span>}
        </div>
      </header>

      <div className="sim-banner">هذه بيئة اختبار داخلية لصاحب المتجر — الردود من الذكاء الاصطناعي الحقيقي لأطلس.</div>

      <div className="sim-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", color: "#667781", fontSize: 13, marginTop: 24 }}>
            اكتب رسالتك الأولى كأنك عميل — مثلاً: "وين طلبي؟" أو "عندكم توصيل لجدة؟"
          </div>
        )}
        {messages.map((m, i) => {
          if (m.senderType === "system") {
            return (
              <div key={i} className="sim-bubble-row in">
                <div className="sim-bubble escalate">{m.content}</div>
              </div>
            );
          }
          const isOut = m.senderType === "customer";
          // "Read" the moment any later message exists — a reply is proof
          // the customer's message was seen, same signal real WhatsApp's
          // blue double-check communicates.
          const isRead = isOut && i < messages.length - 1;
          return (
            <div key={i} className={`sim-bubble-row ${isOut ? "out" : "in"}`}>
              <div className={`sim-bubble ${isOut ? "out" : "in"}`}>
                {m.content}
                <span className="sim-time">
                  {timeLabel(m.createdAt)}
                  {isOut && <span className={`sim-ticks ${isRead ? "read" : ""}`}>{isRead ? "✓✓" : "✓"}</span>}
                </span>
              </div>
            </div>
          );
        })}
        {sending && <div className="sim-typing">يكتب الآن…</div>}
      </div>

      <form className="sim-composer" onSubmit={send}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="اكتب رسالة…"
          disabled={sending || !linkInfo}
          autoFocus
        />
        <button type="submit" disabled={sending || !draft.trim() || !linkInfo} aria-label="إرسال">
          ➤
        </button>
      </form>
    </div>
  );
}
