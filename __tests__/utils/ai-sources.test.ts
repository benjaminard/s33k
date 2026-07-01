import { classifyReferrer } from '../../utils/ai-sources';

describe('classifyReferrer', () => {
   it('maps known AI hosts to the right engine', () => {
      expect(classifyReferrer('chatgpt.com')).toEqual({ isAI: true, engine: 'ChatGPT' });
      expect(classifyReferrer('chat.openai.com')).toEqual({ isAI: true, engine: 'ChatGPT' });
      expect(classifyReferrer('www.perplexity.ai')).toEqual({ isAI: true, engine: 'Perplexity' });
      expect(classifyReferrer('gemini.google.com')).toEqual({ isAI: true, engine: 'Gemini' });
      expect(classifyReferrer('claude.ai')).toEqual({ isAI: true, engine: 'Claude' });
      expect(classifyReferrer('copilot.microsoft.com')).toEqual({ isAI: true, engine: 'Copilot' });
      expect(classifyReferrer('you.com')).toEqual({ isAI: true, engine: 'You.com' });
      expect(classifyReferrer('poe.com')).toEqual({ isAI: true, engine: 'Poe' });
      expect(classifyReferrer('deepseek.com')).toEqual({ isAI: true, engine: 'DeepSeek' });
      expect(classifyReferrer('grok.com')).toEqual({ isAI: true, engine: 'Grok' });
   });

   it('classifies provider-supplied labels, case-insensitively', () => {
      expect(classifyReferrer('ChatGPT')).toEqual({ isAI: true, engine: 'ChatGPT' });
      expect(classifyReferrer('CLAUDE')).toEqual({ isAI: true, engine: 'Claude' });
      expect(classifyReferrer('Perplexity')).toEqual({ isAI: true, engine: 'Perplexity' });
   });

   it('parses full URLs and matches host plus path patterns', () => {
      expect(classifyReferrer('https://www.perplexity.ai/search?q=foo'))
         .toEqual({ isAI: true, engine: 'Perplexity' });
      expect(classifyReferrer('https://chatgpt.com/')).toEqual({ isAI: true, engine: 'ChatGPT' });
      expect(classifyReferrer('https://www.bing.com/chat')).toEqual({ isAI: true, engine: 'Copilot' });
   });

   it('returns isAI false for non-AI sources', () => {
      expect(classifyReferrer('google.com')).toEqual({ isAI: false, engine: null });
      expect(classifyReferrer('linkedin.com')).toEqual({ isAI: false, engine: null });
      expect(classifyReferrer('https://news.ycombinator.com/')).toEqual({ isAI: false, engine: null });
      expect(classifyReferrer('Direct / None')).toEqual({ isAI: false, engine: null });
   });

   it('never throws on empty or bad input', () => {
      expect(classifyReferrer('')).toEqual({ isAI: false, engine: null });
      expect(classifyReferrer('   ')).toEqual({ isAI: false, engine: null });
      expect(classifyReferrer(null as unknown as string)).toEqual({ isAI: false, engine: null });
      expect(classifyReferrer(undefined as unknown as string)).toEqual({ isAI: false, engine: null });
   });
});
