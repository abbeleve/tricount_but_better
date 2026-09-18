import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Avatar, Button, Card, Chip, FormError, Money, Skeleton } from "./ui";
import { keys, useBalances, useInvites } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { ApiError, api } from "../lib/api";
import type { Invite, TeamDetail } from "../lib/types";

function InviteRow({ invite, teamId, canRevoke }: { invite: Invite; teamId: string; canRevoke: boolean }) {
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/join/${invite.code}`;

  const revoke = useMutation({
    mutationFn: () => api<void>(`/teams/${teamId}/invites/${invite.id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.invites(teamId) }),
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is blocked on insecure origins; select the text instead.
      window.prompt("Copy this invite link", url);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2 py-3 first:pt-0">
      <code className="min-w-0 flex-1 truncate rounded-control bg-surface-2 px-2.5 py-1.5 text-[12px] text-muted">
        {url}
      </code>
      {invite.revoked ? (
        <Chip>expired</Chip>
      ) : (
        <>
          <Button size="sm" variant="secondary" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
          {canRevoke && (
            <Button size="sm" variant="ghost" loading={revoke.isPending} onClick={() => revoke.mutate()}>
              Revoke
            </Button>
          )}
        </>
      )}
    </li>
  );
}

export function PeopleTab({ team }: { team: TeamDetail }) {
  const { user } = useAuth();
  const client = useQueryClient();
  const navigate = useNavigate();
  const invites = useInvites(team.id);
  const balances = useBalances(team.id);
  const isOwner = team.my_role === "owner";

  const createInvite = useMutation({
    mutationFn: () => api<Invite>(`/teams/${team.id}/invites`, { body: { expires_in_days: 14 } }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.invites(team.id) }),
  });

  const leave = useMutation({
    mutationFn: () =>
      api<void>(`/teams/${team.id}/members/${user?.id}`, { method: "DELETE" }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: keys.teams });
      navigate("/");
    },
  });

  const netOf = (id: string) => balances.data?.balances.find((b) => b.user_id === id)?.net ?? 0;
  const active = invites.data?.filter((i) => !i.revoked) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <h2 className="mb-4 text-sm font-semibold text-body">
          {team.members.length} {team.members.length === 1 ? "person" : "people"}
        </h2>
        <ul className="flex flex-col divide-y divide-line">
          {team.members.map((member) => (
            <li key={member.user_id} className="flex items-center gap-3 py-3 first:pt-0">
              <Avatar name={member.display_name} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm font-medium text-body">
                  {member.display_name}
                  {member.user_id === user?.id && (
                    <span className="text-[12px] font-normal text-subtle">you</span>
                  )}
                  {member.role === "owner" && <Chip>owner</Chip>}
                </p>
                <p className="truncate text-[12px] text-muted">{member.email}</p>
              </div>
              {balances.data && (
                <Money minor={netOf(member.user_id)} currency={team.currency} signed className="text-sm" />
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-5">
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-body">Invite links</h2>
          {isOwner && (
            <Button size="sm" variant="secondary" loading={createInvite.isPending} onClick={() => createInvite.mutate()}>
              New link
            </Button>
          )}
        </div>
        <p className="mb-4 text-[13px] text-muted">
          Anyone with an active link can join this team. Links expire after 14 days.
        </p>

        <FormError message={createInvite.error instanceof ApiError ? createInvite.error.message : null} />

        {invites.isPending && <Skeleton className="h-9 w-full" />}
        {invites.data && active.length === 0 && (
          <p className="text-sm text-muted">
            {isOwner ? "No active links. Create one to add someone." : "No active links right now."}
          </p>
        )}
        {active.length > 0 && (
          <ul className="flex flex-col divide-y divide-line">
            {active.map((invite) => (
              <InviteRow key={invite.id} invite={invite} teamId={team.id} canRevoke={isOwner} />
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold text-body">Leave this team</h2>
        <p className="mb-4 text-[13px] text-muted">
          You can only leave once your balance is zero, so nobody inherits your share.
        </p>
        <FormError message={leave.error instanceof ApiError ? leave.error.message : null} />
        <Button
          variant="danger"
          loading={leave.isPending}
          onClick={() => leave.mutate()}
          disabled={netOf(user?.id ?? "") !== 0}
        >
          Leave {team.name}
        </Button>
      </Card>
    </div>
  );
}
