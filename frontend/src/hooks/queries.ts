/** Server state. One key namespace per resource so invalidation stays obvious. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type {
  Balances,
  Category,
  CategoryTotal,
  Expense,
  ExpenseList,
  Invite,
  Receipt,
  ServerConfig,
  Settlement,
  TeamDetail,
  TeamSummary,
} from "../lib/types";

export const keys = {
  config: ["config"] as const,
  teams: ["teams"] as const,
  team: (id: string) => ["team", id] as const,
  members: (id: string) => ["team", id, "members"] as const,
  balances: (id: string) => ["team", id, "balances"] as const,
  categories: (id: string) => ["team", id, "categories"] as const,
  categoryTotals: (id: string) => ["team", id, "category-totals"] as const,
  expenses: (id: string) => ["team", id, "expenses"] as const,
  expense: (id: string, eid: string) => ["team", id, "expense", eid] as const,
  settlements: (id: string) => ["team", id, "settlements"] as const,
  invites: (id: string) => ["team", id, "invites"] as const,
  receipt: (id: string, rid: string) => ["team", id, "receipt", rid] as const,
};

export const useServerConfig = () =>
  useQuery({
    queryKey: keys.config,
    queryFn: () => api<ServerConfig>("/config"),
    staleTime: Infinity,
  });

export const useTeams = () =>
  useQuery({ queryKey: keys.teams, queryFn: () => api<TeamSummary[]>("/teams") });

export const useTeam = (teamId: string) =>
  useQuery({ queryKey: keys.team(teamId), queryFn: () => api<TeamDetail>(`/teams/${teamId}`) });

export const useBalances = (teamId: string) =>
  useQuery({
    queryKey: keys.balances(teamId),
    queryFn: () => api<Balances>(`/teams/${teamId}/balances`),
  });

export const useCategories = (teamId: string) =>
  useQuery({
    queryKey: keys.categories(teamId),
    queryFn: () => api<Category[]>(`/teams/${teamId}/categories`),
  });

export const useCategoryTotals = (teamId: string) =>
  useQuery({
    queryKey: keys.categoryTotals(teamId),
    queryFn: () => api<CategoryTotal[]>(`/teams/${teamId}/category-totals`),
  });

export const useExpenses = (teamId: string, search: string) =>
  useQuery({
    queryKey: [...keys.expenses(teamId), search],
    queryFn: () =>
      api<ExpenseList>(
        `/teams/${teamId}/expenses?limit=100${search ? `&q=${encodeURIComponent(search)}` : ""}`,
      ),
  });

export const useExpense = (teamId: string, expenseId: string | undefined) =>
  useQuery({
    queryKey: keys.expense(teamId, expenseId ?? ""),
    queryFn: () => api<Expense>(`/teams/${teamId}/expenses/${expenseId}`),
    enabled: Boolean(expenseId),
  });

export const useSettlements = (teamId: string) =>
  useQuery({
    queryKey: keys.settlements(teamId),
    queryFn: () => api<Settlement[]>(`/teams/${teamId}/settlements`),
  });

export const useInvites = (teamId: string) =>
  useQuery({
    queryKey: keys.invites(teamId),
    queryFn: () => api<Invite[]>(`/teams/${teamId}/invites`),
  });

/**
 * Polls a receipt until the model finishes. Parsing a multi-page receipt takes
 * far longer than a request should be held open, so upload returns immediately
 * and this watches for the result.
 */
export const useReceipt = (teamId: string, receiptId: string | null) =>
  useQuery({
    queryKey: keys.receipt(teamId, receiptId ?? ""),
    queryFn: () => api<Receipt>(`/teams/${teamId}/receipts/${receiptId}`),
    enabled: Boolean(receiptId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "processing" ? 1500 : false;
    },
    // Keep polling while the tab is in the background. Photographing a receipt
    // and then switching apps is the normal phone behaviour, and without this
    // the poll pauses and the user comes back to a spinner that never resolved.
    refetchIntervalInBackground: true,
  });

/** Anything that changes money invalidates every derived view of this team. */
export function useTeamInvalidation(teamId: string) {
  const client = useQueryClient();
  return () => {
    client.invalidateQueries({ queryKey: ["team", teamId] });
    client.invalidateQueries({ queryKey: keys.teams });
  };
}

export function useDeleteExpense(teamId: string) {
  const invalidate = useTeamInvalidation(teamId);
  return useMutation({
    mutationFn: (expenseId: string) =>
      api<void>(`/teams/${teamId}/expenses/${expenseId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export function useSettleUp(teamId: string) {
  const invalidate = useTeamInvalidation(teamId);
  return useMutation({
    mutationFn: (body: {
      from_user_id: string;
      to_user_id: string;
      amount: number;
      settled_at: string;
      note?: string;
    }) => api<Settlement>(`/teams/${teamId}/settlements`, { body }),
    onSuccess: invalidate,
  });
}
