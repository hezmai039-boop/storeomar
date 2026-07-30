import { LogoMark } from "../components/Logo";
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
      aria-label="تثبيت تطبيق ميسور"
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
        border: "1px solid var(--border, #dde5ee)",
        boxShadow: "0 20px 56px rgba(13, 44, 77, 0.2)",
        maxWidth: 440,
        marginInline: "auto",
      }}
    >
      {/* The component, not /icon.svg: same geometry, but this one cannot
          drift from the rest of the app or 404 while offline. */}
      <LogoMark size={40} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text, #0d2c4d)" }}>ثبّت تطبيق ميسور</div>
        <div style={{ fontSize: 12, color: "var(--text-dim, #4a6480)" }}>
          أضِفه لشاشتك الرئيسية لفتحه كتطبيق مستقل واستقبال المحادثات أسرع.
        </div>
      </div>
      {/* btn-accent, not a hand-rolled orange: it puts NAVY on the orange
          (4.93:1). White on #FF6A00 is 2.87:1 and fails AA outright. */}
      <button className="btn btn-accent" onClick={promptInstall} style={{ flexShrink: 0 }}>
        تثبيت
      </button>
      <button
        onClick={dismiss}
        aria-label="إغلاق"
        style={{
          background: "none",
          border: "none",
          color: "var(--text-faint, #8399ae)",
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
