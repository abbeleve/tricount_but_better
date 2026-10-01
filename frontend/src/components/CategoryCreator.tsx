import { useState } from "react";
import { useCreateCategory } from "../hooks/queries";
import { useI18n } from "../lib/i18n";
import type { Category } from "../lib/types";
import { Button, Field, FormError, Input } from "./ui";

/** Also used inside expense forms, so its actions never submit the parent form. */
export function CategoryCreator({
  teamId,
  onCreated,
  onCancel,
}: {
  teamId: string;
  onCreated?: (category: Category) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const create = useCreateCategory(teamId);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");

  function submit() {
    if (!name.trim() || create.isPending) return;
    create.mutate(
      { name: name.trim(), emoji: emoji.trim() },
      {
        onSuccess: (category) => {
          setName("");
          setEmoji("");
          onCreated?.(category);
        },
      },
    );
  }

  return (
    <div
      role="group"
      aria-label={t("New category")}
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          submit();
        }
      }}
    >
      <Field label={t("Category name")}>
        {(id) => (
          <Input
            id={id}
            value={name}
            maxLength={60}
            disabled={create.isPending}
            autoCapitalize="sentences"
            onChange={(event) => { setName(event.target.value); create.reset(); }}
            placeholder={t("e.g. Pet supplies")}
          />
        )}
      </Field>
      <Field label={t("Emoji")} hint={t("Optional")}>
        {(id) => (
          <Input
            id={id}
            value={emoji}
            maxLength={8}
            disabled={create.isPending}
            onChange={(event) => { setEmoji(event.target.value); create.reset(); }}
            placeholder="🐾"
          />
        )}
      </Field>
      <FormError message={create.error ? create.error.message || t("Could not create this category.") : null} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" loading={create.isPending} disabled={!name.trim()} onClick={submit}>
          {t("Create category")}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" disabled={create.isPending} onClick={onCancel}>
            {t("Cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}
