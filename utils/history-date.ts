// Rank-history date keys are written by utils/refresh.ts. As of 2026-06 they are ISO and UTC-padded
// ("2026-06-09"). Existing history written before that fix uses a non-padded, locale-ambiguous form
// ("2026-6-9"), which new Date(key) parses as LOCAL midnight and which sorts wrong lexically against
// padded keys. This module is the one place that reconciles BOTH formats so every parser agrees and
// old history keeps sorting/clipping correctly. Always route a stored history date key through here.

// Normalize a stored history date key to a padded ISO "YYYY-MM-DD" string. Accepts the old
// non-padded "YYYY-M-D" form and the new padded "YYYY-MM-DD" form; anything else returns null.
export const normalizeHistoryDateKey = (key: string): string | null => {
   const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(key || '').trim());
   if (!m) { return null; }
   const [, y, mo, d] = m;
   return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
};

// Parse a stored history date key to UTC-midnight epoch ms, tolerant of both the old and new format.
// Returns NaN when the key is not a recognizable date so callers can drop it with Number.isNaN.
export const historyDateMs = (key: string): number => {
   const iso = normalizeHistoryDateKey(key);
   if (!iso) { return NaN; }
   // Append the UTC marker so parsing is timezone-stable (a bare date parses as UTC for ISO, but be
   // explicit so the window math, which uses Date.now() UTC bounds, always lines up).
   return new Date(`${iso}T00:00:00Z`).getTime();
};
