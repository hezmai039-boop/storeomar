import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { ChannelAccount, Integration } from "../api/types";
import { useStore } from "../context/StoreContext";

const CHANNEL_TYPES = ["whatsapp", "instagram", "messenger", "tiktok", "mock"];
const PLATFORMS = ["salla", "zid", "shopify", "woocommerce", "mock"];

export function SettingsPage() {
  const { activeStore } = useStore();
  const [channels, setChannels] = useState<ChannelAccount[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [newChannelType, setNewChannelType] = useState(CHANNEL_TYPES[0]);
  const [newPlatform, setNewPlatform] = useState(PLATFORMS[0]);

  const reload = useCallback(() => {
    if (!activeStore) return;
    api.get<{ data: ChannelAccount[] }>(`/v1/stores/${activeStore.id}/channel-accounts`).then((r) => setChannels(r.data));
    api.get<{ data: Integration[] }>(`/v1/stores/${activeStore.id}/integrations`).then((r) => setIntegrations(r.data));
  }, [activeStore]);

  useEffect(() => reload(), [reload]);

  if (!activeStore) return <div style={{ color: "var(--text-dim)" }}>اختر متجرًا من القائمة الجانبية أولًا.</div>;

  async function connectChannel() {
    if (!activeStore) return;
    await api.post(`/v1/stores/${activeStore.id}/channel-accounts`, {
      channelTypeKey: newChannelType,
      externalAccountId: `manual-${Date.now()}`,
      displayName: `${newChannelType} — ${activeStore!.name}`,
      credentials: {},
    });
    reload();
  }

  async function connectIntegration() {
    if (!activeStore) return;
    await api.post(`/v1/stores/${activeStore.id}/integrations`, { platform: newPlatform, credentials: {} });
    reload();
  }

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>الإعدادات</h1>
        <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13.5 }}>{activeStore.name} — القنوات والتكاملات</p>
      </div>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>القنوات</h2>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>
          الربط الفعلي يمر عبر OAuth الرسمي لكل منصة؛ النموذج أدناه يسجّل بيانات اعتماد فارغة لأغراض العرض فقط.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14, marginBottom: 14 }}>
          {channels.map((c) => (
            <div key={c.id} className="card" style={{ padding: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>{c.displayName}</div>
              <span className={`badge ${c.status === "connected" ? "badge-good" : "badge-critical"}`}>{c.status}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={newChannelType} onChange={(e) => setNewChannelType(e.target.value)}>
            {CHANNEL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-sm" onClick={connectChannel}>
            ربط قناة
          </button>
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>التكاملات</h2>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>سلة، زد، Shopify، WooCommerce.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14, marginBottom: 14 }}>
          {integrations.map((i) => (
            <div key={i.id} className="card" style={{ padding: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>{i.platform}</div>
              <span className={`badge ${i.status === "connected" ? "badge-good" : "badge-critical"}`}>{i.status}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={newPlatform} onChange={(e) => setNewPlatform(e.target.value)}>
            {PLATFORMS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-sm" onClick={connectIntegration}>
            ربط المنصة
          </button>
        </div>
      </section>
    </div>
  );
}
