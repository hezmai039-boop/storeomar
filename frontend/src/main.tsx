import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
// Faces first, tokens second: tokens.css names "Tajawal"/"Inter" in
// --font-body, and a family referenced before its @font-face is declared
// resolves to the next fallback for that first paint.
import "./styles/fonts.css";
import "./styles/tokens.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// Register the PWA service worker (offline shell + installability). Guarded
// so a registration failure can never block the app from rendering, and
// only in production builds — during `vite dev` an aggressive SW cache just
// gets in the way of hot reload.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
