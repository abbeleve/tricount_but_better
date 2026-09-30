import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../components/Layout";
import { Button, Card, Field, FormError, Input } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { ApiError } from "../lib/api";
import { useI18n } from "../lib/i18n";

export default function Login() {
  const { t } = useI18n();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-body">{t("Welcome back")}</h1>
      <p className="mb-6 text-sm text-muted">{t("Sign in to see what your flat owes you.")}</p>

      <Card className="p-4 sm:p-5">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <FormError message={error} />
          <Field label={t("Email")}>
            {(id) => (
              <Input
                id={id}
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            )}
          </Field>
          <Field label={t("Password")}>
            {(id) => (
              <Input
                id={id}
                type="password"
                autoComplete="current-password"
                enterKeyHint="go"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" loading={busy} full>
            {t("Sign in")}
          </Button>
        </form>
      </Card>

      <p className="mt-5 text-center text-sm text-muted">
        {t("No account yet?")}{" "}
        <Link to="/register" className="font-medium text-body underline underline-offset-4">
          {t("Create one")}
        </Link>
      </p>
    </AuthShell>
  );
}
