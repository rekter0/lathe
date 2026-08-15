export const UI_PREFERENCES_STORAGE_KEY = "lathe.ui-preferences.v1";
export const MIN_UI_FONT_SCALE = 85;
export const MAX_UI_FONT_SCALE = 150;
export const DEFAULT_UI_FONT_SCALE = 100;

export interface UiPreferences {
  fontScalePercent: number;
}

export const defaultUiPreferences: UiPreferences = {
  fontScalePercent: DEFAULT_UI_FONT_SCALE
};

function normalizedFontScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_UI_FONT_SCALE;
  return Math.min(MAX_UI_FONT_SCALE, Math.max(MIN_UI_FONT_SCALE, Math.round(value / 5) * 5));
}

export function readUiPreferences(storage?: Pick<Storage, "getItem">): UiPreferences {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return { ...defaultUiPreferences };
    const saved = source.getItem(UI_PREFERENCES_STORAGE_KEY);
    if (!saved) return { ...defaultUiPreferences };
    const parsed = JSON.parse(saved) as Partial<UiPreferences>;
    return { fontScalePercent: normalizedFontScale(parsed.fontScalePercent) };
  } catch {
    return { ...defaultUiPreferences };
  }
}

export function uiFontSizePixels(preferences: UiPreferences): number {
  return 16 * normalizedFontScale(preferences.fontScalePercent) / 100;
}

export function applyUiPreferences(preferences: UiPreferences, root?: HTMLElement): UiPreferences {
  const normalized = { fontScalePercent: normalizedFontScale(preferences.fontScalePercent) };
  const target = root ?? (typeof document === "undefined" ? undefined : document.documentElement);
  if (target) {
    target.style.setProperty("--ui-root-font-size", `${uiFontSizePixels(normalized)}px`);
    target.dataset.uiFontScale = String(normalized.fontScalePercent);
  }
  return normalized;
}

export function saveUiPreferences(preferences: UiPreferences, storage?: Pick<Storage, "setItem">, root?: HTMLElement): UiPreferences {
  const normalized = applyUiPreferences(preferences, root);
  try {
    const destination = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    destination?.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Storage can be blocked without preventing the live preference from applying.
  }
  return normalized;
}

export function initializeUiPreferences(): UiPreferences {
  return applyUiPreferences(readUiPreferences());
}
