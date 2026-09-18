import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import ExpenseForm from "./pages/ExpenseForm";
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
  const location = useLocation();

  if (!ready) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg">
        <span className="sr-only">Loading</span>
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
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<RedirectIfSignedIn><Login /></RedirectIfSignedIn>} />
            <Route path="/register" element={<RedirectIfSignedIn><Register /></RedirectIfSignedIn>} />
            <Route path="/" element={<RequireAuth><Teams /></RequireAuth>} />
            <Route path="/teams/:teamId" element={<RequireAuth><TeamDetail /></RequireAuth>} />
            <Route
              path="/teams/:teamId/expenses/new"
              element={<RequireAuth><ExpenseForm /></RequireAuth>}
            />
            <Route
              path="/teams/:teamId/expenses/:expenseId"
              element={<RequireAuth><ExpenseForm /></RequireAuth>}
            />
            <Route path="/join/:code" element={<RequireAuth><JoinTeam /></RequireAuth>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </Router>
    </QueryClientProvider>
  );
}
