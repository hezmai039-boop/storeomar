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
import { AccountPage } from "./pages/AccountPage";
import { BillingPage } from "./pages/BillingPage";
import { LandingPage } from "./pages/LandingPage";
import { LegalPage } from "./pages/LegalPage";
import { SignupPage } from "./pages/SignupPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
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
          <Route path="/account" element={<AccountPage />} />
          <Route
            path="/billing"
            element={
              <RequirePermission permission={PERMISSIONS.BILLING_VIEW}>
                <BillingPage />
              </RequirePermission>
            }
          />
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
        {/* Must be reachable logged OUT: Salla's and Zid's app reviews and
            every payment provider require a publicly fetchable privacy URL,
            and a reviewer hitting a login wall fails the submission. Placed
            above the "/*" authed catch-all for that reason. LegalPage picks
            which document to render from the pathname itself. */}
        <Route path="/privacy" element={<LegalPage />} />
        <Route path="/terms" element={<LegalPage />} />
        {/* Self-serve auth. All four must sit above the "/*" authed
            catch-all: every one of them is reached by someone who has no
            session (a new visitor, or a reset link opened in the phone's
            mail app rather than the browser holding the login). */}
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
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
