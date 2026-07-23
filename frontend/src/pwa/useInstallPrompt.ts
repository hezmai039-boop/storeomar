import { useEffect, useState } from "react";

// The `beforeinstallprompt` event isn't in the standard TS DOM lib yet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "atlas_pwa_install_dismissed";

/**
 * Surfaces a custom "install app" affordance when the browser offers one,
 * and remembers a dismissal so we don't nag. Returns null-safe state the UI
 * can render conditionally — no effect at all on browsers/platforms that
 * don't fire the event (the app just runs as a normal web page there).
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    // Already running as an installed app (standalone display mode).
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // iOS Safari exposes navigator.standalone instead.
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) {
      setInstalled(true);
      return;
    }

    const onPrompt = (e: Event) => {
      e.preventDefault(); // stop Chrome's default mini-infobar; we show our own
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismissed = typeof localStorage !== "undefined" && localStorage.getItem(DISMISS_KEY) === "1";

  async function promptInstall() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  }

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    setDeferred(null);
  }

  return {
    /** True only when the browser has a real install prompt ready and the user hasn't dismissed it. */
    canInstall: !!deferred && !dismissed && !installed,
    installed,
    promptInstall,
    dismiss,
  };
}
