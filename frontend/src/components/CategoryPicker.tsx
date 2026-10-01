import { useState } from "react";
import { useCategories } from "../hooks/queries";
import { useI18n } from "../lib/i18n";
import { CategoryCreator } from "./CategoryCreator";
import { Button, Field, FormError, Select } from "./ui";

export function CategoryPicker({
  teamId,
  value,
  onChange,
  hint,
}: {
  teamId: string;
  value: string;
  onChange: (categoryId: string) => void;
  hint?: string;
}) {
  const { t } = useI18n();
  const categories = useCategories(teamId);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <Field label={t("Category")} hint={hint}>
        {(id) => (
          <Select
            id={id}
            value={value}
            disabled={categories.isPending || categories.isError}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">{t("No category")}</option>
            {categories.data?.map((category) => (
              <option key={category.id} value={category.id}>
                {category.emoji} {category.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {categories.isError && (
        <>
          <FormError message={t("Could not load categories.")} />
          <Button type="button" variant="secondary" size="sm" className="self-start" onClick={() => categories.refetch()}>
            {t("Try again")}
          </Button>
        </>
      )}
      {creating ? (
        <div className="rounded-control border border-line bg-surface-2 p-3">
          <CategoryCreator
            teamId={teamId}
            onCreated={(category) => { onChange(category.id); setCreating(false); }}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : (
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setCreating(true)}>
          {t("New category")}
        </Button>
      )}
    </div>
  );
}
