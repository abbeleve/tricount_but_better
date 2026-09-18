import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AppShell, PageTitle } from "../components/Layout";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  Money,
  Select,
  Skeleton,
} from "../components/ui";
import { keys, useServerConfig, useTeams } from "../hooks/queries";
import { ApiError, api } from "../lib/api";
import type { TeamDetail, TeamSummary } from "../lib/types";

const CURRENCIES = ["RUB", "USD", "EUR", "GBP", "KZT", "GEL", "RSD", "TRY"];

function balanceLabel(minor: number): string {
  if (minor === 0) return "All settled";
  return minor > 0 ? "you are owed" : "you owe";
}

function TeamCard({ team }: { team: TeamSummary }) {
  return (
    <Link
      to={`/teams/${team.id}`}
      className="card group flex items-center justify-between gap-4 p-4 transition-all hover:border-line-strong active:translate-y-px"
    >
      <div className="min-w-0">
        <p className="truncate font-medium text-body">{team.name}</p>
        <p className="mt-0.5 text-[13px] text-muted">
          {team.member_count} {team.member_count === 1 ? "person" : "people"}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <Money minor={team.my_balance} currency={team.currency} signed className="text-base font-medium" />
        <p className="mt-0.5 text-[12px] text-muted">{balanceLabel(team.my_balance)}</p>
      </div>
    </Link>
  );
}

function NewTeamForm({ onDone }: { onDone: () => void }) {
  const client = useQueryClient();
  const config = useServerConfig();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState(config.data?.default_currency ?? "RUB");

  const create = useMutation({
    mutationFn: () => api<TeamDetail>("/teams", { body: { name, currency } }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: keys.teams });
      onDone();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <Card className="p-5">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormError message={create.error instanceof ApiError ? create.error.message : null} />
        <Field label="Team name" hint="A flat, a trip, a household — whatever you share.">
          {(id) => (
            <Input
              id={id}
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Flat 42"
            />
          )}
        </Field>
        <Field label="Currency" hint="Everything in this team is tracked in one currency.">
          {(id) => (
            <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex gap-2">
          <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
            Create team
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function Teams() {
  const teams = useTeams();
  const [creating, setCreating] = useState(false);

  return (
    <AppShell>
      <PageTitle
        title="Your teams"
        subtitle="Everyone you split costs with."
        action={
          !creating && teams.data?.length ? (
            <Button onClick={() => setCreating(true)}>New team</Button>
          ) : undefined
        }
      />

      {creating && (
        <div className="mb-4">
          <NewTeamForm onDone={() => setCreating(false)} />
        </div>
      )}

      {teams.isPending && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex items-center justify-between p-4">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="h-5 w-24" />
            </Card>
          ))}
        </div>
      )}

      {teams.isError && (
        <Card>
          <ErrorState
            message={teams.error instanceof ApiError ? teams.error.message : "Could not load your teams."}
            onRetry={() => teams.refetch()}
          />
        </Card>
      )}

      {teams.data && teams.data.length === 0 && !creating && (
        <Card>
          <EmptyState
            title="No teams yet"
            body="Create one for your flat, then send the invite link to the people you live with. Everything you add gets split between whoever was actually in on it."
            action={<Button onClick={() => setCreating(true)}>Create your first team</Button>}
          />
        </Card>
      )}

      {teams.data && teams.data.length > 0 && (
        <div className="flex flex-col gap-3">
          {teams.data.map((team) => (
            <TeamCard key={team.id} team={team} />
          ))}
        </div>
      )}
    </AppShell>
  );
}
