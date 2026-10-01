import { useCategories } from "../hooks/queries";
import { useI18n } from "../lib/i18n";
import { CategoryCreator } from "./CategoryCreator";
import { Card, EmptyState, ErrorState, Skeleton } from "./ui";

export function CategoriesTab({ teamId }: { teamId: string }) {
  const { t } = useI18n();
  const categories = useCategories(teamId);

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4 sm:p-5">
        <h2 className="mb-1 text-sm font-semibold text-body">{t("Team categories")}</h2>
        <p className="mb-4 text-[13px] text-muted">
          {t("Everyone in this team can create and use these categories.")}
        </p>
        {categories.isPending && <Skeleton className="h-32 w-full" />}
        {categories.isError && (
          <ErrorState message={t("Could not load categories.")} onRetry={() => categories.refetch()} />
        )}
        {categories.data?.length === 0 && (
          <EmptyState
            title={t("No categories yet")}
            body={t("Create a category to organise this team's purchases.")}
          />
        )}
        {categories.data && categories.data.length > 0 && (
          <ul className="divide-y divide-line">
            {categories.data.map((category) => (
              <li key={category.id} className="flex items-center gap-3 py-3">
                <span aria-hidden="true" className="text-xl">{category.emoji || "🏷️"}</span>
                <span className="min-w-0 break-words text-sm font-medium text-body">{category.name}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-4 sm:p-5">
        <h2 className="mb-4 text-sm font-semibold text-body">{t("New category")}</h2>
        <CategoryCreator teamId={teamId} />
      </Card>
    </div>
  );
}
