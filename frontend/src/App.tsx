import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from "react-router-dom";
import { LanguageProvider, useI18n } from "./lib/i18n";
import { AppearanceProvider } from "./hooks/useAppearance";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import Appearance from "./pages/Appearance";
import ExpenseForm from "./pages/ExpenseForm";
import PlanForm from "./pages/PlanForm";
import JoinTeam from "./pages/JoinTeam";
import Login from "./pages/Login";
import Register from "./pages/Register";
import TeamDetail from "./pages/TeamDetail";
import Teams from "./pages/Teams";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // A 401 is handled by the client's refresh logic; retrying it is noise.
      retry: (count, error) =>
        count < 2 && !(error instanceof Error && error.name === "ApiError"),
    },
  },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const { t } = useI18n();
  const location = useLocation();

  if (!ready) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <span className="sr-only">{t("Loading")}</span>
      </div>
    );
  }
  // Remember where they were headed so the invite link still works after login.
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function RedirectIfSignedIn({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  if (ready && user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <LanguageProvider>
          <AuthProvider>
            <AppearanceProvider>
              <Routes>
                <Route path="/login" element={<RedirectIfSignedIn><Login /></RedirectIfSignedIn>} />
                <Route path="/register" element={<RedirectIfSignedIn><Register /></RedirectIfSignedIn>} />
                <Route path="/" element={<RequireAuth><Teams /></RequireAuth>} />
                <Route path="/teams/:teamId" element={<RequireAuth><TeamDetail /></RequireAuth>} />
                <Route path="/teams/:teamId/plans/new" element={<RequireAuth><PlanForm /></RequireAuth>} />
                <Route path="/teams/:teamId/plans/:planId" element={<RequireAuth><PlanForm /></RequireAuth>} />
                <Route
                  path="/teams/:teamId/expenses/new"
                  element={<RequireAuth><ExpenseForm /></RequireAuth>}
                />
                <Route
                  path="/teams/:teamId/expenses/:expenseId"
                  element={<RequireAuth><ExpenseForm /></RequireAuth>}
                />
                <Route path="/join/:code" element={<RequireAuth><JoinTeam /></RequireAuth>} />
                <Route path="/appearance" element={<RequireAuth><Appearance /></RequireAuth>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppearanceProvider>
          </AuthProvider>
        </LanguageProvider>
      </Router>
    </QueryClientProvider>
  );
}
