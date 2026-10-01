import { useMutation } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppShell, PageTitle } from "../components/Layout";
import { CategoryPicker } from "../components/CategoryPicker";
import {
  Button, Card, ErrorState, Field, FormError, Input, MoneyInput, Skeleton, Textarea,
} from "../components/ui";
import { usePlan, useTeam, useTeamInvalidation } from "../hooks/queries";
import { ApiError, api } from "../lib/api";
import { toMajorString, toMinor } from "../lib/money";
import { useI18n } from "../lib/i18n";
import type { PlannedExpense } from "../lib/types";

interface DraftItem {
  key: number;
  name: string;
  amount: string;
}

let nextKey = 0;
const blankItem = (): DraftItem => ({ key: nextKey++, name: "", amount: "" });

export default function PlanForm() {
  const { teamId = "", planId } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const team = useTeam(teamId);
  const plan = usePlan(teamId, planId);
  const invalidate = useTeamInvalidation(teamId);
  const editing = Boolean(planId);
  const currency = team.data?.currency ?? "RUB";
  const backToPlans = `/teams/${teamId}?tab=expenses`;

  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [items, setItems] = useState<DraftItem[]>(() => [blankItem()]);

  useEffect(() => {
    if (!planId || !plan.data || loadedId === planId) return;
    setLoadedId(planId);
    setTitle(plan.data.title);
    setNote(plan.data.note);
    setCategoryId(plan.data.category_id ?? "");
    setItems(plan.data.items.map((item) => ({
      key: nextKey++,
      name: item.name,
      amount: item.total === null ? "" : toMajorString(item.total, currency),
    })));
  }, [planId, plan.data, loadedId, currency]);

  const valid = Boolean(title.trim()) && items.length > 0 && items.every((item) =>
    Boolean(item.name.trim()) &&
    (item.amount.trim() === "" || (toMinor(item.amount, currency) ?? -1) >= 0),
  );

  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(),
        note,
        category_id: categoryId || null,
        items: items.map((item) => ({
          name: item.name.trim(),
          total: item.amount.trim() === "" ? null : toMinor(item.amount, currency),
        })),
      };
      return api<PlannedExpense>(
        planId ? `/teams/${teamId}/plans/${planId}` : `/teams/${teamId}/plans`,
        { method: planId ? "PUT" : "POST", body },
      );
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: () => api<void>(`/teams/${teamId}/plans/${planId}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      navigate(backToPlans);
    },
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await save.mutateAsync();
      navigate(backToPlans);
    } catch {
      // The mutation error is displayed beside the actions.
    }
  }

  async function complete() {
    if (!valid || !planId) return;
    try {
      await save.mutateAsync();
      navigate(`/teams/${teamId}/expenses/new?planId=${planId}`);
    } catch {
      // Keep the editable list in place so the error can be fixed.
    }
  }

  if (team.isPending || (editing && plan.isPending)) {
    return <AppShell back={{ to: backToPlans, label: t("Back") }}><Skeleton className="h-96" /></AppShell>;
  }

  if (team.isError || (editing && plan.isError)) {
    return <AppShell back={{ to: backToPlans, label: t("Back") }}>
      <Card><ErrorState message={t("Could not load this plan.")} onRetry={() => {
        if (team.isError) team.refetch();
        if (plan.isError) plan.refetch();
      }} /></Card>
    </AppShell>;
  }

  return (
    <AppShell back={{ to: backToPlans, label: team.data?.name ?? t("Back") }} bar={
      <div className="flex flex-col gap-2">
        <FormError message={save.error instanceof ApiError ? t(save.error.message) : null} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" form="plan-form" disabled={!valid} loading={save.isPending}>
            {t(editing ? "Save plan" : "Create plan")}
          </Button>
          {editing && (
            <Button type="button" variant="secondary" disabled={!valid} loading={save.isPending} onClick={complete}>
              {t("Complete purchase")}
            </Button>
          )}
        </div>
      </div>
    }>
      <PageTitle title={t(editing ? "Edit plan" : "Plan a purchase")}
        subtitle={t("Add what you intend to buy. Prices can wait until you purchase it.")} />
      <form id="plan-form" onSubmit={submit} className="flex flex-col gap-4">
        <Card className="flex flex-col gap-4 p-4 sm:p-5">
          <Field label={t("What are you planning?")}>
            {(id) => <Input id={id} required maxLength={160} value={title}
              onChange={(event) => setTitle(event.target.value)} placeholder={t("Weekly shop")} />}
          </Field>
          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-medium text-body">{t("Shopping list")}</p>
            <ul className="flex flex-col divide-y divide-line">
              {items.map((item) => (
                <li key={item.key} className="flex gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <Input aria-label={t("Item name")} maxLength={200} value={item.name}
                      onChange={(event) => setItems((list) => list.map((row) => row.key === item.key ? { ...row, name: event.target.value } : row))}
                      placeholder={t("Item")} />
                  </div>
                  <div className="w-28 shrink-0">
                    <MoneyInput aria-label={t("Optional price")} value={item.amount}
                      onChange={(event) => setItems((list) => list.map((row) => row.key === item.key ? { ...row, amount: event.target.value } : row))}
                      placeholder={t("Price")} />
                  </div>
                  <button type="button" aria-label={t("Remove {name}", { name: item.name || t("Item") })}
                    className="size-10 shrink-0 rounded-control text-muted hover:bg-surface-2 disabled:opacity-40"
                    disabled={items.length === 1}
                    onClick={() => setItems((list) => list.filter((row) => row.key !== item.key))}>×</button>
                </li>
              ))}
            </ul>
            <Button type="button" variant="secondary" size="sm" className="self-start"
              onClick={() => setItems((list) => [...list, blankItem()])}>{t("Add a line")}</Button>
          </div>
        </Card>
        <Card className="flex flex-col gap-4 p-4 sm:p-5">
          <CategoryPicker teamId={teamId} value={categoryId} onChange={setCategoryId} hint={t("Optional")} />
          <Field label={t("Note")} hint={t("Optional")}>
            {(id) => <Textarea id={id} value={note} onChange={(event) => setNote(event.target.value)} />}
          </Field>
        </Card>
        {editing && (
          <Button type="button" variant="danger" className="self-start" loading={remove.isPending}
            onClick={() => {
              if (window.confirm(t("Delete this plan?"))) remove.mutate();
            }}>{t("Delete plan")}</Button>
        )}
      </form>
    </AppShell>
  );
}
