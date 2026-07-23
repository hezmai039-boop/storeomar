import { useInstallPrompt } from "./useInstallPrompt";

/**
 * A slim, dismissible "add to home screen" banner. Renders nothing unless
 * the browser actually offers an install prompt, so it's invisible on
 * desktop/unsupported browsers and once the app is installed.
 */
export function InstallBanner() {
  const { canInstall, promptInstall, dismiss } = useInstallPrompt();
  if (!canInstall) return null;

  return (
    <div
      role="dialog"
      aria-label="تثبيت تطبيق Atlas"
      style={{
        position: "fixed",
        insetInlineStart: 12,
        insetInlineEnd: 12,
        bottom: 12,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderRadius: 14,
        background: "var(--surface, #fff)",
        border: "1px solid var(--border, #e5defa)",
        boxShadow: "0 20px 56px rgba(45, 20, 90, 0.22)",
        maxWidth: 440,
        marginInline: "auto",
      }}
    >
      <img src="/icon.svg" alt="" width={40} height={40} style={{ borderRadius: 10, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text, #1b1330)" }}>ثبّت تطبيق Atlas</div>
        <div style={{ fontSize: 12, color: "var(--text-dim, #675e80)" }}>
          أضِفه لشاشتك الرئيسية لفتحه كتطبيق مستقل واستقبال المحادثات أسرع.
        </div>
      </div>
      <button
        onClick={promptInstall}
        style={{
          background: "var(--primary, #7c3aed)",
          color: "#fff",
          border: "none",
          borderRadius: 999,
          padding: "8px 16px",
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        تثبيت
      </button>
      <button
        onClick={dismiss}
        aria-label="إغلاق"
        style={{
          background: "none",
          border: "none",
          color: "var(--text-faint, #9891ac)",
          fontSize: 18,
          cursor: "pointer",
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
