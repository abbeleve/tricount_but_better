import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { AppShell, PageTitle } from "../components/Layout";
import { Button, Card, ErrorState, FormError, Skeleton } from "../components/ui";
import { keys } from "../hooks/queries";
import { ApiError, api } from "../lib/api";
import type { InvitePreview, TeamDetail } from "../lib/types";
import { useQueryClient } from "@tanstack/react-query";

export default function JoinTeam() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();

  const preview = useQuery({
    queryKey: ["invite", code],
    queryFn: () => api<InvitePreview>(`/invites/${code}`),
    retry: false,
  });

  const join = useMutation({
    mutationFn: () => api<TeamDetail>(`/invites/${code}/accept`, { method: "POST" }),
    onSuccess: (team) => {
      client.invalidateQueries({ queryKey: keys.teams });
      navigate(`/teams/${team.id}`, { replace: true });
    },
  });

  return (
    <AppShell>
      <div className="mx-auto max-w-md">
        <PageTitle title="Join a team" />

        {preview.isPending && (
          <Card className="flex flex-col gap-3 p-5">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-10 w-full" />
          </Card>
        )}

        {preview.isError && (
          <Card>
            <ErrorState
              message={
                preview.error instanceof ApiError
                  ? preview.error.message
                  : "This invite link could not be checked."
              }
            />
          </Card>
        )}

        {preview.data && (
          <Card className="flex flex-col gap-4 p-5">
            <div>
              <p className="text-sm text-muted">You have been invited to</p>
              <p className="mt-1 text-xl font-semibold tracking-tight text-body">
                {preview.data.team_name}
              </p>
              <p className="mt-1 text-sm text-muted">
                {preview.data.member_count}{" "}
                {preview.data.member_count === 1 ? "person" : "people"} · settles in{" "}
                {preview.data.currency}
              </p>
            </div>
            <FormError
              message={join.error instanceof ApiError ? join.error.message : null}
            />
            <Button onClick={() => join.mutate()} loading={join.isPending} full>
              Join team
            </Button>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
