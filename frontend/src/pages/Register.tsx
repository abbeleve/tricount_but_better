import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../components/Layout";
import { Button, Card, Field, FormError, Input } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { ApiError } from "../lib/api";

const MIN_PASSWORD = 10;

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (tooShort) return;
    setError(null);
    setBusy(true);
    try {
      await register(email, name, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-body">Create an account</h1>
      <p className="mb-6 text-sm text-muted">Then invite the people you live with.</p>

      <Card className="p-5">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <FormError message={error} />
          <Field label="Your name" hint="This is how your flatmates will see you.">
            {(id) => (
              <Input
                id={id}
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Andrey"
              />
            )}
          </Field>
          <Field label="Email">
            {(id) => (
              <Input
                id={id}
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            )}
          </Field>
          <Field
            label="Password"
            hint={`At least ${MIN_PASSWORD} characters.`}
            error={tooShort ? `Use at least ${MIN_PASSWORD} characters.` : undefined}
          >
            {(id) => (
              <Input
                id={id}
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" loading={busy} disabled={tooShort} full>
            Create account
          </Button>
        </form>
      </Card>

      <p className="mt-5 text-center text-sm text-muted">
        Already have one?{" "}
        <Link to="/login" className="font-medium text-body underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
