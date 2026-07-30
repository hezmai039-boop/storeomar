import { CSSProperties, FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiClientError } from "../api/client";
import type {
  AdminInvoice,
  AdminOrganization,
  BillingOverview,
  CheckoutInstruction,
  Invoice,
  InvoiceStatus,
  Plan,
  PlanRequest,
  PlanRequestStatus,
  SubscribeResult,
  SubscriptionStatus,
} from "../api/types";
import { usePermissions, PERMISSIONS } from "../lib/permissions";

// Amounts arrive as integer halalas (SAR × 100). This is the ONLY place that
// divides by 100 — anywhere else and a stray float turns 299.00 into 298.99.
const SAR = new Intl.NumberFormat("ar-SA-u-nu-latn", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function formatSar(halalas: number): string {
  return `${SAR.format(halalas / 100)} ر.س`;
}

// Gregorian is forced: ar-SA defaults to the Hijri calendar, and a billing
// period / renewal date printed in Hijri won't match the customer's bank
// statement or the invoice PDF.
const DATE = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "long", year: "numeric" });
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : DATE.format(d);
}

/** null on any quota field means unlimited — never render it as 0. */
function formatLimit(limit: number | null): string {
  return limit === null ? "غير محدود" : String(limit);
}

const SUBSCRIPTION_STATUS: Record<SubscriptionStatus, { label: string; badge: string }> = {
  active: { label: "نشط", badge: "badge-good" },
  trialing: { label: "تجريبي", badge: "badge-info" },
  past_due: { label: "متأخر السداد", badge: "badge-warn" },
  canceled: { label: "ملغى", badge: "badge-neutral" },
};

const INVOICE_STATUS: Record<InvoiceStatus, { label: string; badge: string }> = {
  pending: { label: "بانتظار السداد", badge: "badge-warn" },
  awaiting_review: { label: "قيد المراجعة", badge: "badge-info" },
  paid: { label: "مدفوعة", badge: "badge-good" },
  rejected: { label: "مرفوضة", badge: "badge-critical" },
  void: { label: "ملغاة", badge: "badge-neutral" },
};

const PLAN_REQUEST_STATUS: Record<PlanRequestStatus, { label: string; badge: string }> = {
  new: { label: "جديد", badge: "badge-warn" },
  contacted: { label: "تم التواصل", badge: "badge-info" },
  activated: { label: "مُفعَّل", badge: "badge-good" },
  rejected: { label: "مرفوض", badge: "badge-neutral" },
};

/**
 * wa.me wants the number in international format with no +, which is exactly
 * how the backend normalises it. Falls back to whatever was typed if it
 * could not be normalised — a link that opens the wrong chat is still more
 * useful than no link, because the number is visible next to it either way.
 */
function whatsappHref(phone: string, planName: string): string {
  const digits = phone.replace(/\D/g, "");
  const text = `مرحبًا، بخصوص طلبك لباقة «${planName}» في منصة Atlas`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

const TH: CSSProperties = {
  textAlign: "right",
  fontSize: 11.5,
  color: "var(--text-faint)",
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
};
const TD: CSSProperties = { padding: "12px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 };

function fieldStyle(): CSSProperties {
  return { display: "flex", flexDirection: "column", gap: 6, fontSize: 12, flex: 1, minWidth: 180 };
}

export function BillingPage() {
  const { can } = usePermissions();
  const canManage = can(PERMISSIONS.BILLING_MANAGE);

  const [overview, setOverview] = useState<BillingOverview | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // One key at a time ("plan:pro", "invoice:<id>", "admin:<id>") — every button
  // that fires a request checks it, so a double-click can't open two invoices.
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<CheckoutInstruction | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [transferFor, setTransferFor] = useState<string | null>(null);
  const [transfer, setTransfer] = useState({ transferRef: "", receiptUrl: "" });

  const [adminInvoices, setAdminInvoices] = useState<AdminInvoice[] | null>(null);
  const [isStaff, setIsStaff] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);

  // Landing-page leads + the organization picker that activating one needs.
  const [planRequests, setPlanRequests] = useState<PlanRequest[] | null>(null);
  const [organizations, setOrganizations] = useState<AdminOrganization[] | null>(null);
  // Which lead's activation form is open, and what it holds. One at a time:
  // activating grants paid service, and two half-filled forms on screen is
  // how the wrong organization gets a plan.
  const [activateFor, setActivateFor] = useState<string | null>(null);
  const [activateForm, setActivateForm] = useState({ organizationId: "", planKey: "", periods: "1", amountSar: "", paymentNote: "" });

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [sub, plan, inv] = await Promise.all([
        api.get<{ data: BillingOverview }>("/v1/billing/subscription"),
        api.get<{ data: Plan[] }>("/v1/billing/plans"),
        api.get<{ data: Invoice[] }>("/v1/billing/invoices"),
      ]);
      setOverview(sub.data);
      setPlans([...plan.data].sort((a, b) => a.sortOrder - b.sortOrder));
      setInvoices(inv.data);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "تعذّر تحميل بيانات الاشتراك");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Platform-staff membership isn't in the permission matrix — the only way to
  // know is to ask. A 403 here is the expected answer for every customer, so
  // it silently hides the section rather than surfacing an error.
  const reloadAdmin = useCallback(async () => {
    try {
      // One request decides staff membership, and the rest follow only if it
      // succeeded — firing all four in parallel would produce three more
      // 403s in the console for every ordinary customer who opens this page.
      const resp = await api.get<{ data: AdminInvoice[] }>("/v1/billing/admin/invoices?status=awaiting_review");
      setAdminInvoices(resp.data);
      setIsStaff(true);
      setAdminError(null);

      const [requests, orgs] = await Promise.all([
        api.get<{ data: PlanRequest[] }>("/v1/billing/admin/plan-requests"),
        api.get<{ data: AdminOrganization[] }>("/v1/billing/admin/organizations"),
      ]);
      setPlanRequests(requests.data);
      setOrganizations(orgs.data);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) {
        setIsStaff(false);
        return;
      }
      setAdminError(err instanceof ApiClientError ? err.message : "تعذّر تحميل بيانات المراجعة");
    }
  }, []);

  useEffect(() => {
    reloadAdmin();
  }, [reloadAdmin]);

  async function copyValue(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
    } catch {
      setActionError("تعذّر النسخ تلقائيًا — انسخ القيمة يدويًا.");
    }
  }

  async function subscribe(plan: Plan) {
    setBusy(`plan:${plan.key}`);
    setActionError(null);
    try {
      const resp = await api.post<{ data: SubscribeResult }>("/v1/billing/subscribe", { planKey: plan.key });
      const instruction = resp.data.checkout;
      setCheckout(instruction);
      if (instruction?.kind === "redirect" && instruction.redirectUrl) {
        window.location.assign(instruction.redirectUrl);
        return;
      }
      await reload();
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "تعذّر تنفيذ الاشتراك");
    } finally {
      setBusy(null);
    }
  }

  async function submitTransfer(e: FormEvent, invoice: Invoice) {
    e.preventDefault();
    setBusy(`invoice:${invoice.id}`);
    setActionError(null);
    try {
      const receiptUrl = transfer.receiptUrl.trim();
      const resp = await api.post<{ data: Invoice }>(`/v1/billing/invoices/${invoice.id}/transfer`, {
        transferRef: transfer.transferRef.trim(),
        ...(receiptUrl ? { receiptUrl } : {}),
      });
      setInvoices((list) => list?.map((i) => (i.id === invoice.id ? resp.data : i)) ?? null);
      setTransferFor(null);
      setTransfer({ transferRef: "", receiptUrl: "" });
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "تعذّر إرسال بيانات الحوالة");
    } finally {
      setBusy(null);
    }
  }

  async function reviewInvoice(invoice: AdminInvoice, decision: "approve" | "reject") {
    let note: string | null = null;
    if (decision === "reject") {
      // A rejection the customer can't act on is worse than no rejection, so
      // the note is required here exactly as the backend requires it.
      note = window.prompt(`سبب رفض الفاتورة ${invoice.number} لـ«${invoice.organization.name}»؟ (يظهر للعميل)`);
      if (!note || !note.trim()) return;
    }
    setBusy(`admin:${invoice.id}`);
    setAdminError(null);
    try {
      await api.post(`/v1/billing/admin/invoices/${invoice.id}/${decision}`, note ? { note: note.trim() } : {});
      await reloadAdmin();
    } catch (err) {
      setAdminError(err instanceof ApiClientError ? err.message : "تعذّر تنفيذ الإجراء");
    } finally {
      setBusy(null);
    }
  }

  async function setRequestStatus(request: PlanRequest, status: "contacted" | "rejected") {
    let note: string | undefined;
    if (status === "rejected") {
      const answer = window.prompt(`سبب رفض طلب «${request.name}»؟ (داخلي — لا يظهر للعميل)`);
      if (answer === null) return;
      note = answer.trim() || undefined;
    }
    setBusy(`req:${request.id}`);
    setAdminError(null);
    try {
      await api.patch(`/v1/billing/admin/plan-requests/${request.id}`, { status, ...(note ? { note } : {}) });
      await reloadAdmin();
    } catch (err) {
      setAdminError(err instanceof ApiClientError ? err.message : "تعذّر تحديث الطلب");
    } finally {
      setBusy(null);
    }
  }

  function openActivate(request: PlanRequest) {
    if (activateFor === request.id) {
      setActivateFor(null);
      return;
    }
    setActivateFor(request.id);
    setActivateForm({
      // Pre-select the organization the lead is already linked to, if any;
      // otherwise the owner must pick one deliberately. Never guessed by
      // name match — activating the wrong tenant gives a stranger a paid
      // plan and takes it from the customer who paid.
      organizationId: request.organizationId ?? "",
      planKey: request.planKey,
      periods: "1",
      amountSar: "",
      paymentNote: "",
    });
  }

  async function activatePlan(e: FormEvent, request: PlanRequest) {
    e.preventDefault();
    if (!activateForm.organizationId) {
      setAdminError("اختر المؤسسة التي ستُفعَّل لها الباقة");
      return;
    }
    setBusy(`activate:${request.id}`);
    setAdminError(null);
    try {
      // SAR in the form, halalas on the wire — Math.round, not a bare
      // multiply: 79.9 * 100 is 7989.999999999999 in binary floating point,
      // and the backend takes an integer.
      const amount = activateForm.amountSar.trim();
      await api.post(`/v1/billing/admin/organizations/${activateForm.organizationId}/activate-plan`, {
        planKey: activateForm.planKey,
        periods: Number(activateForm.periods) || 1,
        ...(amount ? { amountHalalas: Math.round(Number(amount) * 100) } : {}),
        ...(activateForm.paymentNote.trim() ? { paymentNote: activateForm.paymentNote.trim() } : {}),
        planRequestId: request.id,
      });
      setActivateFor(null);
      await reloadAdmin();
      // The activated organization may be this owner's own, so the header
      // above can now be stale.
      await reload();
    } catch (err) {
      setAdminError(err instanceof ApiClientError ? err.message : "تعذّر تفعيل الباقة");
    } finally {
      setBusy(null);
    }
  }

  // From the loaded list rather than the response's meta.openCount: the two
  // agree, and reading it here keeps the badge consistent with the rows
  // actually on screen after a local status change.
  const openPlanRequests = planRequests?.filter((r) => r.status === "new").length ?? 0;

  const usage = overview?.usage ?? null;
  const currentPlan = overview?.plan ?? null;
  const subscription = overview?.subscription ?? null;
  const percent = usage ? Math.max(0, Math.round(usage.percentUsed)) : 0;
  const overQuota = !!usage && usage.limit !== null && usage.percentUsed >= 100;
  const barColor = percent >= 100 ? "var(--critical)" : percent >= 80 ? "var(--warn)" : "var(--primary)";

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>الاشتراك والفوترة</h1>
        <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>
          باقتك الحالية، استهلاك الردود الآلية لهذه الدورة، وفواتيرك — كلها في مكان واحد.
        </p>
      </div>

      {error && <div style={{ color: "var(--critical)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {actionError && <div style={{ color: "var(--critical)", fontSize: 13, marginBottom: 12 }}>{actionError}</div>}
      {loading && !overview && !error && <div style={{ color: "var(--text-dim)" }}>جارٍ التحميل…</div>}

      {/* ---------- 1. current plan + usage ---------- */}
      {usage && (
        <section className="card" style={{ padding: "18px 20px", marginBottom: 26 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <b style={{ fontSize: 16 }}>{currentPlan ? currentPlan.name : "بلا باقة"}</b>
                {subscription && (
                  <span className={`badge ${SUBSCRIPTION_STATUS[subscription.status].badge}`}>
                    {SUBSCRIPTION_STATUS[subscription.status].label}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: 4 }}>
                {currentPlan
                  ? `${formatSar(currentPlan.priceHalalas)} / ${currentPlan.interval === "yearly" ? "سنويًا" : "شهريًا"}`
                  : "اختر باقة من الأسفل لتفعيل الردود الآلية."}
              </div>
            </div>
            {subscription && (
              <div style={{ textAlign: "start" }}>
                <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
                  {subscription.status === "trialing"
                    ? "تنتهي التجربة في"
                    : subscription.status === "canceled"
                      ? "ينتهي الوصول في"
                      : "التجديد القادم"}
                </div>
                <b className="mono" style={{ fontSize: 13.5 }}>
                  {formatDate(subscription.status === "trialing" ? (subscription.trialEndsAt ?? subscription.currentPeriodEnd) : subscription.currentPeriodEnd)}
                </b>
              </div>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>الردود الآلية هذه الدورة</span>
            <b className="mono" style={{ fontSize: 13.5 }}>
              {usage.limit === null ? "غير محدود" : `${usage.aiReplies} من ${usage.limit}`}
            </b>
          </div>
          {usage.limit !== null && (
            <div
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="استهلاك الردود الآلية"
              style={{ height: 8, borderRadius: "var(--radius-pill)", background: "var(--surface-2)", overflow: "hidden" }}
            >
              <div
                style={{
                  width: `${Math.min(100, percent)}%`,
                  height: "100%",
                  background: barColor,
                  borderRadius: "var(--radius-pill)",
                  transition: "width var(--dur-base) var(--ease)",
                }}
              />
            </div>
          )}

          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 16, fontSize: 12.5, color: "var(--text-dim)" }}>
            <div>
              المتاجر
              <b className="mono" style={{ display: "block", fontSize: 14, color: "var(--text)", marginTop: 2 }}>
                {usage.stores.used} / {formatLimit(usage.stores.limit)}
              </b>
            </div>
            <div>
              المستخدمون
              <b className="mono" style={{ display: "block", fontSize: 14, color: "var(--text)", marginTop: 2 }}>
                {usage.users.used} / {formatLimit(usage.users.limit)}
              </b>
            </div>
            <div>
              دورة الاستهلاك
              <b className="mono" style={{ display: "block", fontSize: 14, color: "var(--text)", marginTop: 2 }}>{usage.period}</b>
            </div>
            {/* Token counts and platform cost are internal economics — shown to
                platform staff only, never to the paying customer. */}
            {isStaff && (
              <div>
                الاستهلاك التقني
                <b className="mono" style={{ display: "block", fontSize: 14, color: "var(--text)", marginTop: 2 }}>
                  {usage.inputTokens + usage.outputTokens} توكن · {(usage.costMicroUsd / 1_000_000).toFixed(2)}$
                </b>
              </div>
            )}
          </div>

          {overQuota && (
            <div
              style={{
                marginTop: 16,
                padding: "12px 14px",
                borderRadius: "var(--radius-md)",
                background: "var(--info-tint)",
                color: "var(--text)",
                fontSize: 12.5,
                lineHeight: 1.7,
                borderInlineStart: "3px solid var(--info)",
              }}
            >
              <b>وصلت إلى حد الردود الآلية في هذه الدورة.</b> الردود التلقائية متوقفة مؤقتًا، وكل رسالة جديدة تصل الآن
              تُحوَّل إلى فريقك كتذكرة في صندوق التذاكر — لا شيء يضيع ولا عميل بلا رد. لعودة الردود الآلية فورًا رقِّ
              باقتك، أو انتظر تجديد الدورة{subscription ? ` في ${formatDate(subscription.currentPeriodEnd)}` : ""}.
            </div>
          )}
        </section>
      )}

      {/* ---------- 2. plans ---------- */}
      <section style={{ marginBottom: 30 }}>
        <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>الباقات</h2>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>
          {canManage
            ? "قارن الباقات واختر ما يناسب حجم متاجرك — الترقية تسري فور تأكيد الدفع."
            : "هذه باقات المنصة. تغيير الباقة متاح لمالك الحساب فقط."}
        </p>

        {plans && plans.length === 0 && <div style={{ color: "var(--text-dim)", fontSize: 13 }}>لا باقات متاحة حاليًا.</div>}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14 }}>
          {plans?.map((p) => {
            const isCurrent = currentPlan?.key === p.key;
            const busyKey = `plan:${p.key}`;
            const label = !currentPlan ? "اشترك" : p.priceHalalas > currentPlan.priceHalalas ? "ترقية" : "تغيير الباقة";
            return (
              <div
                key={p.id}
                className="card"
                style={{ padding: "16px 18px", borderColor: isCurrent ? "var(--primary)" : undefined, display: "flex", flexDirection: "column", gap: 10 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 15 }}>{p.name}</b>
                  {isCurrent && <span className="badge badge-info">باقتك الحالية</span>}
                </div>
                <div className="mono" style={{ fontSize: 18 }}>
                  {formatSar(p.priceHalalas)}
                  <span style={{ fontSize: 12, color: "var(--text-dim)" }}> / {p.interval === "yearly" ? "سنويًا" : "شهريًا"}</span>
                </div>
                <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.9 }}>
                  <li>الردود الآلية: {formatLimit(p.maxAiRepliesMonthly)}</li>
                  <li>المتاجر: {formatLimit(p.maxStores)}</li>
                  <li>المستخدمون: {formatLimit(p.maxUsers)}</li>
                  {p.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                {canManage && (
                  <div style={{ marginTop: "auto" }}>
                    <button className="btn btn-primary btn-sm" disabled={isCurrent || busy !== null} onClick={() => subscribe(p)}>
                      {busy === busyKey ? "جارٍ…" : isCurrent ? "باقتك الحالية" : label}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {checkout?.kind === "offline_transfer" && checkout.instructions && (
          <div className="card" style={{ padding: "18px 20px", marginTop: 16 }}>
            <b style={{ fontSize: 14 }}>حوّل المبلغ إلى الحساب التالي</b>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>البنك</div>
                <b style={{ fontSize: 13.5 }}>{checkout.instructions.bankName}</b>
              </div>
              <div>
                <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>اسم الحساب</div>
                <b style={{ fontSize: 13.5 }}>{checkout.instructions.accountName}</b>
              </div>
              <div>
                <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>الآيبان</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <b className="mono" dir="ltr" style={{ fontSize: 13 }}>
                    {checkout.instructions.iban}
                  </b>
                  <button className="btn btn-ghost btn-sm" onClick={() => copyValue("iban", checkout.instructions!.iban)}>
                    {copied === "iban" ? "تم النسخ ✓" : "نسخ"}
                  </button>
                </div>
              </div>
            </div>

            {/* A transfer without this reference can't be matched to the
                invoice, so it gets the loudest block on the page. */}
            <div
              style={{
                marginTop: 14,
                padding: "14px 16px",
                borderRadius: "var(--radius-md)",
                background: "var(--primary-tint)",
                border: "1px solid var(--primary)",
              }}
            >
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
                اكتب هذا الرقم المرجعي في خانة «الغرض / البيان» عند التحويل — بدونه لا نستطيع ربط حوالتك بفاتورتك:
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <b className="mono" dir="ltr" style={{ fontSize: 20, letterSpacing: 1 }}>
                  {checkout.instructions.reference}
                </b>
                <button className="btn btn-primary btn-sm" onClick={() => copyValue("ref", checkout.instructions!.reference)}>
                  {copied === "ref" ? "تم النسخ ✓" : "نسخ الرقم المرجعي"}
                </button>
              </div>
            </div>

            <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.8 }}>
              {checkout.instructions.note}
            </p>
            <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--text-dim)" }}>
              بعد التحويل، سجّل رقم الحوالة في فاتورتك من جدول الفواتير بالأسفل لنؤكدها.
            </p>
          </div>
        )}

        {checkout?.kind === "redirect" && checkout.redirectUrl && (
          <div className="card" style={{ padding: "16px 18px", marginTop: 16, fontSize: 13 }}>
            أكمل الدفع عبر بوابة الدفع:{" "}
            <a href={checkout.redirectUrl} rel="noreferrer">
              فتح صفحة الدفع
            </a>
          </div>
        )}
      </section>

      {/* ---------- 3. invoices ---------- */}
      <section style={{ marginBottom: 30 }}>
        <h2 style={{ fontSize: 16, margin: "0 0 14px" }}>الفواتير</h2>

        {invoices && invoices.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: 13 }}>لا فواتير بعد.</div>
        ) : (
          invoices && (
            <div className="card" style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["رقم الفاتورة", "الفترة", "الإجمالي", "الحالة", "التاريخ", ""].map((h) => (
                      <th key={h} style={TH}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => {
                    const meta = INVOICE_STATUS[inv.status];
                    const busyKey = `invoice:${inv.id}`;
                    return (
                      <tr key={inv.id}>
                        <td className="mono" style={{ ...TD, fontSize: 12.5 }}>
                          {inv.number}
                        </td>
                        <td style={{ ...TD, color: "var(--text-dim)", fontSize: 12.5, whiteSpace: "nowrap" }}>
                          {formatDate(inv.periodStart)} – {formatDate(inv.periodEnd)}
                        </td>
                        <td className="mono" style={TD}>
                          {formatSar(inv.totalHalalas)}
                          <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                            شامل ضريبة {formatSar(inv.vatHalalas)}
                          </div>
                        </td>
                        <td style={TD}>
                          <span className={`badge ${meta.badge}`}>{meta.label}</span>
                          {inv.status === "awaiting_review" && (
                            <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 6 }}>
                              استلمنا بيانات الحوالة — سنؤكدها خلال وقت قصير.
                            </div>
                          )}
                          {inv.status === "rejected" && inv.reviewNote && (
                            <div style={{ fontSize: 11.5, color: "var(--critical)", marginTop: 6, maxWidth: 260, lineHeight: 1.7 }}>
                              سبب الرفض: {inv.reviewNote}
                            </div>
                          )}
                        </td>
                        <td className="mono" style={{ ...TD, color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                          {formatDate(inv.createdAt)}
                        </td>
                        <td style={{ ...TD, textAlign: "start" }}>
                          {/* canManage, not just billing.view: the backend
                              guards POST /invoices/:id/transfer with
                              requireOwner(), and a store_manager is never an
                              organization owner — showing them this form
                              would guarantee a 403 on submit. */}
                          {inv.status === "pending" && canManage && (
                            <>
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => {
                                  setTransferFor(transferFor === inv.id ? null : inv.id);
                                  setTransfer({ transferRef: "", receiptUrl: "" });
                                }}
                              >
                                {transferFor === inv.id ? "إلغاء" : "تسجيل حوالة"}
                              </button>
                              {transferFor === inv.id && (
                                <form
                                  onSubmit={(e) => submitTransfer(e, inv)}
                                  style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}
                                >
                                  <label style={fieldStyle()}>
                                    رقم الحوالة المرجعي
                                    <input
                                      dir="ltr"
                                      className="mono"
                                      value={transfer.transferRef}
                                      onChange={(e) => setTransfer((t) => ({ ...t, transferRef: e.target.value }))}
                                      required
                                    />
                                  </label>
                                  <label style={fieldStyle()}>
                                    رابط الإيصال (اختياري)
                                    <input
                                      type="url"
                                      dir="ltr"
                                      value={transfer.receiptUrl}
                                      onChange={(e) => setTransfer((t) => ({ ...t, receiptUrl: e.target.value }))}
                                    />
                                  </label>
                                  <button className="btn btn-primary btn-sm" type="submit" disabled={busy !== null}>
                                    {busy === busyKey ? "جارٍ الإرسال…" : "إرسال للمراجعة"}
                                  </button>
                                </form>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </section>

      {/* ---------- 4. platform staff: landing-page leads ---------- */}
      {/* Above the transfer queue on purpose: a lead is a customer who has
          not paid yet and will go elsewhere if nobody calls, while an
          invoice awaiting review is money already sent that can wait an
          hour. Ordered by urgency, not by when the feature was built. */}
      {isStaff && (
        <section style={{ marginBottom: 30 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
            <h2 style={{ fontSize: 16, margin: 0 }}>طلبات الباقات</h2>
            {openPlanRequests > 0 && <span className="badge badge-warn">{openPlanRequests} جديد</span>}
          </div>
          <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>
            طلبات وصلت من صفحة الهبوط. تواصل مع صاحب الطلب، اتفق معه على الدفع، ثم فعّل له الباقة على مؤسسته من هنا.
          </p>

          {planRequests && planRequests.length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: 13 }}>لا طلبات بعد.</div>
          ) : (
            planRequests && (
              <div style={{ display: "grid", gap: 12 }}>
                {planRequests.map((r) => {
                  const meta = PLAN_REQUEST_STATUS[r.status];
                  const planName = r.plan?.name ?? r.planKey;
                  const isOpen = activateFor === r.id;
                  return (
                    <div key={r.id} className="card" style={{ padding: "14px 16px" }}>
                      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div style={{ flex: 1, minWidth: 240 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <b style={{ fontSize: 14.5 }}>{r.name}</b>
                            <span className={`badge ${meta.badge}`}>{meta.label}</span>
                            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>يطلب: {planName}</span>
                          </div>
                          <div style={{ marginTop: 6, display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5, color: "var(--text-dim)" }}>
                            <a className="mono" dir="ltr" href={`mailto:${r.email}`}>
                              {r.email}
                            </a>
                            <a className="mono" dir="ltr" href={whatsappHref(r.phone, planName)} target="_blank" rel="noopener noreferrer">
                              {r.phone} ↗
                            </a>
                            <span className="mono">{formatDate(r.createdAt)}</span>
                          </div>
                          {r.storeName && (
                            <div style={{ marginTop: 4, fontSize: 12.5, color: "var(--text-dim)" }}>المتجر: {r.storeName}</div>
                          )}
                          {r.note && (
                            <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.8, maxWidth: 560 }}>«{r.note}»</div>
                          )}
                          {r.organization && (
                            <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-faint)" }}>
                              مرتبط بمؤسسة: {r.organization.name}
                            </div>
                          )}
                          {r.handleNote && (
                            <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-faint)" }}>ملاحظتك: {r.handleNote}</div>
                          )}
                        </div>

                        {/* An activated lead is done — its buttons would only
                            offer ways to double-charge or contradict the
                            record. */}
                        {r.status !== "activated" && (
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {r.status === "new" && (
                              <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => setRequestStatus(r, "contacted")}>
                                {busy === `req:${r.id}` ? "جارٍ…" : "تم التواصل"}
                              </button>
                            )}
                            <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => openActivate(r)}>
                              {isOpen ? "إلغاء" : "تفعيل الباقة"}
                            </button>
                            <button className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => setRequestStatus(r, "rejected")}>
                              رفض
                            </button>
                          </div>
                        )}
                      </div>

                      {isOpen && (
                        <form
                          onSubmit={(e) => activatePlan(e, r)}
                          style={{
                            marginTop: 14,
                            paddingTop: 14,
                            borderTop: "1px solid var(--border)",
                            display: "flex",
                            gap: 10,
                            flexWrap: "wrap",
                            alignItems: "flex-end",
                          }}
                        >
                          <label style={{ ...fieldStyle(), minWidth: 220 }}>
                            المؤسسة
                            <select
                              value={activateForm.organizationId}
                              onChange={(e) => setActivateForm((f) => ({ ...f, organizationId: e.target.value }))}
                              required
                            >
                              <option value="">— اختر —</option>
                              {organizations?.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.name} {o.subscription ? `(${o.subscription.plan.name})` : "(بلا باقة)"}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label style={fieldStyle()}>
                            الباقة
                            <select
                              value={activateForm.planKey}
                              onChange={(e) => setActivateForm((f) => ({ ...f, planKey: e.target.value }))}
                              required
                            >
                              {plans?.map((p) => (
                                <option key={p.key} value={p.key}>
                                  {p.name} — {formatSar(p.priceHalalas)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label style={{ ...fieldStyle(), minWidth: 110, flex: "0 0 110px" }}>
                            عدد الدورات
                            <input
                              type="number"
                              min={1}
                              max={24}
                              className="mono"
                              value={activateForm.periods}
                              onChange={(e) => setActivateForm((f) => ({ ...f, periods: e.target.value }))}
                              required
                            />
                          </label>
                          <label style={{ ...fieldStyle(), minWidth: 150 }}>
                            المبلغ المستلم (ر.س)
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              dir="ltr"
                              className="mono"
                              placeholder="سعر الباقة"
                              value={activateForm.amountSar}
                              onChange={(e) => setActivateForm((f) => ({ ...f, amountSar: e.target.value }))}
                            />
                          </label>
                          <label style={{ ...fieldStyle(), minWidth: 200 }}>
                            ملاحظة الدفع
                            <input
                              placeholder="تحويل بنكي — الراجحي"
                              value={activateForm.paymentNote}
                              onChange={(e) => setActivateForm((f) => ({ ...f, paymentNote: e.target.value }))}
                            />
                          </label>
                          <button className="btn btn-good btn-sm" type="submit" disabled={busy !== null}>
                            {busy === `activate:${r.id}` ? "جارٍ التفعيل…" : "تفعيل وإصدار فاتورة مدفوعة"}
                          </button>
                          <p style={{ flexBasis: "100%", margin: 0, fontSize: 11.5, color: "var(--text-faint)", lineHeight: 1.8 }}>
                            سيصدر هذا فاتورة <b>مدفوعة</b> بالمبلغ أعلاه ويمدّد اشتراك المؤسسة — نفّذه بعد وصول المبلغ فعلًا.
                            المدة تُضاف إلى نهاية الدورة الحالية، فلا يضيع ما تبقّى للعميل.
                          </p>
                        </form>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          )}
        </section>
      )}

      {/* ---------- 5. platform staff review ---------- */}
      {isStaff && (
        <section>
          <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>مراجعة الحوالات</h2>
          <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>
            فواتير أرسل أصحابها بيانات حوالة بانتظار تأكيدك. طابق الرقم المرجعي مع كشف الحساب قبل الاعتماد.
          </p>
          {adminError && <div style={{ color: "var(--critical)", fontSize: 13, marginBottom: 12 }}>{adminError}</div>}

          {adminInvoices && adminInvoices.length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: 13 }}>لا فواتير بانتظار المراجعة.</div>
          ) : (
            adminInvoices && (
              <div className="card" style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["المؤسسة", "رقم الفاتورة", "الإجمالي", "الرقم المرجعي", "التاريخ", ""].map((h) => (
                        <th key={h} style={TH}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {adminInvoices.map((inv) => {
                      const busyKey = `admin:${inv.id}`;
                      return (
                        <tr key={inv.id}>
                          <td style={TD}>
                            {inv.organization.name}
                            <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>{inv.organization.slug}</div>
                          </td>
                          <td className="mono" style={{ ...TD, fontSize: 12.5 }}>
                            {inv.number}
                          </td>
                          <td className="mono" style={TD}>
                            {formatSar(inv.totalHalalas)}
                          </td>
                          <td className="mono" dir="ltr" style={{ ...TD, fontSize: 12.5, textAlign: "start" }}>
                            {inv.transferRef ?? "—"}
                          </td>
                          <td className="mono" style={{ ...TD, color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                            {formatDate(inv.createdAt)}
                          </td>
                          <td style={{ ...TD, display: "flex", gap: 8, justifyContent: "flex-end" }}>
                            <button className="btn btn-good btn-sm" disabled={busy !== null} onClick={() => reviewInvoice(inv, "approve")}>
                              {busy === busyKey ? "جارٍ…" : "اعتماد"}
                            </button>
                            <button className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => reviewInvoice(inv, "reject")}>
                              رفض
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
        </section>
      )}
    </div>
  );
}
