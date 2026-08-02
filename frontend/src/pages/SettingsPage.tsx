import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiClientError, BASE_URL } from "../api/client";
import type { AiAgent, ChannelAccount, ChannelDiagnosis, Integration } from "../api/types";
import { useStore } from "../context/StoreContext";
import { useAuth } from "../context/AuthContext";
import { BrandTile } from "../components/BrandIcons";
import { readChannelError } from "../lib/channelErrors";

interface CredentialField {
  key: string;
  label: string;
  placeholder?: string;
}

const CHANNEL_TYPES: Array<{ key: string; label: string; fields: CredentialField[] }> = [
  {
    key: "whatsapp",
    label: "واتساب",
    fields: [], // Embedded Signup - no manual fields
  },
  {
    key: "instagram",
    label: "إنستغرام",
    fields: [
      { key: "igUserId", label: "Instagram User ID" },
      { key: "accessToken", label: "Access Token" },
    ],
  },
  {
    key: "messenger",
    label: "ماسنجر",
    fields: [{ key: "pageAccessToken", label: "Page Access Token" }],
  },
  {
    key: "tiktok",
    label: "تيك توك",
    fields: [
      { key: "accessToken", label: "Access Token" },
      { key: "businessId", label: "Business ID" },
    ],
  },
  { key: "mock", label: "قناة تجريبية (بدون حساب حقيقي)", fields: [] },
];

// Arabic titles for the OAuth/Embedded-Signup callback error codes the
// backend redirects back with (?error=…). A raw machine code in the red box
// tells the merchant nothing actionable.
const OAUTH_ERROR_AR: Record<string, string> = {
  access_denied: "تم إلغاء العملية من داخل نافذة الربط — لم يتغير شيء",
  missing_code: "لم تصل بيانات التفويض من المنصة — أعد المحاولة",
  invalid_state: "انتهت صلاحية جلسة الربط أو استُخدمت من قبل — ابدأ الربط من جديد",
  exchange_failed: "فشل التحقق من رمز التفويض لدى المنصة — أعد المحاولة",
  no_waba_shared: "لم تتم مشاركة أي حساب واتساب أعمال خلال المعالج — أعد المحاولة واختر الحساب",
  no_phone_number: "الحساب المُشارك لا يحتوي أي رقم هاتف — أضف رقمًا في لوحة واتساب للأعمال ثم أعد الربط",
  discovery_failed: "تعذرت قراءة بيانات الحساب من المنصة — أعد المحاولة أو تواصل مع الدعم",
  persist_failed: "تم الربط لدى المنصة لكن تعذر الحفظ عندنا — تواصل مع الدعم",
  whatsapp_not_configured: "ربط واتساب التلقائي غير مفعّل في هذا التثبيت — تواصل مع الدعم",
  unknown_platform: "منصة غير معروفة",
};

// Same vocabulary as the owner's «صحة القنوات» table on /overview — a raw
// English `status` in one place and Arabic in the other reads as two
// different systems.
const CHANNEL_STATUS_AR: Record<string, string> = {
  connected: "متصلة",
  error: "خطأ — القناة لا ترسل",
  disconnected: "مفصولة",
  pending: "قيد الإعداد",
};

const PLATFORMS: Array<{ key: string; label: string; fields: CredentialField[]; supportsOAuth?: boolean }> = [
  { key: "salla", label: "سلة", fields: [], supportsOAuth: true },
  { key: "zid", label: "زد", fields: [], supportsOAuth: true },
  {
    key: "shopify",
    label: "Shopify",
    fields: [
      { key: "shopDomain", label: "Shop Domain", placeholder: "your-store.myshopify.com" },
      { key: "accessToken", label: "Admin API Access Token" },
    ],
  },
  {
    key: "woocommerce",
    label: "WooCommerce",
    fields: [
      { key: "storeUrl", label: "Store URL", placeholder: "https://your-store.com" },
      { key: "consumerKey", label: "Consumer Key" },
      { key: "consumerSecret", label: "Consumer Secret" },
    ],
  },
  { key: "mock", label: "منصة تجريبية (بدون حساب حقيقي)", fields: [] },
];

export function SettingsPage() {
  const { activeStore } = useStore();
  const { refreshMe } = useAuth();
  const [channels, setChannels] = useState<ChannelAccount[]>([]);
  const [togglingChannelAi, setTogglingChannelAi] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);

  const [storeName, setStoreName] = useState("");
  const [storeNameSubmitting, setStoreNameSubmitting] = useState(false);
  const [storeNameError, setStoreNameError] = useState<string | null>(null);
  const [storeNameSaved, setStoreNameSaved] = useState(false);

  useEffect(() => {
    setStoreName(activeStore?.name ?? "");
    setStoreNameSaved(false);
    setStoreNameError(null);
  }, [activeStore?.id, activeStore?.name]);

  async function renameStore(e: FormEvent) {
    e.preventDefault();
    if (!activeStore || !storeName.trim()) return;
    setStoreNameSubmitting(true);
    setStoreNameError(null);
    setStoreNameSaved(false);
    try {
      await api.patch(`/v1/stores/${activeStore.id}`, { name: storeName.trim() });
      await refreshMe();
      setStoreNameSaved(true);
    } catch (err) {
      setStoreNameError(err instanceof ApiClientError ? err.message : "تعذّر تعديل اسم المتجر");
    } finally {
      setStoreNameSubmitting(false);
    }
  }

  const [channelTypeKey, setChannelTypeKey] = useState(CHANNEL_TYPES[0].key);
  const [channelExternalId, setChannelExternalId] = useState("");
  const [channelDisplayName, setChannelDisplayName] = useState("");
  const [channelCreds, setChannelCreds] = useState<Record<string, string>>({});
  const [channelSubmitting, setChannelSubmitting] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);
  // "جارٍ الاتصال…" while the browser is being handed to Meta's wizard. Never
  // reset on success — the whole tab navigates away and comes back through
  // the ?connected= redirect.
  const [whatsappConnecting, setWhatsappConnecting] = useState(false);
  const [lastVerifyToken, setLastVerifyToken] = useState<{ channelId: string; channelTypeKey: string; token: string } | null>(null);

  // Rotating an expired/rotated token in place — keeps the same
  // channelAccountId (and therefore the same webhook Callback URL already
  // configured on Meta's side) instead of forcing a delete+recreate, which
  // would break that URL and require reconfiguring the webhook from scratch.
  const [updatingChannelId, setUpdatingChannelId] = useState<string | null>(null);
  const [updateCreds, setUpdateCreds] = useState<Record<string, string>>({});
  const [updateSubmitting, setUpdateSubmitting] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateSuccessId, setUpdateSuccessId] = useState<string | null>(null);

  // «فحص القناة» — a recipient-free diagnosis. The point is that the owner
  // can answer "why did it stop?" themselves instead of seeing a channel
  // that claims to be «متصلة» while nothing has been delivered for days.
  const [diagnosingId, setDiagnosingId] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<{ channelId: string; result: ChannelDiagnosis } | null>(null);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);

  const [platformKey, setPlatformKey] = useState(PLATFORMS[0].key);
  const [platformCreds, setPlatformCreds] = useState<Record<string, string>>({});
  const [platformSubmitting, setPlatformSubmitting] = useState(false);
  const [platformError, setPlatformError] = useState<string | null>(null);

  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{ id: string; orders: number; products: number } | null>(null);

  const [agent, setAgent] = useState<AiAgent | null>(null);
  const [togglingAdvanced, setTogglingAdvanced] = useState(false);
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [togglingPause, setTogglingPause] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!activeStore) return;
    api.get<{ data: ChannelAccount[] }>(`/v1/stores/${activeStore.id}/channel-accounts`).then((r) => setChannels(r.data));
    api.get<{ data: Integration[] }>(`/v1/stores/${activeStore.id}/integrations`).then((r) => setIntegrations(r.data));
    api.get<{ data: AiAgent }>(`/v1/stores/${activeStore.id}/knowledge/ai-agent`).then((r) => setAgent(r.data));
  }, [activeStore]);

  // OAuth callback handling
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthSuccess, setOauthSuccess] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    const connected = params.get("connected");

    if (error) {
      setOauthError(decodeURIComponent(error));
      // Clear the error from URL
      window.history.replaceState({}, "", window.location.pathname);
    } else if (connected) {
      setOauthSuccess(decodeURIComponent(connected));
      window.history.replaceState({}, "", window.location.pathname);
      reload();
    }
  }, [reload]);

  useEffect(() => reload(), [reload]);

  if (!activeStore) return <div style={{ color: "var(--text-dim)" }}>اختر متجرًا من القائمة الجانبية أولًا.</div>;

  const channelDef = CHANNEL_TYPES.find((c) => c.key === channelTypeKey)!;
  const platformDef = PLATFORMS.find((p) => p.key === platformKey)!;

  async function connectChannel(e: FormEvent) {
    e.preventDefault();
    setChannelError(null);
    setChannelSubmitting(true);
    try {
      const resp = await api.post<{ data: ChannelAccount & { webhookVerifyToken: string | null } }>(
        `/v1/stores/${activeStore!.id}/channel-accounts`,
        {
          channelTypeKey,
          externalAccountId: channelExternalId || `mock-${Date.now()}`,
          displayName: channelDisplayName || `${channelDef.label} — ${activeStore!.name}`,
          credentials: channelCreds,
        }
      );
      // WhatsApp now uses one shared app-level webhook URL for every store
      // (docs/22-whatsapp-store-onboarding-manual.md) — no per-account
      // Callback URL/Verify Token to paste into Meta anymore, so skip the
      // card below for it. Other channel types still use the legacy
      // per-account route until they get the same treatment.
      if (resp.data.webhookVerifyToken && channelTypeKey !== "whatsapp") {
        setLastVerifyToken({ channelId: resp.data.id, channelTypeKey, token: resp.data.webhookVerifyToken });
      }
      setChannelExternalId("");
      setChannelDisplayName("");
      setChannelCreds({});
      reload();
    } catch (err) {
      setChannelError(err instanceof ApiClientError ? err.message : "تعذّر ربط القناة");
    } finally {
      setChannelSubmitting(false);
    }
  }

  async function updateChannelCredentials(e: FormEvent, channel: ChannelAccount) {
    e.preventDefault();
    setUpdateError(null);
    setUpdateSubmitting(true);
    try {
      await api.patch(`/v1/stores/${activeStore!.id}/channel-accounts/${channel.id}/credentials`, {
        credentials: updateCreds,
      });
      setUpdatingChannelId(null);
      setUpdateCreds({});
      setUpdateSuccessId(channel.id);
      setTimeout(() => setUpdateSuccessId((cur) => (cur === channel.id ? null : cur)), 4000);
      reload();
    } catch (err) {
      setUpdateError(err instanceof ApiClientError ? err.message : "تعذّر تحديث بيانات الاعتماد");
    } finally {
      setUpdateSubmitting(false);
    }
  }

  /**
   * The per-CHANNEL switch — level 2 of 3 (store → channel → conversation).
   *
   * "Connected" and "answered automatically" are separate decisions, and
   * merchants genuinely want them separate: bot on Instagram and Telegram, a
   * human on WhatsApp because that is where the high-intent buyers are.
   * Without this the only way to say that is to leave WhatsApp disconnected,
   * which also gives up the unified inbox.
   */
  async function toggleChannelAi(channel: ChannelAccount) {
    if (!activeStore) return;
    const next = !channel.aiEnabled;
    setTogglingChannelAi(channel.id);
    try {
      const resp = await api.patch<{ data: ChannelAccount }>(
        `/v1/stores/${activeStore.id}/channel-accounts/${channel.id}/ai`,
        { aiEnabled: next }
      );
      setChannels((list) => list.map((c) => (c.id === channel.id ? { ...c, aiEnabled: resp.data.aiEnabled } : c)));
    } finally {
      setTogglingChannelAi(null);
    }
  }

  async function diagnoseChannel(channel: ChannelAccount) {
    setDiagnosingId(channel.id);
    setDiagnoseError(null);
    setDiagnosis(null);
    try {
      const resp = await api.post<{ data: { diagnosis: ChannelDiagnosis } }>(
        `/v1/stores/${activeStore!.id}/channel-accounts/${channel.id}/diagnose`
      );
      setDiagnosis({ channelId: channel.id, result: resp.data.diagnosis });
      reload(); // the check writes what it learned back onto the channel row
    } catch (err) {
      setDiagnoseError(err instanceof ApiClientError ? err.message : "تعذّر تنفيذ الفحص");
    } finally {
      setDiagnosingId(null);
    }
  }

  async function toggleAdvancedIntelligence() {
    if (!activeStore || !agent) return;
    const next = !agent.advancedIntelligenceEnabled;
    setAdvancedError(null);
    setTogglingAdvanced(true);
    try {
      const resp = await api.patch<{ data: AiAgent }>(`/v1/stores/${activeStore.id}/knowledge/ai-agent`, {
        advancedIntelligenceEnabled: next,
      });
      setAgent(resp.data);
    } catch (err) {
      setAdvancedError(err instanceof ApiClientError ? err.message : "تعذّر تغيير الإعداد");
    } finally {
      setTogglingAdvanced(false);
    }
  }

  async function toggleAiPaused() {
    if (!activeStore || !agent) return;
    const next = agent.status === "paused" ? "active" : "paused";
    if (next === "paused" && !window.confirm("سيتوقف الرد الآلي فورًا لكل قنوات هذا المتجر، وستصل كل الرسائل الجديدة دون رد حتى تُعيد التفعيل أو يرد أحد الموظفين يدويًا. متابعة؟")) {
      return;
    }
    setPauseError(null);
    setTogglingPause(true);
    try {
      const resp = await api.patch<{ data: AiAgent }>(`/v1/stores/${activeStore.id}/knowledge/ai-agent`, { status: next });
      setAgent(resp.data);
    } catch (err) {
      setPauseError(err instanceof ApiClientError ? err.message : "تعذّر تغيير حالة الذكاء الاصطناعي");
    } finally {
      setTogglingPause(false);
    }
  }

  async function connectIntegration(e: FormEvent) {
    e.preventDefault();
    setPlatformError(null);
    setPlatformSubmitting(true);
    try {
      await api.post(`/v1/stores/${activeStore!.id}/integrations`, { platform: platformKey, credentials: platformCreds });
      setPlatformCreds({});
      reload();
    } catch (err) {
      setPlatformError(err instanceof ApiClientError ? err.message : "تعذّر ربط المنصة");
    } finally {
      setPlatformSubmitting(false);
    }
  }

  async function syncIntegration(integration: Integration) {
    setSyncingId(integration.id);
    setSyncError(null);
    setSyncResult(null);
    try {
      const resp = await api.post<{ data: { orders: number; products: number } }>(
        `/v1/stores/${activeStore!.id}/integrations/${integration.id}/sync`
      );
      setSyncResult({ id: integration.id, orders: resp.data.orders, products: resp.data.products });
      reload();
    } catch (err) {
      setSyncError(err instanceof ApiClientError ? err.message : "تعذّرت المزامنة");
    } finally {
      setSyncingId(null);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>الإعدادات</h1>
        <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>{activeStore.name} — القنوات والتكاملات</p>
      </div>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>اسم المتجر</h2>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>
          استبدل الاسم التجريبي باسم المتجر الحقيقي — يظهر فورًا في القائمة الجانبية ونظرة عامة المؤسسة.
        </p>
        <form onSubmit={renameStore} className="card" style={{ padding: 20, display: "flex", alignItems: "flex-end", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, flex: 1 }}>
            الاسم
            <input
              value={storeName}
              onChange={(e) => {
                setStoreName(e.target.value);
                setStoreNameSaved(false);
              }}
              required
            />
          </label>
          <button className="btn btn-primary btn-sm" type="submit" disabled={storeNameSubmitting || !storeName.trim()}>
            {storeNameSubmitting ? "جارٍ الحفظ…" : "حفظ الاسم"}
          </button>
          {storeNameSaved && <span className="badge badge-good">تم الحفظ</span>}
          {storeNameError && <span style={{ color: "var(--critical)", fontSize: 13 }}>{storeNameError}</span>}
        </form>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>القنوات</h2>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>
          أدخل بيانات الاعتماد الحقيقية الصادرة من لوحة المنصة (Meta for Developers لواتساب/إنستغرام/ماسنجر، TikTok
          for Business للأخير). اختر "قناة تجريبية" للتجربة دون أي حساب حقيقي.
        </p>
        {oauthError && (
          <div className="card" style={{ padding: 14, marginBottom: 18, color: "var(--critical)", fontSize: 12.5, borderColor: "var(--critical)" }}>
            فشل الربط: {OAUTH_ERROR_AR[oauthError] ?? oauthError}
          </div>
        )}
        {oauthSuccess === "whatsapp" && (
          <div className="card" style={{ padding: 14, marginBottom: 18, color: "var(--good)", fontSize: 12.5, borderColor: "var(--good)" }}>
            نجح الربط — تم ربط واتساب وتفعيل استقبال الرسائل تلقائيًا.
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14, marginBottom: 18 }}>
          {channels.map((c, i) => (
            <div key={c.id} className="card card-hover ms-enter" style={{ padding: 16, animationDelay: `${Math.min(i, 6) * 40}ms` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <BrandTile brand={c.channelType.key} />
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{c.displayName}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className={`badge ${c.status === "connected" ? "badge-good" : "badge-critical"}`}>
                  {CHANNEL_STATUS_AR[c.status] ?? c.status}
                </span>
                {/* Two different facts, deliberately two badges: `status` is
                    "can we send on this channel", aiEnabled is "should we
                    answer automatically". Merging them would make a merchant
                    who silenced the bot think the channel had broken. */}
                <span className={`badge ${c.aiEnabled ? "badge-info" : "badge-neutral"}`}>
                  {c.aiEnabled ? "الرد الآلي مفعّل" : "رد بشري فقط"}
                </span>
              </div>
              <button
                className={`btn btn-sm ${c.aiEnabled ? "btn-ghost" : "btn-good"}`}
                style={{ marginTop: 10 }}
                disabled={togglingChannelAi === c.id}
                onClick={() => toggleChannelAi(c)}
                title={
                  c.aiEnabled
                    ? "توقف الردود الآلية على هذه القناة وحدها — تصل الرسائل للصندوق ليرد عليها موظف"
                    : "يعود الرد الآلي على هذه القناة"
                }
              >
                {togglingChannelAi === c.id
                  ? "جارٍ…"
                  : c.aiEnabled
                    ? "إيقاف الرد الآلي على هذه القناة"
                    : "تفعيل الرد الآلي على هذه القناة"}
              </button>
              {/* The recorded cause, in Arabic. A red badge that cannot say
                  WHY is what sent the owner back to guessing. */}
              {(() => {
                const err = readChannelError(c.lastError);
                if (!err) return null;
                return (
                  <div
                    style={{
                      marginTop: 10,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "var(--critical-soft, rgba(220,38,38,0.08))",
                      fontSize: 11.5,
                      lineHeight: 1.7,
                    }}
                  >
                    <div style={{ color: "var(--critical)", fontWeight: 700 }}>آخر خطأ مسجَّل</div>
                    <div style={{ color: "var(--text-dim)" }}>{err.messageAr}</div>
                    {err.fixAr && <div style={{ marginTop: 4, color: "var(--text-dim)" }}>الحل: {err.fixAr}</div>}
                    {c.lastErrorAt && (
                      <div className="mono" style={{ marginTop: 4, color: "var(--text-faint)", fontSize: 10.5 }}>
                        {new Date(c.lastErrorAt).toLocaleString("ar-SA")}
                      </div>
                    )}
                  </div>
                );
              })()}
              {c.channelType.key !== "mock" && (
                <div style={{ marginTop: 10 }}>
                  {updateSuccessId === c.id && <span className="badge badge-good">تم تحديث البيانات</span>}
                  {c.channelType.key === "whatsapp" && (
                    <button
                      className="btn btn-sm"
                      type="button"
                      style={{ marginBottom: 8, width: "100%" }}
                      disabled={diagnosingId === c.id}
                      onClick={() => diagnoseChannel(c)}
                    >
                      {diagnosingId === c.id ? "جارٍ الفحص…" : "فحص القناة"}
                    </button>
                  )}
                  {updatingChannelId === c.id ? (
                    <form
                      onSubmit={(e) => updateChannelCredentials(e, c)}
                      style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}
                    >
                      {(CHANNEL_TYPES.find((t) => t.key === c.channelType.key)?.fields ?? []).map((f) => (
                        <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5 }}>
                          {f.label} الجديد
                          <input
                            type="text"
                            value={updateCreds[f.key] ?? ""}
                            onChange={(e) => setUpdateCreds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                            required
                          />
                        </label>
                      ))}
                      {updateError && <span style={{ color: "var(--critical)", fontSize: 12 }}>{updateError}</span>}
                      <div style={{ display: "flex", gap: 8 }}>
                        <button className="btn btn-primary btn-sm" type="submit" disabled={updateSubmitting}>
                          {updateSubmitting ? "جارٍ الحفظ…" : "حفظ"}
                        </button>
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={() => {
                            setUpdatingChannelId(null);
                            setUpdateCreds({});
                            setUpdateError(null);
                          }}
                        >
                          إلغاء
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button
                      className="btn btn-sm"
                      type="button"
                      onClick={() => {
                        setUpdatingChannelId(c.id);
                        setUpdateCreds({});
                        setUpdateError(null);
                      }}
                    >
                      تحديث بيانات الاعتماد (مثلاً بعد انتهاء صلاحية Access Token)
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {diagnoseError && (
          <div className="card" style={{ padding: 14, marginBottom: 18, color: "var(--critical)", fontSize: 12.5 }}>
            {diagnoseError}
          </div>
        )}

        {diagnosis && (
          <div className="card ms-enter" style={{ padding: 18, marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <h3 style={{ fontSize: 14, margin: 0 }}>نتيجة فحص القناة</h3>
              <span className={`badge ${diagnosis.result.healthy ? "badge-good" : "badge-critical"}`}>
                {diagnosis.result.healthy ? "القناة تعمل" : "القناة متوقفة"}
              </span>
              <button className="btn btn-sm" type="button" onClick={() => setDiagnosis(null)} style={{ marginRight: "auto" }}>
                إغلاق
              </button>
            </div>
            <p style={{ margin: "0 0 12px", fontSize: 11.5, color: "var(--text-faint)" }}>
              فحص مباشر مع Meta بلا إرسال أي رسالة لأي عميل — {new Date(diagnosis.result.checkedAt).toLocaleString("ar-SA")}
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {diagnosis.result.checks.map((check) => (
                <div
                  key={check.key}
                  style={{
                    display: "flex",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                  }}
                >
                  <span
                    className={`badge ${
                      check.status === "ok" ? "badge-good" : check.status === "warn" ? "badge-warn" : "badge-critical"
                    }`}
                    style={{ height: "fit-content", whiteSpace: "nowrap" }}
                  >
                    {check.status === "ok" ? "سليم" : check.status === "warn" ? "تنبيه" : "عطل"}
                  </span>
                  <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
                    <b>{check.label}</b>
                    <div style={{ color: "var(--text-dim)" }}>{check.detail}</div>
                    {check.fix && <div style={{ marginTop: 4, color: "var(--text-dim)" }}>الحل: {check.fix}</div>}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 12, fontSize: 11.5, color: "var(--text-faint)", lineHeight: 1.9 }}>
              <div>
                رابط الويبهوك المتوقَّع في لوحة Meta:{" "}
                <code className="mono" style={{ wordBreak: "break-all" }}>
                  {diagnosis.result.webhook.callbackUrl}
                </code>
              </div>
              {diagnosis.result.tokenExpiresAt && (
                <div>انتهاء صلاحية التوكن: {new Date(diagnosis.result.tokenExpiresAt).toLocaleString("ar-SA")}</div>
              )}
            </div>

            {/* Meta's own words — present only for platform staff, and even
                then kept visually apart from the merchant-facing text. */}
            {diagnosis.result.staffOnly && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ fontSize: 11.5, color: "var(--text-faint)", cursor: "pointer" }}>
                  تفاصيل تقنية (طاقم المنصة فقط)
                </summary>
                <pre
                  className="mono"
                  style={{ fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text-dim)" }}
                >
                  {`HTTP ${diagnosis.result.staffOnly.httpStatus} · code=${diagnosis.result.staffOnly.code} · subcode=${diagnosis.result.staffOnly.subcode}\n${diagnosis.result.staffOnly.rawMetaError}`}
                </pre>
              </details>
            )}
          </div>
        )}

        {lastVerifyToken && (
          <div className="card ms-enter" style={{ padding: 16, marginBottom: 18, borderColor: "var(--good)", boxShadow: "0 8px 24px rgba(22,163,74,0.15)" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
              أدخل هذين في لوحة Meta (تبويب Configuration → Webhook) الآن — رمز التحقق لن يُعرض تلقائيًا مرة أخرى
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginBottom: 4 }}>Callback URL</div>
              <code className="mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>
                {BASE_URL}/v1/webhooks/channels/{lastVerifyToken.channelTypeKey}/{lastVerifyToken.channelId}
              </code>
            </div>
            <div>
              <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginBottom: 4 }}>Verify Token</div>
              <code className="mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>
                {lastVerifyToken.token}
              </code>
            </div>
          </div>
        )}

        <form onSubmit={connectChannel} className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            نوع القناة
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <BrandTile brand={channelTypeKey} sizePx={26} />
              <select
                style={{ flex: 1 }}
                value={channelTypeKey}
                onChange={(e) => {
                  setChannelTypeKey(e.target.value);
                  setChannelCreds({});
                }}
              >
                {CHANNEL_TYPES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </label>

          {channelTypeKey === "whatsapp" ? (
            <>
              {/* Meta Embedded Signup — لا معرفات ولا رموز تُطلب من المستخدم:
                  الزر يفتح معالج ميتا الرسمي، والخادم يكتشف WABA والرقم والرمز
                  ويشترك في الويبهوك تلقائيًا. */}
              <div style={{ fontSize: 12, color: "var(--text-dim)", background: "var(--surface-2)", padding: "10px 12px", borderRadius: 8 }}>
                اضغط «ربط واتساب» وستفتح نافذة ميتا الرسمية لتسجيل الدخول واختيار حساب
                واتساب الأعمال ورقم الهاتف — بلا أي معرفات أو رموز تُدخل يدويًا. بعد
                إتمام المعالج تُحفظ القناة وتُفعّل الويبهوك تلقائيًا.
              </div>
              <div>
                <button
                  className="btn btn-primary btn-sm"
                  type="button"
                  disabled={whatsappConnecting}
                  onClick={async () => {
                    if (!activeStore) return;
                    setWhatsappConnecting(true);
                    setChannelError(null);
                    try {
                      // The authorize URL is fetched (Bearer header) then the
                      // whole tab navigates into Meta's wizard. The flow comes
                      // back to /settings?connected=whatsapp or ?error=… .
                      const resp = await api.get<{ data: { url: string } }>(
                        `/v1/stores/${activeStore.id}/channels/whatsapp/connect`
                      );
                      window.location.href = resp.data.url;
                    } catch (err) {
                      setWhatsappConnecting(false);
                      setChannelError(err instanceof ApiClientError ? err.message : "تعذّر بدء ربط واتساب");
                    }
                  }}
                >
                  {whatsappConnecting ? "جارٍ الاتصال…" : "ربط واتساب"}
                </button>
              </div>
            </>
          ) : channelTypeKey !== "mock" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                معرّف الحساب الخارجي (Phone Number ID / Page ID)
                <input value={channelExternalId} onChange={(e) => setChannelExternalId(e.target.value)} required />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                اسم العرض
                <input value={channelDisplayName} onChange={(e) => setChannelDisplayName(e.target.value)} placeholder={`${channelDef.label} — ${activeStore.name}`} />
              </label>
            </div>
          )}

          {channelTypeKey !== "whatsapp" && channelDef.fields.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
              {channelDef.fields.map((f) => (
                <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                  {f.label}
                  <input
                    type="text"
                    value={channelCreds[f.key] ?? ""}
                    onChange={(e) => setChannelCreds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    required
                    placeholder={f.placeholder}
                  />
                </label>
              ))}
            </div>
          )}

          {channelError && <div style={{ color: "var(--critical)", fontSize: 13 }}>{channelError}</div>}
          {channelTypeKey !== "whatsapp" && (
            <div>
              <button className="btn btn-primary btn-sm" type="submit" disabled={channelSubmitting}>
                {channelSubmitting ? "جارٍ الربط…" : "ربط القناة"}
              </button>
            </div>
          )}
        </form>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>الرد الآلي بالذكاء الاصطناعي</h2>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>
          زر طوارئ خاص بهذا المتجر فقط — لا يؤثر على أي متجر آخر. عند الإيقاف تتوقف كل الردود التلقائية (واتساب،
          إنستغرام، ماسنجر، تيك توك، والمحاكاة) فورًا، وتبقى كل رسالة جديدة من العميل ظاهرة في صندوق الوارد بلا رد،
          إلى أن يردّ عليها أحد الموظفين يدويًا من نفس الشاشة، أو تُعاد تفعيل الذكاء الاصطناعي بنفس هذا الزر. مفيد إذا
          اشتكى عميل من رد أو ظهر خطأ وتريدون التأكد قبل استئناف الردود الآلية.
        </p>
        <div
          className="card"
          style={{
            padding: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            borderColor: agent?.status === "paused" ? "var(--critical)" : undefined,
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 4 }}>
              الحالة:{" "}
              <span className={`badge ${agent?.status === "paused" ? "badge-critical" : "badge-good"}`}>
                {agent?.status === "paused" ? "متوقف — الرد يدوي فقط" : "يعمل تلقائيًا"}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              {agent?.status === "paused"
                ? "الذكاء الاصطناعي متوقف عن الرد لهذا المتجر — الموظفون يردّون يدويًا من صندوق الوارد."
                : "الذكاء الاصطناعي يرد تلقائيًا على رسائل العملاء الجديدة حسب إعدادات الثقة أدناه."}
            </div>
          </div>
          <button
            className={`btn btn-sm ${agent?.status === "paused" ? "btn-good" : "btn-danger"}`}
            onClick={toggleAiPaused}
            disabled={!agent || togglingPause}
          >
            {togglingPause ? "جارٍ الحفظ…" : agent?.status === "paused" ? "إعادة تفعيل الرد الآلي" : "إيقاف الرد الآلي فورًا"}
          </button>
        </div>
        {pauseError && <div style={{ color: "var(--critical)", fontSize: 13, marginTop: 8 }}>{pauseError}</div>}
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>طبقة الذكاء الاصطناعي المتقدمة</h2>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>
          تتيح للذكاء الاصطناعي الاستعلام المباشر عن المنتجات والمخزون وحالة الطلبات الحقيقية، بدل الاعتماد فقط على
          نص قاعدة المعرفة. <b style={{ color: "var(--text)" }}>تنبيه:</b> تفعيلها يرفع تكلفة كل رسالة عميل فعليًا
          (استدعاءات إضافية على نفس اشتراك الذكاء الاصطناعي) — مطفأة افتراضيًا لكل المتاجر ولا تُفعَّل إلا بضغطة هذا
          الزر.
        </p>
        <div
          className="card"
          style={{ padding: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 4 }}>
              الحالة:{" "}
              <span className={`badge ${agent?.advancedIntelligenceEnabled ? "badge-good" : "badge-neutral"}`}>
                {agent?.advancedIntelligenceEnabled ? "مفعّلة" : "غير مفعّلة (الوضع الافتراضي الأرخص)"}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              {agent?.advancedIntelligenceEnabled
                ? "المحادثات الحقيقية والمحاكاة تستخدم الآن البحث الحي في المنتجات والطلبات."
                : "المحادثات تستخدم قاعدة المعرفة النصية فقط، بأقل تكلفة ممكنة."}
            </div>
          </div>
          <button
            className={`btn btn-sm ${agent?.advancedIntelligenceEnabled ? "btn-danger" : "btn-good"}`}
            onClick={toggleAdvancedIntelligence}
            disabled={!agent || togglingAdvanced}
          >
            {togglingAdvanced ? "جارٍ الحفظ…" : agent?.advancedIntelligenceEnabled ? "إيقاف" : "تفعيل"}
          </button>
        </div>
        {advancedError && <div style={{ color: "var(--critical)", fontSize: 13, marginTop: 8 }}>{advancedError}</div>}
      </section>

      <section>
        <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>التكاملات</h2>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>سلة، زد، Shopify، WooCommerce.</p>

        {oauthError && (
          <div className="card" style={{ padding: 14, marginBottom: 18, color: "var(--critical)", fontSize: 12.5, borderColor: "var(--critical)" }}>
            فشل ربط المنصة: {oauthError}
          </div>
        )}

        {oauthSuccess && (
          <div className="card" style={{ padding: 14, marginBottom: 18, color: "var(--good)", fontSize: 12.5, borderColor: "var(--good)" }}>
            تم ربط {oauthSuccess} بنجاح
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14, marginBottom: 18 }}>
          {integrations.map((i, idx) => (
            <div key={i.id} className="card card-hover ms-enter" style={{ padding: 16, animationDelay: `${Math.min(idx, 6) * 40}ms` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <BrandTile brand={i.platform} />
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{i.platform}</span>
              </div>
              <span className={`badge ${i.status === "connected" ? "badge-good" : "badge-critical"}`}>{i.status}</span>
              <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 10 }}>
                {i.lastSyncedAt ? `آخر مزامنة: ${new Date(i.lastSyncedAt).toLocaleString("ar-SA")}` : "لم تتم المزامنة بعد"}
              </div>
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 10, width: "100%" }}
                disabled={syncingId === i.id}
                onClick={() => syncIntegration(i)}
              >
                {syncingId === i.id ? "جارٍ المزامنة…" : "مزامنة الآن (الطلبات والمنتجات)"}
              </button>
              {syncResult?.id === i.id && (
                <div style={{ fontSize: 11.5, color: "var(--good)", marginTop: 6 }}>
                  تمت مزامنة {syncResult.orders} طلب و{syncResult.products} منتج.
                </div>
              )}
            </div>
          ))}
          {syncError && <div style={{ color: "var(--critical)", fontSize: 12.5, gridColumn: "1 / -1" }}>{syncError}</div>}
        </div>

        <form onSubmit={connectIntegration} className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
            المنصة
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <BrandTile brand={platformKey} sizePx={26} />
              <select
                style={{ flex: 1 }}
                value={platformKey}
                onChange={(e) => {
                  setPlatformKey(e.target.value);
                  setPlatformCreds({});
                }}
              >
                {PLATFORMS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </label>

          {platformDef.supportsOAuth && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", background: "var(--surface-2)", padding: "10px 12px", borderRadius: 8 }}>
              هذه المنصة تدعم الربط عبر OAuth — اضغط على الزر أدناه للاتصال بحسابك على {platformDef.label} بشكل آمن.
            </div>
          )}

          {platformDef.supportsOAuth ? (
            <div>
              <button
                className="btn btn-primary btn-sm"
                type="button"
                onClick={() => {
                  if (!activeStore) return;
                  window.location.href = `${BASE_URL}/v1/stores/${activeStore.id}/integrations/${platformKey}/connect`;
                }}
              >
                ربط عبر {platformDef.label}
              </button>
            </div>
          ) : (
            <>
              {platformDef.fields.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
                  {platformDef.fields.map((f) => (
                    <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                      {f.label}
                      <input
                        type="text"
                        value={platformCreds[f.key] ?? ""}
                        onChange={(e) => setPlatformCreds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                        required
                        placeholder={f.placeholder}
                      />
                    </label>
                  ))}
                </div>
              )}

              {platformError && <div style={{ color: "var(--critical)", fontSize: 13 }}>{platformError}</div>}
              <div>
                <button className="btn btn-primary btn-sm" type="submit" disabled={platformSubmitting}>
                  {platformSubmitting ? "جارٍ الربط…" : "ربط المنصة"}
                </button>
              </div>
            </>
          )}
        </form>
      </section>
    </div>
  );
}
