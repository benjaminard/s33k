import { classifyCrawler } from '../../utils/ai-crawlers';

describe('classifyCrawler', () => {
   it('maps each AI answer-engine bot to the right owner and flags it as an AI engine', () => {
      const cases: Array<{ ua: string, bot: string, owner: string }> = [
         { ua: 'Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)', bot: 'GPTBot', owner: 'OpenAI' },
         { ua: 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)', bot: 'OAI-SearchBot', owner: 'OpenAI' },
         { ua: 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)', bot: 'ChatGPT-User', owner: 'OpenAI' },
         { ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', bot: 'ClaudeBot', owner: 'Anthropic' },
         { ua: 'Mozilla/5.0 (compatible; Claude-Web/1.0)', bot: 'Claude-Web', owner: 'Anthropic' },
         { ua: 'Mozilla/5.0 (compatible; Claude-User/1.0)', bot: 'Claude-User', owner: 'Anthropic' },
         { ua: 'anthropic-ai/1.0', bot: 'anthropic-ai', owner: 'Anthropic' },
         { ua: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/bot)', bot: 'PerplexityBot', owner: 'Perplexity' },
         { ua: 'Mozilla/5.0 (compatible; Perplexity-User/1.0)', bot: 'Perplexity-User', owner: 'Perplexity' },
         { ua: 'Mozilla/5.0 (compatible; Google-Extended)', bot: 'Google-Extended', owner: 'Google' },
         { ua: 'Mozilla/5.0 (compatible; Applebot-Extended/0.1)', bot: 'Applebot-Extended', owner: 'Apple' },
         { ua: 'Mozilla/5.0 (compatible; BingPreview/1.0b)', bot: 'BingPreview', owner: 'Microsoft' },
         { ua: 'Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/amazonbot)', bot: 'Amazonbot', owner: 'Amazon' },
         { ua: 'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)', bot: 'Bytespider', owner: 'ByteDance' },
         { ua: 'CCBot/2.0 (https://commoncrawl.org/faq/)', bot: 'CCBot', owner: 'Common Crawl' },
         { ua: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', bot: 'Meta-ExternalAgent', owner: 'Meta' },
         { ua: 'facebookexternalhit/1.1 (FacebookBot)', bot: 'FacebookBot', owner: 'Meta' },
         { ua: 'Mozilla/5.0 (compatible; DuckAssistBot/1.0)', bot: 'DuckAssistBot', owner: 'DuckDuckGo' },
         { ua: 'cohere-ai/1.0', bot: 'cohere-ai', owner: 'Cohere' },
         { ua: 'Mozilla/5.0 (compatible; YouBot (+http://www.you.com))', bot: 'YouBot', owner: 'You.com' },
         { ua: 'Mozilla/5.0 (compatible; Diffbot/0.1; +http://www.diffbot.com)', bot: 'Diffbot', owner: 'Diffbot' },
         { ua: 'Mozilla/5.0 (compatible; ImagesiftBot; +imagesift.com)', bot: 'ImagesiftBot', owner: 'Imagesift' },
      ];
      for (const c of cases) {
         expect(classifyCrawler(c.ua)).toEqual({
            isCrawler: true, bot: c.bot, owner: c.owner, isAiEngine: true,
         });
      }
   });

   it('flags classic search crawlers as crawlers but not AI engines', () => {
      expect(classifyCrawler('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'))
         .toEqual({ isCrawler: true, bot: 'Googlebot', owner: 'Google', isAiEngine: false });
      expect(classifyCrawler('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'))
         .toEqual({ isCrawler: true, bot: 'Bingbot', owner: 'Microsoft', isAiEngine: false });
   });

   it('matches user-agents case-insensitively', () => {
      expect(classifyCrawler('GPTBOT/1.1'))
         .toEqual({ isCrawler: true, bot: 'GPTBot', owner: 'OpenAI', isAiEngine: true });
   });

   it('prefers the more-specific token when bots share a prefix', () => {
      expect(classifyCrawler('Mozilla/5.0 (compatible; BingPreview/1.0b)').bot).toBe('BingPreview');
      expect(classifyCrawler('Mozilla/5.0 (compatible; bingbot/2.0)').bot).toBe('Bingbot');
   });

   it('returns isCrawler false for a normal browser user-agent', () => {
      const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      expect(classifyCrawler(chrome)).toEqual({
         isCrawler: false, bot: null, owner: null, isAiEngine: false,
      });
      const safariMobile = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) '
         + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
      expect(classifyCrawler(safariMobile).isCrawler).toBe(false);
   });

   it('never throws on empty or bad input', () => {
      expect(classifyCrawler('')).toEqual({ isCrawler: false, bot: null, owner: null, isAiEngine: false });
      expect(classifyCrawler('   ')).toEqual({ isCrawler: false, bot: null, owner: null, isAiEngine: false });
      expect(classifyCrawler(null as unknown as string)).toEqual({
         isCrawler: false, bot: null, owner: null, isAiEngine: false,
      });
      expect(classifyCrawler(undefined as unknown as string)).toEqual({
         isCrawler: false, bot: null, owner: null, isAiEngine: false,
      });
   });
});
