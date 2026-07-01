// The single, structured source of s33k's trust facts. SECURITY.md is the prose
// companion to this file; both say the same thing. The GET /api/security route
// returns this object, and the security_facts MCP tool wraps that route, so a
// self-hoster can ask their own LLM "is this safe? does it train on my data?"
// and get a complete, verifiable, source-cited answer.
//
// This module is intentionally dependency-free (no model imports, no sequelize)
// so the route stays lightweight and the facts can be imported anywhere.

export type SecurityFact = {
   id: string,
   question: string,
   answer: string,
   verifyIn: string[],
};

export type SecurityFacts = {
   principle: string,
   summary: string,
   facts: SecurityFact[],
   subProcessors: { name: string, role: string, notes: string }[],
   trustDoc: string,
};

export const securityFacts: SecurityFacts = {
   principle: 'Verify us, don\'t trust us. s33k is open source and self-hosted, so every claim '
      + 'here can be confirmed by reading the code or by owning the deployment yourself.',
   summary: 'You can run s33k with zero security fear: it cannot train on your data (no '
      + 'model-training pipeline exists in the code), it is a single-user tool so there is no '
      + 'cross-account boundary to breach, connected credentials are encrypted at rest (the '
      + 'analytics substrate is plaintext by necessity, the honest residual), tracking is '
      + 'cookieless with no PII, and you can export everything on demand.',
   facts: [
      {
         id: 'no_training',
         question: 'Do you train on my data?',
         answer: 'No, and it is structurally impossible, not just a policy. s33k has NO '
            + 'model-training pipeline, NO LLM client, and NO embedding or fine-tuning step '
            + 'anywhere in the codebase. The AI features (daily briefing, cross-pillar insights, '
            + 'AI-visibility funnel) are rules-based: s33k runs transparent rules over your own '
            + 'data on the server and hands the structured result to YOUR OWN LLM over MCP for '
            + 'interpretation. Your data never leaves the server for any model.',
         verifyIn: [
            'pages/api/briefing.ts (trust marker + "RULES-BASED. It does NOT call any LLM")',
            'pages/api/insights.ts (trust marker + "RULES-BASED. It does NOT call any LLM")',
            'pages/api/ai-visibility.ts (trust marker + "It NEVER queries an LLM")',
         ],
      },
      {
         id: 'single_user',
         question: 'Who else can see my data?',
         answer: 'Only you. s33k is a single-user tool: there are no other accounts, no signup, and '
            + 'no invites, so there is no cross-account boundary to breach. You own the whole '
            + 'deployment, so all of the data is yours and s33k reads it freely to do its job '
            + '(compute rank trends, sessions, and cross-pillar joins). Access is a single admin '
            + 'login plus a single API key (the APIKEY, which the MCP server also uses), so anyone '
            + 'with the URL and that key can act as you: protect them accordingly. The strongest '
            + 'guarantee is the deployment model itself, because you host it, the data is yours end '
            + 'to end.',
         verifyIn: [
            'utils/resolveAccount.ts',
            'utils/authorize.ts',
            'the absence of any signup, invite, or account-management route in pages/api/',
         ],
      },
      {
         id: 'encryption_at_rest',
         question: 'Are my credentials encrypted? What is NOT encrypted?',
         answer: 'Your connected credentials (Google Search Console, Google Ads, the SERP scraper '
            + 'key, the SMTP password) are encrypted at rest with cryptr (AES-256) keyed by the app '
            + 'SECRET, decrypted only in memory, and never logged, exported, or sent to a model. Your '
            + 'API key is stored as a SHA-256 hash, never the clear key. THE HONEST RESIDUAL: your '
            + 'analytics substrate (autocapture events, tracked keywords and their rank history, '
            + 'domain names, AI-crawler hits) is stored in PLAINTEXT, because the server has to '
            + 'compute analytics over it (counts, sessions, rank trends, cross-pillar joins), so it '
            + 'cannot be zero-knowledge. Anyone with physical database or DB-credential access can '
            + 'read that analytics data; only the connected credentials are encrypted. This is '
            + 'exactly why self-hosting is the strongest guarantee: own the deployment, own that '
            + 'residual access.',
         verifyIn: [
            'pages/api/domains.ts',
            'pages/api/settings.ts',
            'utils/searchConsole.ts',
            'utils/adwords.ts',
         ],
      },
      {
         id: 'data_ownership',
         question: 'Can I take my data with me or delete it?',
         answer: 'Yes, both. GET /api/export (MCP tool export_data) downloads EVERYTHING s33k holds '
            + 'as one JSON bundle, with no secrets included. And because you own the database, '
            + 'deleting your data is direct: drop the rows, drop the database, or tear down the '
            + 'instance. There is no vendor holding your data hostage.',
         verifyIn: [
            'pages/api/export.ts',
            'mcp/src/index.ts (export_data)',
         ],
      },
      {
         id: 'open_source',
         question: 'Can I verify all of this myself?',
         answer: 'Yes. s33k is open source, so you can read every line of code that touches your '
            + 'data, and you can self-host the whole thing on your own infrastructure with your own '
            + 'database so your data never leaves your control. That is the strongest form of '
            + 'verify-don\'t-trust.',
         verifyIn: ['the repository itself', 'SECURITY.md'],
      },
      {
         id: 'cookieless_no_pii',
         question: 'Does your tracking use cookies or collect personal data?',
         answer: 'No. The autocapture script uses no cookies and no fingerprinting; its session id '
            + 'lives in sessionStorage only and rotates daily, so it cannot identify a person or be '
            + 'joined across days. It never reads the value of any input, textarea, select, '
            + 'contenteditable, or password field, and records THAT a form was submitted, never the '
            + 'field values. The server sanitizes every event and drops anything PII-shaped before '
            + 'storing it.',
         verifyIn: [
            'public/s33k.js (PRIVACY header)',
            'pages/api/collect.ts',
            'utils/event-sanitize.ts',
         ],
      },
   ],
   subProcessors: [
      {
         name: 'Serper',
         role: 'SERP data for keyword rank tracking.',
         notes: 'Runs server-side on your own key (scrapers/services/serper.ts); the key is encrypted at rest.',
      },
      {
         name: 'Google (optional)',
         role: 'Search Console / Google Ads data, only if you connect it.',
         notes: 'Credentials are encrypted at rest and used server-side only. Analytics is first-party (no external analytics sub-processor).',
      },
   ],
   trustDoc: 'SECURITY.md (full prose version of these facts, with a proof index).',
};

export default securityFacts;
