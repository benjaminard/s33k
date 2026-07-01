import { suggestGoals } from '../../utils/goal-suggester';
import type { PageSummary } from '../../utils/site-crawl';

const page = (path: string, title: string): PageSummary => ({
   url: `https://x.com${path}`, path, title, metaDescription: '', h1: [], h2: [], excerpt: '',
});

describe('suggestGoals', () => {
   it('proposes a page_reached goal for a thank-you / destination page', () => {
      const s = suggestGoals([page('/demo/thank-you', 'Thanks for Booking a Demo')]);
      expect(s).toHaveLength(1);
      expect(s[0].kind).toBe('page_reached');
      expect(s[0].matchValue).toBe('/demo/thank-you');
   });

   it('proposes a form_submit goal for an intent page', () => {
      const s = suggestGoals([page('/demo', 'Book a Demo')]);
      expect(s).toHaveLength(1);
      expect(s[0].kind).toBe('event');
      expect(s[0].matchValue).toBe('form_submit');
      expect(s[0].matchPage).toBe('/demo');
   });

   it('ignores ordinary pages and dedupes', () => {
      const s = suggestGoals([
         page('/pricing', 'Pricing'),
         page('/about', 'About Us'),
         page('/blog/post', 'A Blog Post'),
         page('/contact', 'Contact'),
         page('/contact', 'Contact'), // dup
      ]);
      // Only /contact yields a suggestion, once.
      expect(s.filter((g) => g.matchPage === '/contact')).toHaveLength(1);
      expect(s.some((g) => g.matchValue === '/pricing')).toBe(false);
   });

   it('detects a success page by its title even without a thank-you path', () => {
      const s = suggestGoals([page('/r/abc123', 'Success! Your request was received')]);
      expect(s).toHaveLength(1);
      expect(s[0].kind).toBe('page_reached');
   });
});
