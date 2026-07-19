/**
 * Color-scheme controller. Preference persists in localStorage; "system"
 * follows the OS via matchMedia. The resolved mode lands on
 * <html data-color-scheme="..."> which styles.css keys its dark tokens off.
 * CSP blocks inline scripts, so the pre-React flash window is covered by the
 * inline <style> in index.html (light-dark() on the html element) instead.
 */

export type ThemePref = "system" | "light" | "dark";

const KEY = "tracker-color-scheme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePref(): ThemePref {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

function resolve(pref: ThemePref): "light" | "dark" {
  if (pref === "system") return media.matches ? "dark" : "light";
  return pref;
}

function apply(pref: ThemePref) {
  document.documentElement.dataset.colorScheme = resolve(pref);
}

export function setThemePref(pref: ThemePref) {
  if (pref === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, pref);
  apply(pref);
}

export function initTheme() {
  apply(getThemePref());
  media.addEventListener("change", () => apply(getThemePref()));
}
