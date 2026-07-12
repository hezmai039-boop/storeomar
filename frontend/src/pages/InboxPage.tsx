import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Conversation, Message } from "../api/types";
import { useStore } from "../context/StoreContext";
import { BrandTile } from "../components/BrandIcons";

export function InboxPage() {
  const { activeStore } = useStore();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!activeStore) return;
    setSelectedId(null);
    setMessages([]);
    api
      .get<{ data: Conversation[] }>(`/v1/stores/${activeStore.id}/conversations`)
      .then((resp) => {
        setConversations(resp.data);
        if (resp.data.length > 0) setSelectedId(resp.data[0].id);
      });
  }, [activeStore]);

  useEffect(() => {
    if (!activeStore || !selectedId) return;
    setSummary(null);
    api
      .get<{ data: Message[] }>(`/v1/stores/${activeStore.id}/conversations/${selectedId}/messages`)
      .then((resp) => setMessages(resp.data));
  }, [activeStore, selectedId]);

  if (!activeStore) return <div style={{ color: "var(--text-dim)" }}>اختر متجرًا من القائمة الجانبية أولًا.</div>;

  const selected = conversations.find((c) => c.id === selectedId);

  async function sendReply() {
    if (!draft.trim() || !selectedId || !activeStore) return;
    setSending(true);
    try {
      const idemKey = crypto.randomUUID();
      const resp = await api.post<{ data: Message }>(
        `/v1/stores/${activeStore.id}/conversations/${selectedId}/messages`,
        { text: draft },
        { "Idempotency-Key": idemKey }
      );
      setMessages((prev) => [...prev, resp.data]);
      setDraft("");
    } catch (err) {
      alert(err instanceof Error ? err.message : "تعذّر إرسال الرد");
    } finally {
      setSending(false);
    }
  }

  async function summarize() {
    if (!selectedId || !activeStore) return;
    const resp = await api.post<{ data: { summary: string } }>(
      `/v1/stores/${activeStore.id}/conversations/${selectedId}/summarize`
    );
    setSummary(resp.data.summary);
  }

  async function escalate() {
    if (!selected || !activeStore) return;
    await api.post(`/v1/stores/${activeStore.id}/tickets`, {
      conversationId: selected.id,
      customerId: selected.customer.id,
      priority: "medium",
    });
    alert("تم إنشاء تذكرة من هذه المحادثة.");
  }

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>صندوق الوارد الموحد</h1>
        <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>{activeStore.name}</p>
      </div>

      <div
        className="card card-glass atlas-enter"
        style={{ display: "grid", gridTemplateColumns: "300px 1fr", height: 620, overflow: "hidden" }}
      >
        <div style={{ borderInlineStart: "1px solid var(--border)", overflowY: "auto", minHeight: 0 }}>
          {conversations.length === 0 && (
            <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 13 }}>لا توجد محادثات بعد.</div>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              style={{
                display: "flex",
                gap: 10,
                padding: "12px 14px",
                borderBottom: "1px solid var(--border)",
                borderInlineStart: c.id === selectedId ? "3px solid var(--primary)" : "3px solid transparent",
                cursor: "pointer",
                background: c.id === selectedId ? "var(--primary-tint)" : undefined,
                transition: "background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)",
              }}
            >
              <BrandTile brand={c.channelAccount.channelType.key} sizePx={26} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{c.customer.name ?? c.customer.externalId}</div>
                <div style={{ marginTop: 4 }}>
                  {c.aiConfidenceLevel && (
                    <span
                      className={`badge ${
                        c.aiConfidenceLevel === "high"
                          ? "badge-good"
                          : c.aiConfidenceLevel === "medium"
                          ? "badge-warn"
                          : "badge-critical"
                      }`}
                    >
                      {c.aiConfidenceLevel === "high" ? "ثقة عالية" : c.aiConfidenceLevel === "medium" ? "ثقة متوسطة" : "تحويل لموظف"}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {selected ? (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "14px 18px",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div>
                  <b style={{ fontSize: 14 }}>{selected.customer.name ?? selected.customer.externalId}</b>
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{selected.channelAccount.channelType.name}</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={summarize}>
                    ↪ تلخيص المحادثة
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={escalate}>
                    تحويل كتذكرة
                  </button>
                </div>
              </div>

              <div style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
                {summary && (
                  <div className="badge badge-info" style={{ alignSelf: "flex-start", padding: "8px 12px" }}>
                    {summary}
                  </div>
                )}
                {messages.map((m, i) => (
                  <div
                    key={m.id}
                    className="atlas-enter"
                    style={{
                      maxWidth: "62%",
                      alignSelf: m.senderType === "customer" ? "flex-end" : "flex-start",
                      background: m.senderType === "ai" ? "var(--primary-gradient)" : "var(--surface-2)",
                      color: m.senderType === "ai" ? "#fff" : "var(--text)",
                      border: m.senderType === "ai" ? "none" : "1px solid var(--border)",
                      borderRadius: 12,
                      padding: "10px 14px",
                      fontSize: 13,
                      boxShadow: m.senderType === "ai" ? "0 6px 18px var(--primary-glow)" : "none",
                      animationDelay: `${Math.min(i, 8) * 30}ms`,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        marginBottom: 3,
                        color: m.senderType === "ai" ? "rgba(255,255,255,0.85)" : "var(--text-dim)",
                      }}
                    >
                      {m.senderType === "customer" ? "العميل" : m.senderType === "ai" ? "🤖 الوكيل الذكي" : m.senderType === "agent" ? "أنت" : "النظام"}
                    </div>
                    {m.content}
                  </div>
                ))}
              </div>

              <div style={{ borderTop: "1px solid var(--border)", padding: "12px 16px" }}>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={`اكتب ردًا لـ ${selected.customer.name ?? "العميل"}…`}
                  style={{ width: "100%", minHeight: 56, resize: "none" }}
                />
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn-primary btn-sm" onClick={sendReply} disabled={sending || !draft.trim()}>
                    {sending ? "جارٍ الإرسال…" : "إرسال الرد"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div style={{ padding: 20, color: "var(--text-dim)" }}>اختر محادثة من القائمة.</div>
          )}
        </div>
      </div>
    </div>
  );
}
