/**
 * Dates are calendar days here, not instants: "when was this bought".
 *
 * `toISOString()` would answer in UTC, so anyone east of Greenwich gets
 * yesterday's date for most of their evening -- in Moscow, every expense added
 * after 03:00 local would be dated a day early.
 */
export function todayLocal(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}
