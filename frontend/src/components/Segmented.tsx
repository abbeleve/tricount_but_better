import { useI18n } from "../lib/i18n";
import { SPENDING_PERIODS, type SpendingPeriod } from "../lib/spending";
import { cx } from "./ui";

/** A row of mutually exclusive choices, one pressed. */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string;
}) {
  return <div role="group" aria-label={label} className="inline-flex rounded-segment bg-surface-2 p-1">
    {options.map((option) => <button key={option.value} type="button" aria-pressed={value === option.value}
      onClick={() => onChange(option.value)} className={cx("rounded-segment-option px-3 py-2 text-[13px] transition-colors",
        value === option.value ? "bg-raised font-medium text-body shadow-raised" : "text-muted hover:text-body")}>
      {option.label}
    </button>)}
  </div>;
}

const LABELS = { week: "Week", month: "Month", year: "Year" };

export function PeriodPicker({ value, onChange, label }: {
  value: SpendingPeriod; onChange: (value: SpendingPeriod) => void; label: string;
}) {
  const { t } = useI18n();
  return <Segmented value={value} onChange={onChange} label={label}
    options={SPENDING_PERIODS.map((period) => ({ value: period, label: t(LABELS[period]) }))} />;
}
