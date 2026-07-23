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
import { StoresAdminPage } from "./pages/StoresAdminPage";
import { LandingPage } from "./pages/LandingPage";
import { InstallBanner } from "./pwa/InstallBanner";
import { usePermissions, PERMISSIONS, PermissionKey } from "./lib/permissions";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <div style={{ padding: 40 }}>جارٍ التحميل…</div>;
  if (!me) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// Backstop for role-scoped pages: the nav already hides these links from
// users without the permission, but a direct URL visit must not render a page
// whose every action would 403. Shows a clean message instead.
function RequirePermission({ permission, children }: { permission: PermissionKey; children: React.ReactNode }) {
  const { can } = usePermissions();
  if (!can(permission)) {
    return (
      <div style={{ padding: 40, color: "var(--text-dim)", fontSize: 14 }}>
        هذه الصفحة غير متاحة لصلاحيتك. تواصل مع مدير المتجر إن كنت تحتاج الوصول إليها.
      </div>
    );
  }
  return <>{children}</>;
}

function Shell() {
  const { me } = useAuth();
  return (
    <StoreProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/stores" element={<StoresAdminPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route
            path="/simulation"
            element={
              <RequirePermission permission={PERMISSIONS.SIMULATION_MANAGE}>
                <SimulationPage />
              </RequirePermission>
            }
          />
          <Route path="/tickets" element={<TicketsPage />} />
          <Route
            path="/settings"
            element={
              <RequirePermission permission={PERMISSIONS.SETTINGS_MANAGE}>
                <SettingsPage />
              </RequirePermission>
            }
          />
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
        {/* Public marketing landing at the root. React Router ranks the exact
            "/" above the "/*" authed catch-all, so the dashboard is untouched;
            logged-out visitors see the landing instead of being bounced to
            /login. */}
        <Route path="/" element={<LandingPage />} />
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
