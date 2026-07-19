import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiClientError, BASE_URL } from "../api/client";
import type { AiAgent, ChannelAccount, Integration } from "../api/types";
import { useStore } from "../context/StoreContext";
import { useAuth } from "../context/AuthContext";
import { BrandTile } from "../components/BrandIcons";

interface CredentialField {
  key: string;
  label: string;
  placeholder?: string;
}

const CHANNEL_TYPES: Array<{ key: string; label: string; fields: CredentialField[] }> = [
  {
    key: "whatsapp",
    label: "واتساب",
    fields: [
      { key: "phoneNumberId", label: "Phone Number ID" },
      { key: "accessToken", label: "Access Token" },
    ],
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

const PLATFORMS: Array<{ key: string; label: string; fields: CredentialField[] }> = [
  { key: "salla", label: "سلة", fields: [{ key: "accessToken", label: "Access Token" }] },
  {
    key: "zid",
    label: "زد",
    fields: [
      { key: "accessToken", label: "Access Token" },
      { key: "managerToken", label: "Manager Token" },
    ],
  },
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
  const [lastVerifyToken, setLastVerifyToken] = useState<{ channelId: string; channelTypeKey: string; token: string } | null>(null);

  const [platformKey, setPlatformKey] = useState(PLATFORMS[0].key);
  const [platformCreds, setPlatformCreds] = useState<Record<string, string>>({});
  const [platformSubmitting, setPlatformSubmitting] = useState(false);
  const [platformError, setPlatformError] = useState<string | null>(null);

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
      if (resp.data.webhookVerifyToken) {
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14, marginBottom: 18 }}>
          {channels.map((c, i) => (
            <div key={c.id} className="card card-hover atlas-enter" style={{ padding: 16, animationDelay: `${Math.min(i, 6) * 40}ms` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <BrandTile brand={c.channelType.key} />
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{c.displayName}</span>
              </div>
              <span className={`badge ${c.status === "connected" ? "badge-good" : "badge-critical"}`}>{c.status}</span>
            </div>
          ))}
        </div>

        {lastVerifyToken && (
          <div className="card atlas-enter" style={{ padding: 16, marginBottom: 18, borderColor: "var(--good)", boxShadow: "0 8px 24px rgba(22,163,74,0.15)" }}>
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

          {channelTypeKey !== "mock" && (
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

          {channelDef.fields.length > 0 && (
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
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={channelSubmitting}>
              {channelSubmitting ? "جارٍ الربط…" : "ربط القناة"}
            </button>
          </div>
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14, marginBottom: 18 }}>
          {integrations.map((i, idx) => (
            <div key={i.id} className="card card-hover atlas-enter" style={{ padding: 16, animationDelay: `${Math.min(idx, 6) * 40}ms` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <BrandTile brand={i.platform} />
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{i.platform}</span>
              </div>
              <span className={`badge ${i.status === "connected" ? "badge-good" : "badge-critical"}`}>{i.status}</span>
            </div>
          ))}
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
        </form>
      </section>
    </div>
  );
}
