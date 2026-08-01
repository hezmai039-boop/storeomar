import { Fragment, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiClientError } from "../api/client";
import type { KnowledgeEntry, KnowledgeSource, KnowledgeSuggestion, KnowledgeTemplate } from "../api/types";
import { useStore } from "../context/StoreContext";
import { usePermissions, PERMISSIONS } from "../lib/permissions";

const FILE_TYPES = new Set(["pdf", "word", "excel"]);
const SOURCE_TYPE_LABELS: Record<string, string> = {
  pdf: "ملف PDF",
  word: "ملف Word",
  excel: "ملف Excel",
  faq: "أسئلة شائعة",
  webpage: "صفحة موقع",
  product: "صفحة منتج",
  shipping_policy: "سياسة الشحن",
  return_policy: "سياسة الاسترجاع",
};

/**
 * Chunks are stored as "س: <question>\nج: <answer>" — the shape the retriever
 * scores and the shape the learning loop writes. Splitting on the FIRST
 * newline (not every newline) is what keeps a multi-line answer intact; the
 * prefixes are stripped for display because they are storage syntax, not
 * something a merchant should have to read around.
 */
function parseEntry(content: string): { question: string; answer: string } {
  const breakAt = content.indexOf("\n");
  if (breakAt === -1) return { question: "", answer: content };
  return {
    question: content.slice(0, breakAt).replace(/^س:\s*/, ""),
    answer: content.slice(breakAt + 1).replace(/^ج:\s*/, ""),
  };
}

export function KnowledgePage() {
  const { activeStore } = useStore();
  const { can } = usePermissions();
  // Agents may VIEW knowledge but not add sources or approve/reject
  // suggestions (backend gates those with knowledge.manage / knowledge.approve).
  const canManage = can(PERMISSIONS.KNOWLEDGE_MANAGE);
  const canApprove = can(PERMISSIONS.KNOWLEDGE_APPROVE);
  const [tab, setTab] = useState<"pending" | "active">("pending");
  const [suggestions, setSuggestions] = useState<KnowledgeSuggestion[]>([]);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [sourceType, setSourceType] = useState("faq");
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [templates, setTemplates] = useState<KnowledgeTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);

  // Which source's entries are open, and that source's entries. Only one
  // source expands at a time: two open lists of near-identical Q&A side by
  // side is how a merchant edits the wrong one.
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [newQuestion, setNewQuestion] = useState("");
  const [newAnswer, setNewAnswer] = useState("");
  const [entryError, setEntryError] = useState<string | null>(null);
  const [savingEntry, setSavingEntry] = useState(false);

  const reload = useCallback(() => {
    if (!activeStore) return;
    api
      .get<{ data: KnowledgeSuggestion[] }>(`/v1/stores/${activeStore.id}/knowledge/suggestions?status=pending_review`)
      .then((resp) => setSuggestions(resp.data));
    api
      .get<{ data: KnowledgeSource[] }>(`/v1/stores/${activeStore.id}/knowledge/sources?status=active`)
      .then((resp) => setSources(resp.data));
  }, [activeStore]);

  useEffect(() => reload(), [reload]);

  useEffect(() => {
    if (!activeStore) return;
    api
      .get<{ data: KnowledgeTemplate[] }>(`/v1/stores/${activeStore.id}/knowledge/templates`)
      .then((resp) => setTemplates(resp.data))
      .catch(() => setTemplates([]));
  }, [activeStore]);

  if (!activeStore) return <div style={{ color: "var(--text-dim)" }}>اختر متجرًا من القائمة الجانبية أولًا.</div>;

  const storeId = activeStore.id;

  async function decide(id: string, action: "approve" | "reject") {
    await api.post(`/v1/stores/${storeId}/knowledge/suggestions/${id}/${action}`);
    reload();
  }

  async function deleteSource(id: string, sourceTitle: string) {
    if (!window.confirm(`حذف "${sourceTitle}"؟ سيتوقف الذكاء الاصطناعي عن استخدام هذا المحتوى فورًا.`)) return;
    await api.delete(`/v1/stores/${storeId}/knowledge/sources/${id}`);
    if (openSourceId === id) setOpenSourceId(null);
    reload();
  }

  async function applyTemplate(key: string, name: string) {
    setTemplateError(null);
    setApplying(key);
    try {
      await api.post(`/v1/stores/${storeId}/knowledge/templates/${key}/apply`);
      setShowTemplates(false);
      setTab("active");
      reload();
    } catch (err) {
      setTemplateError(err instanceof ApiClientError ? err.message : `تعذّر تطبيق قالب ${name}`);
    } finally {
      setApplying(null);
    }
  }

  async function toggleEntries(id: string) {
    if (openSourceId === id) {
      setOpenSourceId(null);
      return;
    }
    setOpenSourceId(id);
    setEntries([]);
    setEntryError(null);
    setNewQuestion("");
    setNewAnswer("");
    setEntriesLoading(true);
    try {
      const resp = await api.get<{ data: KnowledgeEntry[] }>(`/v1/stores/${storeId}/knowledge/sources/${id}/entries`);
      setEntries(resp.data);
    } catch {
      setEntryError("تعذّر تحميل الأسئلة");
    } finally {
      setEntriesLoading(false);
    }
  }

  async function addEntry(e: FormEvent) {
    e.preventDefault();
    if (!openSourceId) return;
    setEntryError(null);
    setSavingEntry(true);
    try {
      const resp = await api.post<{ data: KnowledgeEntry }>(
        `/v1/stores/${storeId}/knowledge/sources/${openSourceId}/entries`,
        { question: newQuestion, answer: newAnswer }
      );
      setEntries((prev) => [...prev, resp.data]);
      setNewQuestion("");
      setNewAnswer("");
      // The row's chunk count is now stale — bump it locally rather than
      // refetching the whole page, so adding ten questions in a row stays
      // ten keystroke-speed interactions instead of ten round trips.
      setSources((prev) =>
        prev.map((s) => (s.id === openSourceId ? { ...s, _count: { chunks: (s._count?.chunks ?? 0) + 1 } } : s))
      );
    } catch (err) {
      setEntryError(err instanceof ApiClientError ? err.message : "تعذّرت إضافة السؤال");
    } finally {
      setSavingEntry(false);
    }
  }

  async function deleteEntry(chunkId: string) {
    if (!openSourceId) return;
    if (!window.confirm("حذف هذا السؤال؟ سيتوقف الذكاء الاصطناعي عن الإجابة به فورًا.")) return;
    await api.delete(`/v1/stores/${storeId}/knowledge/sources/${openSourceId}/entries/${chunkId}`);
    setEntries((prev) => prev.filter((entry) => entry.id !== chunkId));
    setSources((prev) =>
      prev.map((s) => (s.id === openSourceId ? { ...s, _count: { chunks: Math.max(0, (s._count?.chunks ?? 1) - 1) } } : s))
    );
  }

  const isFileType = FILE_TYPES.has(sourceType);

  async function submitSource(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      if (isFileType) {
        const file = fileInputRef.current?.files?.[0];
        if (!file) throw new Error("أرفق ملفًا أولًا");
        const form = new FormData();
        form.set("type", sourceType);
        form.set("title", title);
        form.set("file", file);
        await api.postForm(`/v1/stores/${storeId}/knowledge/sources`, form);
      } else {
        await api.post(`/v1/stores/${storeId}/knowledge/sources`, { type: sourceType, title, rawText });
      }
      setTitle("");
      setRawText("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setShowAddForm(false);
      setTab("active");
      reload();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "تعذّرت إضافة المصدر");
    } finally {
      setSubmitting(false);
    }
  }

  const templatePicker = (
    <div className="card" style={{ padding: 20, marginBottom: 22 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>ابدأ بقالب جاهز</div>
      <p style={{ margin: "0 0 14px", color: "var(--text-dim)", fontSize: 12.5, lineHeight: 1.7 }}>
        القالب يعطيك أسئلة قطاعك الشائعة بإجابات مكتوبة مسبقًا. الأرقام فيه بين أقواس <code>[ ]</code> —
        عدّلها لتطابق متجرك قبل توجيه عميل حقيقي، فالذكاء الاصطناعي سيقولها كما هي.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        {templates.map((t) => (
          <div
            key={t.key}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 2 }}>{t.entryCount} سؤالًا وجوابًا</div>
            </div>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => applyTemplate(t.key, t.name)}
              disabled={applying !== null}
            >
              {applying === t.key ? "جارٍ التطبيق…" : "استخدم هذا القالب"}
            </button>
          </div>
        ))}
      </div>
      {templateError && <div style={{ color: "var(--critical)", fontSize: 13, marginTop: 12 }}>{templateError}</div>}
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22, gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>قاعدة المعرفة</h1>
          <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>
            {activeStore.name} — لا تحديث تلقائي؛ كل إضافة تمر بموافقتك
          </p>
        </div>
        {canManage && (
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            {templates.length > 0 && (
              <button className="btn btn-sm" onClick={() => setShowTemplates((v) => !v)}>
                {showTemplates ? "إغلاق القوالب" : "ابدأ بقالب"}
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => setShowAddForm((v) => !v)}>
              {showAddForm ? "إغلاق" : "+ إضافة مصدر معرفة"}
            </button>
          </div>
        )}
      </div>

      {/* The cold-start case gets the picker unprompted. A merchant staring at
          an empty knowledge base does not know that empty means "escalate
          every question to a human" — so the screen has to say it, at the
          moment it is true, rather than wait to be asked. */}
      {canManage && sources.length === 0 && templates.length > 0 && !showTemplates && (
        <div className="card" style={{ padding: 18, marginBottom: 22, borderInlineStart: "3px solid var(--accent)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>قاعدة المعرفة فارغة</div>
          <p style={{ margin: "0 0 12px", color: "var(--text-dim)", fontSize: 12.5, lineHeight: 1.7 }}>
            ما دامت فارغة، سيحوّل الذكاء الاصطناعي <strong>كل</strong> سؤال إلى موظف بدل أن يجيب عليه.
            ابدأ بقالب قطاعك ثم عدّله — دقيقتان تكفيان لتشغيل أول رد آلي.
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => setShowTemplates(true)}>
            اختر قالبًا
          </button>
        </div>
      )}

      {canManage && showTemplates && templatePicker}

      {showAddForm && (
        <form onSubmit={submitSource} className="card" style={{ padding: 20, marginBottom: 22, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              نوع المصدر
              <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
                {Object.entries(SOURCE_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              العنوان
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="مثال: سياسة الشحن والاسترجاع" />
            </label>
          </div>

          {isFileType ? (
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              الملف ({sourceType === "pdf" ? ".pdf" : sourceType === "word" ? ".docx" : ".xlsx"})
              <input
                ref={fileInputRef}
                type="file"
                required
                accept={sourceType === "pdf" ? ".pdf" : sourceType === "word" ? ".docx" : ".xlsx"}
              />
              <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
                يُستخرَج النص تلقائيًا من الملف ويُفهرَس فورًا. الحد الأقصى 10 ميجابايت.
              </span>
            </label>
          ) : (
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              النص
              <textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                required
                rows={6}
                placeholder="الصق النص هنا — سيُقسَّم ويُفهرَس تلقائيًا"
                style={{ resize: "vertical", fontFamily: "inherit" }}
              />
            </label>
          )}

          {formError && <div style={{ color: "var(--critical)", fontSize: 13 }}>{formError}</div>}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={submitting}>
              {submitting ? "جارٍ الإضافة…" : "إضافة وفهرسة"}
            </button>
          </div>
        </form>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: 18, borderBottom: "1px solid var(--border)" }}>
        <button
          onClick={() => setTab("pending")}
          style={{
            background: "none",
            border: "none",
            padding: "10px 4px",
            marginInlineEnd: 20,
            fontSize: 13.5,
            cursor: "pointer",
            color: tab === "pending" ? "var(--primary-strong)" : "var(--text-dim)",
            fontWeight: tab === "pending" ? 700 : 400,
            borderBottom: tab === "pending" ? "2px solid var(--primary)" : "2px solid transparent",
          }}
        >
          بانتظار المراجعة ({suggestions.length})
        </button>
        <button
          onClick={() => setTab("active")}
          style={{
            background: "none",
            border: "none",
            padding: "10px 4px",
            fontSize: 13.5,
            cursor: "pointer",
            color: tab === "active" ? "var(--primary-strong)" : "var(--text-dim)",
            fontWeight: tab === "active" ? 700 : 400,
            borderBottom: tab === "active" ? "2px solid var(--primary)" : "2px solid transparent",
          }}
        >
          المصادر النشطة
        </button>
      </div>

      {tab === "pending" &&
        (suggestions.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: 13 }}>لا اقتراحات بانتظار المراجعة.</div>
        ) : (
          suggestions.map((s) => (
            <div key={s.id} className="card" style={{ padding: "16px 18px", marginBottom: 12 }}>
              <div style={{ fontSize: 14, whiteSpace: "pre-wrap", marginBottom: 12 }}>{s.content}</div>
              {canApprove && (
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button className="btn btn-danger btn-sm" onClick={() => decide(s.id, "reject")}>
                    رفض
                  </button>
                  <button className="btn btn-good btn-sm" onClick={() => decide(s.id, "approve")}>
                    موافقة وفهرسة
                  </button>
                </div>
              )}
            </div>
          ))
        ))}

      {tab === "active" && (
        <div className="card">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["المصدر", "النوع", "عدد المقاطع", "الحالة", ""].map((h) => (
                  <th key={h} style={{ textAlign: "right", fontSize: 11.5, color: "var(--text-faint)", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                // A source renders as TWO sibling rows (the row itself, plus
                // its expanded entries) and a table body cannot hold a
                // wrapper element around them, so the key goes on a Fragment
                // — the shorthand <> cannot carry one.
                <Fragment key={s.id}>
                  <tr>
                    <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>{s.title}</td>
                    <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>{s.type}</td>
                    <td className="mono" style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                      {s._count?.chunks ?? 0}
                    </td>
                    <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                      <span className="badge badge-good">{s.status}</span>
                    </td>
                    <td style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13, textAlign: "left" }}>
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-start" }}>
                        <button className="btn btn-sm" onClick={() => toggleEntries(s.id)}>
                          {openSourceId === s.id ? "إخفاء الأسئلة" : "الأسئلة"}
                        </button>
                        {canManage && (
                          <button className="btn btn-danger btn-sm" onClick={() => deleteSource(s.id, s.title)}>
                            حذف
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {openSourceId === s.id && (
                    <tr>
                      <td colSpan={5} style={{ padding: "16px 18px", borderBottom: "1px solid var(--border)", background: "var(--surface-2, transparent)" }}>
                        {entriesLoading ? (
                          <div style={{ fontSize: 13, color: "var(--text-dim)" }}>جارٍ التحميل…</div>
                        ) : (
                          <>
                            {entries.length === 0 ? (
                              <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 14 }}>
                                لا أسئلة في هذا المصدر بعد.
                              </div>
                            ) : (
                              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
                                {entries.map((entry) => {
                                  const { question, answer } = parseEntry(entry.content);
                                  return (
                                    <div
                                      key={entry.id}
                                      style={{
                                        border: "1px solid var(--border)",
                                        borderRadius: 8,
                                        padding: "10px 12px",
                                        display: "flex",
                                        gap: 12,
                                        alignItems: "flex-start",
                                      }}
                                    >
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        {question && (
                                          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{question}</div>
                                        )}
                                        <div style={{ fontSize: 12.5, color: "var(--text-dim)", whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
                                          {answer}
                                        </div>
                                      </div>
                                      {canManage && (
                                        <button className="btn btn-danger btn-sm" onClick={() => deleteEntry(entry.id)}>
                                          حذف
                                        </button>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {canManage && (
                              <form onSubmit={addEntry} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                <div style={{ fontSize: 12.5, fontWeight: 700 }}>أضف سؤالًا</div>
                                <input
                                  type="text"
                                  value={newQuestion}
                                  onChange={(e) => setNewQuestion(e.target.value)}
                                  required
                                  placeholder="السؤال كما يكتبه العميل — مثال: كم رسوم التوصيل؟"
                                />
                                <textarea
                                  value={newAnswer}
                                  onChange={(e) => setNewAnswer(e.target.value)}
                                  required
                                  rows={3}
                                  placeholder="الإجابة التي يُسمح للذكاء الاصطناعي بقولها حرفيًا"
                                  style={{ resize: "vertical", fontFamily: "inherit" }}
                                />
                                {entryError && <div style={{ color: "var(--critical)", fontSize: 13 }}>{entryError}</div>}
                                <div>
                                  <button className="btn btn-primary btn-sm" type="submit" disabled={savingEntry}>
                                    {savingEntry ? "جارٍ الحفظ…" : "أضف وفهرس"}
                                  </button>
                                  <span style={{ fontSize: 11.5, color: "var(--text-faint)", marginInlineStart: 10 }}>
                                    يعمل فورًا — بلا حذف المصدر أو إعادة لصقه
                                  </span>
                                </div>
                              </form>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
