import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { AppShell, PageTitle } from "../components/Layout";
import { Avatar, Button, Card, Chip, Field, Input, Money, Switch, cx } from "../components/ui";
import { useAppearance } from "../hooks/useAppearance";
import { useAuth } from "../hooks/useAuth";
import { useServerConfig } from "../hooks/queries";
import {
  DEFAULT_APPEARANCE,
  LIMITS,
  MAX_PALETTES,
  isBuiltin,
  newPaletteId,
  parseHex,
  randomSeed,
  resolvePalette,
  swatch,
  type Palette,
} from "../lib/glass";
import { useI18n } from "../lib/i18n";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia?.(REDUCED_MOTION);
      query?.addEventListener?.("change", notify);
      return () => query?.removeEventListener?.("change", notify);
    },
    () => window.matchMedia?.(REDUCED_MOTION).matches ?? false,
  );
}

/** Speed reads best on a doubling scale: the default sits mid-track, 0.25x and 4x at the ends. */
const toSpeedSlider = (speed: number) => Math.log2(speed);
const fromSpeedSlider = (value: number) => Math.round(2 ** value * 100) / 100;

function Section({ title, body, children }: { title: string; body?: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-5 p-4 sm:p-5">
      <div>
        <h2 className="text-sm font-semibold text-body">{title}</h2>
        {body && <p className="mt-1 text-[13px] text-muted">{body}</p>}
      </div>
      {children}
    </Card>
  );
}

/** The whole row toggles; the switch is named by the title and described by the body. */
function ToggleRow({
  title,
  body,
  checked,
  onChange,
}: {
  title: string;
  body: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const bodyId = useId();
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-body">{title}</span>
        <span id={bodyId} className="mt-1 block text-[13px] text-muted">
          {body}
        </span>
      </span>
      <Switch
        checked={checked}
        onChange={onChange}
        aria-label={title}
        aria-describedby={bodyId}
        className="mt-0.5"
      />
    </label>
  );
}

function Slider({
  label,
  hint,
  display,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  display: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className={cx("flex flex-col gap-1.5", disabled && "opacity-50")}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-body">
          {label}
        </label>
        <output htmlFor={id} className="tabular text-[13px] text-muted">
          {display}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={display}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-6 w-full cursor-pointer accent-ink disabled:cursor-not-allowed pointer-coarse:h-9"
      />
      {hint && <p className="text-[12px] text-muted">{hint}</p>}
    </div>
  );
}

/** A native colour well beside a hex field, for when the exact colour matters. */
function ColorField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  const [text, setText] = useState(value);
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <div className="flex gap-2">
          <input
            type="color"
            value={value}
            aria-label={label}
            onChange={(e) => {
              onChange(e.target.value);
              setText(e.target.value);
            }}
            className="color-well h-10 w-14 shrink-0 rounded-control border border-line bg-surface pointer-coarse:h-11"
          />
          <Input
            id={id}
            value={text}
            maxLength={7}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            className="tabular"
            onChange={(e) => {
              setText(e.target.value);
              const hex = parseHex(e.target.value);
              if (hex) onChange(hex);
            }}
            onBlur={() => setText(value)}
          />
        </div>
      )}
    </Field>
  );
}

/**
 * Edits a palette in place: the whole page previews the draft as the colours
 * change, and drops the preview when the editor closes, saved or not.
 */
function PaletteEditor({
  initial,
  isNew,
  onSave,
  onDelete,
  onCancel,
}: {
  initial: Palette;
  isNew: boolean;
  onSave: (palette: Palette) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const { setPreview } = useAppearance();
  const [draft, setDraft] = useState(initial);
  const name = draft.name.trim();

  useEffect(() => setPreview(draft), [draft, setPreview]);
  useEffect(() => () => setPreview(null), [setPreview]);

  return (
    <div className="flex flex-col gap-4 border-t border-line pt-4">
      <h3 className="text-sm font-semibold text-body">{t(isNew ? "New palette" : "Edit palette")}</h3>
      <Field label={t("Name")}>
        {(id) => (
          <Input
            id={id}
            value={draft.name}
            maxLength={40}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <ColorField
          label={t("Main colour")}
          hint={t("The glass, the backdrop and buttons.")}
          value={draft.base}
          onChange={(base) => setDraft((d) => ({ ...d, base }))}
        />
        <ColorField
          label={t("Accent colour")}
          hint={t("The tab marker, the logo and avatars.")}
          value={draft.accent}
          onChange={(accent) => setDraft((d) => ({ ...d, accent }))}
        />
      </div>
      <p className="text-[12px] text-muted">
        {t("The page shows the colours as you pick them. Nothing is saved until you save the palette.")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!name} onClick={() => onSave({ ...draft, name })}>
          {t(isNew ? "Add palette" : "Save palette")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("Cancel")}
        </Button>
        {!isNew && (
          <Button size="sm" variant="danger" className="ml-auto" onClick={onDelete}>
            {t("Delete palette")}
          </Button>
        )}
      </div>
    </div>
  );
}

function Palettes() {
  const { t } = useI18n();
  const { appearance, palette: shown, palettes, update } = useAppearance();
  const [editing, setEditing] = useState<{ palette: Palette; isNew: boolean } | null>(null);
  const own = appearance.palettes;
  const selected = resolvePalette(appearance.palette, own);
  const label = (p: Palette) => (isBuiltin(p.id) ? t(p.name) : p.name);

  function save(palette: Palette) {
    const next = own.some((p) => p.id === palette.id)
      ? own.map((p) => (p.id === palette.id ? palette : p))
      : [...own, palette];
    update({ palettes: next, palette: palette.id });
    setEditing(null);
  }

  function remove(id: string) {
    update({
      palettes: own.filter((p) => p.id !== id),
      palette: appearance.palette === id ? DEFAULT_APPEARANCE.palette : appearance.palette,
    });
    setEditing(null);
  }

  return (
    <Section
      title={t("Colours")}
      body={t("Two colours make the whole look. The main one tints the glass, the backdrop and buttons; the accent marks small details.")}
    >
      <div role="group" aria-label={t("Palette")} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {palettes.map((p) => {
          const on = p.id === selected.id;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              disabled={editing !== null}
              onClick={() => update({ palette: p.id })}
              className={cx(
                "flex min-w-0 items-center gap-2.5 rounded-button border p-2 pr-3 text-left",
                "transition duration-150 ease-out active:scale-[0.97] active:duration-0",
                "disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100",
                on ? "border-ink bg-surface-2" : "border-line hover:bg-surface-2",
              )}
            >
              <span
                aria-hidden="true"
                className="size-7 shrink-0 rounded-full"
                style={{
                  background: swatch(p),
                  // A selection ring with a gap, so the swatch's own colours stay readable.
                  boxShadow: on
                    ? "0 0 0 2px var(--surface-overlay), 0 0 0 4px var(--ink)"
                    : "inset 0 0 0 1px rgb(0 0 0 / 0.12)",
                }}
              />
              <span className="min-w-0 truncate text-[13px] font-medium text-body">{label(p)}</span>
            </button>
          );
        })}
      </div>

      {editing ? (
        <PaletteEditor
          key={editing.palette.id}
          initial={editing.palette}
          isNew={editing.isNew}
          onSave={save}
          onDelete={() => remove(editing.palette.id)}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={own.length >= MAX_PALETTES}
            onClick={() =>
              setEditing({
                isNew: true,
                palette: {
                  id: newPaletteId(own.map((p) => p.id)),
                  name: t("My palette"),
                  base: shown.base,
                  accent: shown.accent,
                },
              })
            }
          >
            {t("New palette")}
          </Button>
          {!isBuiltin(selected.id) && (
            <Button size="sm" variant="ghost" onClick={() => setEditing({ isNew: false, palette: selected })}>
              {t("Edit palette")}
            </Button>
          )}
          {own.length >= MAX_PALETTES && (
            <p className="text-[12px] text-muted">
              {t("You can keep up to {count} palettes of your own.", { count: MAX_PALETTES })}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

/** A slice of every surface the palette reaches, so a colour can be judged without leaving the page. */
function Preview() {
  const { t } = useI18n();
  const { user } = useAuth();
  const config = useServerConfig();
  const name = user?.display_name ?? t("You");
  return (
    <Section title={t("Preview")}>
      {/* Looks only: nothing in here does anything, so it stays out of the tab order. */}
      <div inert className="flex flex-col gap-5">
        <div className="flex gap-5 border-b border-line text-sm">
          <span className="relative pb-2.5 font-medium text-body">
            {t("Balances")}
            <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-indicator" />
          </span>
          <span className="pb-2.5 text-muted">{t("Expenses")}</span>
        </div>
        <div>
          <div className="mb-1.5 flex items-center gap-3">
            <Avatar name={name} size={28} />
            <span className="min-w-0 flex-1 truncate text-sm text-body">{name}</span>
            <Money minor={125000} currency={config.data?.default_currency ?? "RUB"} signed className="text-sm" />
          </div>
          <div className="track relative h-2 w-full rounded-full bg-surface-2">
            <div className="absolute inset-y-[-3px] left-1/2 w-px -translate-x-1/2 bg-line-strong" />
            <div className="absolute left-1/2 top-0 h-2 w-[30%] rounded-r-[4px] bg-positive-mark" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm">{t("Primary")}</Button>
          <Button size="sm" variant="secondary">
            {t("Secondary")}
          </Button>
          <Chip>{t("planned")}</Chip>
        </div>
        <p className="hatch rounded-control bg-surface-2 px-3 py-5 text-center text-[13px] text-muted">
          {t("Empty places are hatched.")}
        </p>
      </div>
    </Section>
  );
}

function SaveState() {
  const { t } = useI18n();
  const { status, retry } = useAppearance();
  return (
    <div role="status" className="flex min-h-8 items-center gap-2 text-[13px] text-muted">
      {status === "saving" && t("Saving…")}
      {status === "saved" && t("Saved to your account")}
      {status === "error" && (
        <>
          <span className="text-danger">{t("Not saved")}</span>
          <Button size="sm" variant="secondary" onClick={retry}>
            {t("Try again")}
          </Button>
        </>
      )}
    </div>
  );
}

export default function AppearancePage() {
  const { t, language } = useI18n();
  const location = useLocation();
  const { appearance: look, update } = useAppearance();
  const reducedMotion = useReducedMotion();
  const number = new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en-US", { maximumFractionDigits: 2 });
  const percent = (value: number) => `${Math.round(value * 100)}%`;

  const from = (location.state as { from?: unknown } | null)?.from;
  const back =
    typeof from === "string" && from.startsWith("/") && !from.startsWith("//") && !from.startsWith("/appearance")
      ? { to: from, label: t("Back") }
      : { to: "/", label: t("All teams") };

  return (
    <AppShell back={back} narrow>
      <div>
        <PageTitle
          title={t("Appearance")}
          subtitle={t("Saved to your account, so it follows you to every device.")}
          action={<SaveState />}
        />

        <div className="flex flex-col gap-4">
          <Card className="p-4 sm:p-5">
            <ToggleRow
              title={t("Glass design")}
              body={t("Frosted, see-through panels over a soft backdrop of coloured glows.")}
              checked={look.glass}
              onChange={(glass) => update({ glass })}
            />
          </Card>

          {look.glass && (
            <>
              <Palettes />
              <Preview />

              <Section title={t("Backdrop")}>
                <Slider
                  label={t("Glow strength")}
                  display={percent(look.glow)}
                  value={look.glow}
                  min={LIMITS.glow.min}
                  max={LIMITS.glow.max}
                  step={0.05}
                  onChange={(glow) => update({ glow }, { settle: true })}
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-body">{t("Glow layout")}</p>
                    <p className="mt-0.5 text-[12px] text-muted">
                      {t(look.backdrop_seed ? "Shuffled. The layout is saved with your look." : "As designed.")}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => update({ backdrop_seed: randomSeed() })}>
                      {t("Shuffle")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={look.backdrop_seed === 0}
                      onClick={() => update({ backdrop_seed: 0 })}
                    >
                      {t("Reset")}
                    </Button>
                  </div>
                </div>
              </Section>

              <Section title={t("Glass")}>
                <Slider
                  label={t("Frost")}
                  hint={t("How much the panels blur what is behind them. Off is lightest on the battery.")}
                  display={look.blur === 0 ? t("Off") : `${look.blur} px`}
                  value={look.blur}
                  min={LIMITS.blur.min}
                  max={LIMITS.blur.max}
                  step={1}
                  onChange={(blur) => update({ blur }, { settle: true })}
                />
                <Slider
                  label={t("Panel opacity")}
                  display={`${look.fill}%`}
                  value={look.fill}
                  min={LIMITS.fill.min}
                  max={LIMITS.fill.max}
                  step={1}
                  onChange={(fill) => update({ fill }, { settle: true })}
                />
              </Section>

              <Section title={t("Motion")}>
                <ToggleRow
                  title={t("Living backdrop")}
                  body={t("The glows drift slowly behind the page.")}
                  checked={look.flow}
                  onChange={(flow) => update({ flow })}
                />
                {look.flow && reducedMotion && (
                  <p className="rounded-control bg-surface-2 px-3 py-2.5 text-[13px] text-muted">
                    {t("Your device asks for reduced motion, so the backdrop stays still.")}
                  </p>
                )}
                <Slider
                  label={t("Speed")}
                  display={`${number.format(look.flow_speed)}×`}
                  value={toSpeedSlider(look.flow_speed)}
                  min={toSpeedSlider(LIMITS.flow_speed.min)}
                  max={toSpeedSlider(LIMITS.flow_speed.max)}
                  step={0.05}
                  disabled={!look.flow}
                  onChange={(value) => update({ flow_speed: fromSpeedSlider(value) }, { settle: true })}
                />
                <Slider
                  label={t("Range")}
                  hint={t("How far the glows wander.")}
                  display={percent(look.flow_range)}
                  value={look.flow_range}
                  min={LIMITS.flow_range.min}
                  max={LIMITS.flow_range.max}
                  step={0.05}
                  disabled={!look.flow}
                  onChange={(flow_range) => update({ flow_range }, { settle: true })}
                />
              </Section>

              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const d = DEFAULT_APPEARANCE;
                    // Everything but the switch itself and the palettes the user made.
                    update({
                      palette: d.palette,
                      glow: d.glow,
                      blur: d.blur,
                      fill: d.fill,
                      backdrop_seed: d.backdrop_seed,
                      flow: d.flow,
                      flow_speed: d.flow_speed,
                      flow_range: d.flow_range,
                    });
                  }}
                >
                  {t("Reset the look to its defaults")}
                </Button>
                <p className="mt-1 px-1 text-[12px] text-muted">{t("Your own palettes are kept.")}</p>
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
