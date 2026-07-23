import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { StoreProvider } from "./context/StoreContext";
import { AppShell } from "./components/AppShell";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { InboxPage } from "./pages/InboxPage";
import { KnowledgePage } from "./pages/KnowledgePage";
import { TicketsPage } from "./pages/TicketsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SimulationPage } from "./pages/SimulationPage";
import { SimulatePage } from "./pages/SimulatePage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { InstallBanner } from "./pwa/InstallBanner";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <div style={{ padding: 40 }}>جارٍ التحميل…</div>;
  if (!me) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Shell() {
  const { me } = useAuth();
  return (
    <StoreProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/simulation" element={<SimulationPage />} />
          <Route path="/tickets" element={<TicketsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to={me?.isOwner ? "/overview" : "/inbox"} replace />} />
        </Route>
      </Routes>
      <InstallBanner />
    </StoreProvider>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/simulate/:token" element={<SimulatePage />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <Shell />
            </RequireAuth>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
