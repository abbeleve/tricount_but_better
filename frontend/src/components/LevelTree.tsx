import { useI18n } from "../lib/i18n";
import { formatPackSize } from "../lib/price-format";
import type { ProductLevels } from "../lib/types";
import { cx } from "./ui";

/**
 * Sizes for a card of its own, and for under a receipt line, where it is one
 * of many. `indent` is how far each level sits in from the one it narrows, in
 * px; the elbow runs from under the level above to this one's text.
 */
const SIZES = {
  regular: { indent: 20, list: "text-[13px] leading-5", row: "py-1.5", elbow: "-top-1 h-5 w-2.5", elbowAt: 6, label: "text-[12px]" },
  compact: { indent: 16, list: "text-[12px] leading-4", row: "py-0.5", elbow: "top-0 h-2.5 w-2", elbowAt: 5, label: "text-[11px]" },
};

/**
 * A good's levels as a tree, general to specific: "хлеб", under it "белый
 * нарезной", under that the brand, then the pack size. A level the good has no
 * word for keeps its row, so every level sits at the same depth everywhere.
 */
export function LevelTree({
  levels,
  compact = false,
  className,
}: {
  levels: ProductLevels;
  compact?: boolean;
  className?: string;
}) {
  const { t, language } = useI18n();
  const size = levels.by_weight
    ? t("by weight")
    : levels.size && levels.unit ? formatPackSize(levels.size, levels.unit, language) : null;
  const steps = [
    { label: t("Kind"), value: levels.kind },
    { label: t("Variety"), value: levels.variety },
    { label: t("Brand"), value: levels.brand },
    { label: t("Size"), value: size },
  ];
  const s = SIZES[compact ? "compact" : "regular"];

  return (
    <ol className={cx(s.list, className)}>
      {steps.map((step, depth) => (
        <li key={step.label} className={cx("relative flex items-baseline justify-between gap-3", s.row)}
          style={{ paddingLeft: depth * s.indent }}>
          {depth > 0 && (
            <span aria-hidden="true" className={cx("absolute rounded-bl-[4px] border-b border-l border-line-strong", s.elbow)}
              style={{ left: (depth - 1) * s.indent + s.elbowAt }} />
          )}
          <span className={cx("min-w-0 break-words", step.value ? "text-body" : "text-subtle", depth === 0 && "font-medium")}>
            {step.value ?? t("not named")}
          </span>
          <span className={cx("shrink-0 text-muted", s.label)}>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}
