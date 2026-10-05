/**
 * Keeps <meta name="theme-color"> on the page background, so the phone's status
 * bar and browser chrome blend into the header. Two things move it -- the theme
 * toggle and the glass look -- so both go through here.
 */

/** Matches --bg. */
const PLAIN = { light: "#fafafa", dark: "#09090b" };

let colors = PLAIN;

export function syncThemeColor(): void {
  const dark = document.documentElement.classList.contains("dark");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? colors.dark : colors.light);
}

/** The glass ground's colours, or null to go back to the plain background. */
export function setThemeColors(next: { light: string; dark: string } | null): void {
  colors = next ?? PLAIN;
  syncThemeColor();
}
