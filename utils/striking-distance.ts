// Striking distance: the highest-ROI SEO to-do list, as a pure query over tracked keywords.
//
// "Striking distance" is the SEO term for keywords that already rank but sit just off page one.
// They are the cheapest wins: the page already ranks, Google already trusts it for the term, so a
// small push (a better title, a paragraph, an internal link) tends to move it onto page one and
// into real click territory. A brand new keyword has to earn the rank from scratch; a striking
// distance keyword only has to climb a few spots. That is why this is the first list a marketer
// should work, not the last.
//
// This module is the pure join over Keyword rows. Given the domain's tracked keywords (each with a
// current Google position, the ranking url, and a history blob), it returns every keyword in the
// striking window (default positions 4 to 30), each annotated with the position delta over the
// tracked history so a marketer sees not just "close to page one" but "close AND improving" (lean
// in) versus "close but slipping" (defend it). No server-side LLM: it returns structured rows for
// the user's own LLM (and the briefing) to narrate.

export type StrikingKeyword = {
   keyword: string,
   position: number,
   url: string,
   // Position movement over the available history window. Lower position is better, so a NEGATIVE
   // delta means the keyword IMPROVED (e.g. 18 -> 12 is delta -6). null when history is missing or
   // too thin to compute a delta.
   positionDelta: number | null,
   // The first and last positions used to compute the delta, for transparency.
   startPosition: number | null,
   recentPosition: number,
   historyPoints: number,
};

export type StrikingInput = {
   keyword: string,
   position: number,
   // url and history arrive as the raw column values (url is a JSON string, history a JSON string
   // of { [date]: position }). Both are parsed defensively here so a malformed blob never throws.
   url: string,
   history: string,
};

// SerpBear stores a keyword's ranking url as a JSON array of urls (best-match first) or, on older
// rows, a bare string. Pull the first usable url out of either shape; empty string when none.
const firstUrl = (raw: string): string => {
   const s = String(raw || '').trim();
   if (!s) { return ''; }
   try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) { return parsed.length ? String(parsed[0] || '') : ''; }
      if (typeof parsed === 'string') { return parsed; }
      return '';
   } catch {
      // Not JSON: treat the raw value as the url itself (the legacy bare-string shape).
      return s;
   }
};

// history is a JSON string of { 'YYYY-MM-DD': position }. Return the chronological [date, position]
// pairs, oldest first, dropping non-positive positions (0 means "not in the top 100 that day",
// which is not a real rank and would distort a delta). Empty array when history is missing/invalid.
const historyPairs = (raw: string): Array<[string, number]> => {
   const s = String(raw || '').trim();
   if (!s) { return []; }
   try {
      const parsed = JSON.parse(s);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return []; }
      return Object.entries(parsed as Record<string, unknown>)
         .map(([date, pos]) => [date, Number(pos)] as [string, number])
         .filter(([, pos]) => Number.isFinite(pos) && pos > 0)
         .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
   } catch {
      return [];
   }
};

/**
 * Scan tracked keywords and return the striking distance "quick win" list (positions min..max),
 * each annotated with its position delta over the tracked history. Sorts by closeness to page one
 * (lower position first) then by recent improvement (more-improved first) so the easiest, most
 * upward-moving wins surface at the top.
 * @param {StrikingInput[]} keywords - The domain's tracked keywords (position, url, history).
 * @param {number} min - Inclusive lower bound of the striking window (default 4).
 * @param {number} max - Inclusive upper bound of the striking window (default 30).
 * @returns {StrikingKeyword[]}
 */
export const findStrikingDistance = (keywords: StrikingInput[], min: number, max: number): StrikingKeyword[] => {
   const rows: StrikingKeyword[] = [];
   for (const k of keywords) {
      const position = Number(k.position) || 0;
      // Only keywords inside the striking window. position 0 (untracked / outside top 100) and 1 to
      // (min-1) (already on page one) are not "quick wins" and are intentionally excluded.
      if (position < min || position > max) { continue; }

      const pairs = historyPairs(k.history);
      const startPosition = pairs.length >= 2 ? pairs[0][1] : null;
      // Prefer the current live position as the "recent" value; fall back to the last history point
      // when the live position somehow falls outside the window (should not, given the guard above).
      const recentPosition = position;
      // delta = recent - start. Negative == improved (climbed toward page one). null when there is
      // not enough history (fewer than 2 valid points) to compute a real movement.
      const positionDelta = startPosition === null ? null : recentPosition - startPosition;

      rows.push({
         keyword: String(k.keyword),
         position,
         url: firstUrl(k.url),
         positionDelta,
         startPosition,
         recentPosition,
         historyPoints: pairs.length,
      });
   }

   // Sort: closest to page one first (ascending position), then most-improved first. A null delta
   // (no history) sorts after keywords with a real improvement but ahead of those that slipped, by
   // treating it as 0 movement, so it does not jump above genuinely improving keywords.
   return rows.sort((a, b) => {
      if (a.position !== b.position) { return a.position - b.position; }
      const da = a.positionDelta === null ? 0 : a.positionDelta;
      const db = b.positionDelta === null ? 0 : b.positionDelta;
      return da - db;
   });
};
