/** Server state. One key namespace per resource so invalidation stays obvious. */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type {
  Balances,
  Category,
  CategoryTotal,
  Expense,
  ExpenseList,
  Invite,
  NotificationList,
  PlannedExpense,
  ListedPrice,
  PriceAnswer,
  ProductDetail,
  ProductFilter,
  ProductList,
  ProductSort,
  Savings,
  ServerConfig,
  Settlement,
  Shop,
  Spending,
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
  spending: (id: string) => ["team", id, "spending"] as const,
  expenses: (id: string) => ["team", id, "expenses"] as const,
  expense: (id: string, eid: string) => ["team", id, "expense", eid] as const,
  plans: (id: string) => ["team", id, "plans"] as const,
  plan: (id: string, pid: string) => ["team", id, "plan", pid] as const,
  settlements: (id: string) => ["team", id, "settlements"] as const,
  invites: (id: string) => ["team", id, "invites"] as const,
  shops: (id: string) => ["team", id, "shops"] as const,
  products: (id: string) => ["team", id, "products"] as const,
  product: (id: string, pid: string) => ["team", id, "products", pid] as const,
  notifications: ["notifications"] as const,
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

export function useCreateCategory(teamId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; emoji: string }) =>
      api<Category>(`/teams/${teamId}/categories`, { body }),
    onSuccess: (category) => {
      client.setQueryData<Category[]>(keys.categories(teamId), (current) =>
        [...(current ?? []).filter((item) => item.id !== category.id), category]
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      client.invalidateQueries({ queryKey: keys.categories(teamId) });
    },
  });
}

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

export const useSpending = (teamId: string) =>
  useQuery({
    queryKey: keys.spending(teamId),
    queryFn: ({ signal }) => api<Spending>(`/teams/${teamId}/spending`, { signal }),
  });

export const useExpense = (teamId: string, expenseId: string | undefined) =>
  useQuery({
    queryKey: keys.expense(teamId, expenseId ?? ""),
    queryFn: () => api<Expense>(`/teams/${teamId}/expenses/${expenseId}`),
    enabled: Boolean(expenseId),
  });

export const usePlans = (teamId: string) =>
  useQuery({
    queryKey: keys.plans(teamId),
    queryFn: () => api<PlannedExpense[]>(`/teams/${teamId}/plans`),
  });

export const usePlan = (teamId: string, planId: string | null | undefined) =>
  useQuery({
    queryKey: keys.plan(teamId, planId ?? ""),
    queryFn: () => api<PlannedExpense>(`/teams/${teamId}/plans/${planId}`),
    enabled: Boolean(planId),
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

/** Takes back a "Mark paid" -- one mistaken tap on a phone must not stick. */
export function useDeleteSettlement(teamId: string) {
  const invalidate = useTeamInvalidation(teamId);
  return useMutation({
    mutationFn: (settlementId: string) =>
      api<void>(`/teams/${teamId}/settlements/${settlementId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

/**
 * The signed-in user's notifications. Polled while the app is in front -- push
 * also nudges it, but only on devices where push is switched on.
 */
export const useNotifications = (enabled = true) =>
  useQuery({
    queryKey: keys.notifications,
    queryFn: ({ signal }) => api<NotificationList>("/notifications", { signal }),
    enabled,
    refetchInterval: 60_000,
  });

/** Marks these as read on the server, and in the cached list straight away. */
export function useMarkNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      api<{ unread_count: number }>("/notifications/read", { body: { ids } }),
    onMutate: (ids) => {
      const read = new Set(ids);
      client.setQueryData<NotificationList>(keys.notifications, (current) => {
        if (!current) return current;
        const newlyRead = current.items.filter((n) => !n.read && read.has(n.id)).length;
        return {
          items: current.items.map((n) => (read.has(n.id) ? { ...n, read: true } : n)),
          unread_count: Math.max(0, current.unread_count - newlyRead),
        };
      });
    },
    onSuccess: ({ unread_count }) => {
      client.setQueryData<NotificationList>(
        keys.notifications,
        (current) => current && { ...current, unread_count },
      );
    },
    onError: () => client.invalidateQueries({ queryKey: keys.notifications }),
  });
}

/* ------------------------------------------------------- shops and goods */

export const useShops = (teamId: string) =>
  useQuery({
    queryKey: keys.shops(teamId),
    queryFn: () => api<Shop[]>(`/teams/${teamId}/shops`),
  });

/** Prices hang off shops and goods, so a change to either refreshes both. */
function useCatalogInvalidation(teamId: string) {
  const client = useQueryClient();
  return () => {
    client.invalidateQueries({ queryKey: keys.shops(teamId) });
    client.invalidateQueries({ queryKey: keys.products(teamId) });
  };
}

export function useCreateShop(teamId: string) {
  const client = useQueryClient();
  const invalidate = useCatalogInvalidation(teamId);
  return useMutation({
    mutationFn: (body: { name: string; address?: string; alias?: string | null }) =>
      api<Shop>(`/teams/${teamId}/shops`, { body }),
    onSuccess: (shop) => {
      client.setQueryData<Shop[]>(keys.shops(teamId), (current) =>
        [...(current ?? []).filter((item) => item.id !== shop.id), shop]
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      invalidate();
    },
  });
}

export function useUpdateShop(teamId: string) {
  const invalidate = useCatalogInvalidation(teamId);
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; address?: string }) =>
      api<Shop>(`/teams/${teamId}/shops/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
  });
}

/** Remember another name receipts print for a shop, so the next scan matches. */
export function useAddShopAlias(teamId: string) {
  const invalidate = useCatalogInvalidation(teamId);
  return useMutation({
    mutationFn: ({ id, alias }: { id: string; alias: string }) =>
      api<Shop>(`/teams/${teamId}/shops/${id}/aliases`, { body: { alias } }),
    onSuccess: invalidate,
  });
}

export function useDeleteShop(teamId: string) {
  const invalidate = useCatalogInvalidation(teamId);
  return useMutation({
    mutationFn: (id: string) => api<void>(`/teams/${teamId}/shops/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export interface ProductQuery {
  q?: string;
  ids?: string[];
  shopId?: string;
  filter?: ProductFilter;
  sort?: ProductSort;
  limit?: number;
}

export const useProducts = (teamId: string, query: ProductQuery, enabled = true) =>
  useQuery({
    queryKey: [...keys.products(teamId), "list", query],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (query.q) params.set("q", query.q);
      query.ids?.forEach((id) => params.append("ids", id));
      if (query.shopId) params.set("shop_id", query.shopId);
      if (query.filter) params.set("filter", query.filter);
      if (query.sort) params.set("sort", query.sort);
      params.set("limit", String(query.limit ?? 100));
      return api<ProductList>(`/teams/${teamId}/products?${params}`, { signal });
    },
    enabled,
    // Typing in the search keeps the last results on screen instead of a flash.
    placeholderData: keepPreviousData,
  });

/**
 * A product added by hand, with the first price someone knows for it.
 * Two requests, so a refused price still leaves the product to edit.
 */
export function useCreateProduct(teamId: string) {
  const invalidate = useCatalogInvalidation(teamId);
  return useMutation({
    mutationFn: async ({ name, shopId, regularPrice, observedOn }: {
      name: string; shopId?: string; regularPrice?: number | null; observedOn: string;
    }) => {
      const product = await api<ProductDetail>(`/teams/${teamId}/products`, { body: { name } });
      if (shopId && regularPrice) {
        return api<ProductDetail>(`/teams/${teamId}/products/${product.id}/prices/${shopId}`, {
          method: "PUT",
          body: { regular_price: regularPrice, sale_price: null, sale_until: null, observed_on: observedOn },
        });
      }
      return product;
    },
    onSettled: invalidate,
  });
}

/** Save checked prices read off a screenshot as one shop's prices. */
export function useImportPrices(teamId: string) {
  const invalidate = useCatalogInvalidation(teamId);
  return useMutation({
    mutationFn: (body: { shop_id: string; observed_on: string; items: ListedPrice[] }) =>
      api<{ saved: number; created: number }>(`/teams/${teamId}/prices/import`, { body }),
    onSuccess: invalidate,
  });
}

/** Under the products key, so every price change refreshes it too. */
export const useSavings = (teamId: string) =>
  useQuery({
    queryKey: [...keys.products(teamId), "savings"],
    queryFn: ({ signal }) => api<Savings>(`/teams/${teamId}/prices/savings`, { signal }),
  });

export const useProduct = (teamId: string, productId: string) =>
  useQuery({
    queryKey: keys.product(teamId, productId),
    queryFn: () => api<ProductDetail>(`/teams/${teamId}/products/${productId}`),
  });

export function useProductMutations(teamId: string, productId: string) {
  const client = useQueryClient();
  const invalidate = useCatalogInvalidation(teamId);
  const store = (product: ProductDetail) => {
    client.setQueryData(keys.product(teamId, product.id), product);
    invalidate();
  };
  const base = `/teams/${teamId}/products/${productId}`;
  return {
    rename: useMutation({
      mutationFn: (name: string) => api<ProductDetail>(base, { method: "PATCH", body: { name } }),
      onSuccess: store,
    }),
    merge: useMutation({
      mutationFn: (intoId: string) =>
        api<ProductDetail>(`${base}/merge`, { body: { into_id: intoId } }),
      onSuccess: (product) => {
        store(product);
        // Expense lines now point at the other product.
        client.invalidateQueries({ queryKey: keys.expenses(teamId) });
      },
    }),
    remove: useMutation({
      mutationFn: () => api<void>(base, { method: "DELETE" }),
      onSuccess: invalidate,
    }),
    setPrice: useMutation({
      mutationFn: ({ shopId, ...body }: {
        shopId: string;
        regular_price: number | null;
        sale_price: number | null;
        sale_until: string | null;
        observed_on: string;
      }) => api<ProductDetail>(`${base}/prices/${shopId}`, { method: "PUT", body }),
      onSuccess: store,
    }),
    forgetPrice: useMutation({
      mutationFn: (shopId: string) => api<void>(`${base}/prices/${shopId}`, { method: "DELETE" }),
      onSuccess: invalidate,
    }),
  };
}

export function useReviewPrices(teamId: string) {
  const invalidate = useCatalogInvalidation(teamId);
  return useMutation({
    mutationFn: (answers: PriceAnswer[]) =>
      api<void>(`/teams/${teamId}/prices/review`, {
        body: {
          decisions: answers.map(({ change, decision, saleUntil }) => ({
            product_id: change.product_id,
            shop_id: change.shop_id,
            observed_on: change.observed_on,
            price: change.price,
            regular_price: change.regular_price,
            decision,
            sale_until: decision === "sale" ? saleUntil || null : null,
          })),
        },
      }),
    onSuccess: invalidate,
  });
}
