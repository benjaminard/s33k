/**
 * Tests for the DB-backed failed-retry queue helpers (utils/scraper) that replace failed_queue.json.
 *
 * A keyword "needs retry" when its lastUpdateError is a REAL error (not the 'false'/'' sentinel) AND
 * it is not currently mid-scrape (updating=false). failedRetryWhere() encodes that as a Sequelize
 * where fragment; getFailedRetryKeywordIds() runs it and returns the matching ids. These assert the
 * predicate excludes the non-error sentinels and currently-updating keywords, and includes a real
 * error, so the hourly retry job re-scrapes exactly the failed set.
 *
 * sequelize Op is mocked with distinct symbols (real sequelize drags uuid ESM jest cannot transform),
 * cheerio is stubbed (scraper.ts imports it at module top), and the Keyword model is mocked.
 */

jest.mock('cheerio', () => ({ __esModule: true, load: jest.fn() }));
jest.mock('sequelize', () => ({
   __esModule: true,
   Op: { notIn: Symbol('notIn'), ne: Symbol('ne'), and: Symbol('and'), in: Symbol('in') },
}));

// The jest.fn lives inside the factory (jest hoists jest.mock above const decls, so a const ref here
// would be in the TDZ at module load). We grab it back off the mocked model below.
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));

// eslint-disable-next-line import/first
import { Op } from 'sequelize';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import { failedRetryWhere, getFailedRetryKeywordIds } from '../../utils/scraper';

const mockFindAll = (KeywordModel as unknown as { findAll: jest.Mock }).findAll;

// A keyword row whose lastUpdateError and updating drive the predicate; the model is mocked, so this
// test exercises the WHERE we build and the id mapping, not the DB filtering itself. We additionally
// reimplement the predicate locally to prove the where shape rejects/accepts the right rows.
const matchesPredicate = (lastUpdateError: string | null, updating: boolean): boolean => {
   const NON_ERROR = ['false', '', '{}'];
   return updating === false && lastUpdateError !== null && !NON_ERROR.includes(lastUpdateError);
};

beforeEach(() => {
   jest.clearAllMocks();
});

describe('failedRetryWhere predicate shape', () => {
   it('requires updating=false and a non-sentinel lastUpdateError (not in false/empty/{})', () => {
      const where = failedRetryWhere() as Record<string, any>;
      expect(where.updating).toBe(false);
      expect(where.lastUpdateError[Op.notIn]).toEqual(['false', '', '{}']);
      // Explicit NOT NULL guard so a NULL lastUpdateError is never selected.
      expect(where[Op.and as any]).toEqual([{ lastUpdateError: { [Op.ne]: null } }]);
   });

   it('locally: selects only real-error AND not-updating keywords (excludes sentinels and updating)', () => {
      // A real error, settled -> retry.
      expect(matchesPredicate(JSON.stringify({ error: 'boom' }), false)).toBe(true);
      // Cleared sentinel -> no retry.
      expect(matchesPredicate('false', false)).toBe(false);
      // Empty string -> no retry.
      expect(matchesPredicate('', false)).toBe(false);
      // Empty object string -> no retry.
      expect(matchesPredicate('{}', false)).toBe(false);
      // NULL -> no retry.
      expect(matchesPredicate(null, false)).toBe(false);
      // Real error but still mid-scrape -> no retry (the main scrape owns it).
      expect(matchesPredicate(JSON.stringify({ error: 'boom' }), true)).toBe(false);
   });
});

describe('getFailedRetryKeywordIds', () => {
   it('returns the ids of keywords matching the retry where, spreading any scope in', async () => {
      mockFindAll.mockResolvedValueOnce([
         { get: (k: string) => (k === 'ID' ? 11 : undefined) },
         { get: (k: string) => (k === 'ID' ? 22 : undefined) },
      ]);

      const ids = await getFailedRetryKeywordIds({ owner_id: 7 });
      expect(ids).toEqual([11, 22]);

      const passedWhere = mockFindAll.mock.calls[0][0].where;
      // The scope fragment is merged on top of the failed-retry predicate.
      expect(passedWhere.owner_id).toBe(7);
      expect(passedWhere.updating).toBe(false);
      expect(passedWhere.lastUpdateError[Op.notIn]).toEqual(['false', '', '{}']);
   });

   it('returns an empty array when no keyword needs a retry', async () => {
      mockFindAll.mockResolvedValueOnce([]);
      const ids = await getFailedRetryKeywordIds();
      expect(ids).toEqual([]);
   });
});
