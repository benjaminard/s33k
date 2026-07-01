import Keyword from '../database/models/keyword';

// Parse a stored JSON column defensively. A single corrupt/truncated blob in ONE keyword row must
// not throw and collapse a whole-domain read (e.g. competitor_visibility maps over every keyword);
// a bad row degrades to the empty fallback instead of poisoning the entire request. Valid JSON is
// byte-for-byte unchanged. The scraper always writes valid JSON, so this only fires on a corrupt write.
// Returns `any` (like the JSON.parse it replaces) so the parsed fields keep assigning cleanly to
// KeywordType. The fallback is used only when the stored blob is corrupt and JSON.parse throws.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const safeParse = (raw: unknown, fallback: any): any => {
   try {
      return JSON.parse(String(raw));
   } catch {
      return fallback;
   }
};

/**
 * Parses the SQL Keyword Model object to frontend consumable object.
 * @param {Keyword[]} allKeywords - Keywords to scrape
 * @returns {KeywordType[]}
 */
const parseKeywords = (allKeywords: Keyword[]) : KeywordType[] => {
   const parsedItems = allKeywords.map((keywrd:Keyword) => {
      // lastUpdateError is a nullable column (allowNull: true), so a row can legitimately hold NULL
      // (raw write, update({ lastUpdateError: null }), or a migration adding the column to old rows
      // before the default applies). Guard the string access the same way the sibling JSON fields are
      // defended by safeParse: a single bad/NULL row must not throw and collapse a whole-domain read.
      const lue = keywrd.lastUpdateError;
      const lastUpdateError = (typeof lue === 'string' && lue !== 'false' && lue.includes('{')) ? safeParse(lue, false) : false;
      return {
         ...keywrd,
         target_page: keywrd.target_page || '',
         history: safeParse(keywrd.history, {}),
         tags: safeParse(keywrd.tags, []),
         lastResult: safeParse(keywrd.lastResult, []),
         lastUpdateError,
      };
   });
   return parsedItems;
};

export default parseKeywords;
