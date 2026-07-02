import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import resolveDomainAccess from '../../utils/domain-access';
import { computeSetupState, computeModules, ModuleStatus } from '../../utils/start-here';
import { isSeoConfigured } from '../../utils/setupState';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import Goal from '../../database/models/goal';
import type Account from '../../database/models/account';

// GET /api/onboarding-status?domain=...
//
// The guided-setup walkthrough, in s33k's no-UI, LLM-native shape. It reports where a user is in
// setup (domain added, keywords tracked, tracking script live, conversion goals defined) and the
// single next step with the exact tool to call. The user's own LLM uses this to walk a new user
// from zero to value conversationally, so onboarding is a guided walkthrough, not a blank slate.

type Step = { key: string, title: string, done: boolean, detail: string, nextTool: string };
// The first-run pointer. Always returned so a brand-new user (or someone a domain was just shared
// with) is immediately told the dashboard exists and what to ask for the full picture. It is a
// pointer, NOT a counted setup step, so it never moves percentComplete (the existing setup test
// asserts 100% / null nextStep when the real steps are done).
type FirstRunHint = { title: string, detail: string, nextTool: string };
type Resp = {
   domain?: string,
   percentComplete?: number,
   steps?: Step[],
   nextStep?: Step | null,
   firstRunHint?: FirstRunHint,
   modules?: ModuleStatus[],
   message?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getStatus(req, res, account);
}

const getStatus = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
   const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }

   try {
      const scope = scopeWhere(account);
      const owned = await resolveDomainAccess(account, domain);
      // Recent events = the tracking script is live and sending. 7-day window.
      const weekAgo = new Date(Date.now() - 7 * 86400e3).toJSON();
      const [keywordCount, keywordsPending, recentEvents, goalCount] = await Promise.all([
         owned ? Keyword.count({ where: { domain, ...scope } }) : Promise.resolve(0),
         // Rank-pending keywords: first Google check not landed yet (keyword.updating === true).
         owned ? Keyword.count({ where: { domain, updating: true, ...scope } }) : Promise.resolve(0),
         owned ? S33kEvent.count({ where: { domain, created: { [Op.gte]: weekAgo }, ...scope } }) : Promise.resolve(0),
         owned ? Goal.count({ where: { domain, ...scope } }) : Promise.resolve(0),
      ]);

      // All tracked keywords are still rank-pending: tracking is set up, but the first Google check
      // has not landed, so the track_keywords step should say "queued, first check running" rather
      // than imply done-with-no-results.
      const keywordsRankPending = keywordCount > 0 && keywordsPending >= keywordCount;

      // MODULAR PILLARS: the SEO module is enabled iff a SERP scraper key is configured. When it
      // is off, the checklist omits the keywords step (an off module is not missing setup), so a
      // keyless analytics-first instance can reach complete. Fail OPEN to the legacy five-step
      // shape on a settings-read error, never 500 the walkthrough.
      const seoEnabled = await isSeoConfigured().catch(() => true);

      // The setup steps + percentComplete + nextStep are computed by the SHARED
      // computeSetupState (utils/start-here.ts), the single source of truth, so setup_status and
      // start_here can never disagree about where a user is in setup.
      const { steps, percentComplete, nextStep } = computeSetupState({
         owned: Boolean(owned), keywordCount, recentEvents, goalCount, domain, keywordsRankPending, seoEnabled,
      });
      const modules = computeModules({ recentEvents, seoEnabled, keywordCount });

      // Always point at the dashboard as the place to start. When setup is complete this is the
      // headline next move; when it is not, it is the closing hint so a brand-new user always
      // knows the one-shot overview exists and the plain-language questions they can ask.
      const firstRunHint: FirstRunHint = nextStep
         ? {
            title: 'See your dashboard any time',
            detail: `Finish setup above, then ask "show me my dashboard" for the full overview of ${domain}, `
               + 'or just ask plain questions like "what should I do next?".',
            nextTool: 'dashboard',
         }
         : {
            title: 'See your dashboard',
            detail: 'You are set up. Ask "show me my dashboard" any time for the full overview, '
               + 'or "what should I do next?".',
            nextTool: 'dashboard',
         };

      // When the SEO module is off, say so as an OPTIONAL module with its conversational
      // enablement path, so the checklist never reads as "missing" what is simply not enabled.
      const seoNote = seoEnabled ? ''
         : ' The SEO module is off (optional): ask me to enable SEO and I will mint a key-drop command.';
      const message = nextStep
         ? `Setup is ${percentComplete}% done. Next: ${nextStep.title}. ${nextStep.detail} Use ${nextStep.nextTool}. `
            + `When you are ready, ask "show me my dashboard" for the full overview of ${domain}.${seoNote}`
         : `Setup is complete for ${domain}. Ask "show me my dashboard" for the full overview, `
            + `or "what should I do next?" any time.${seoNote}`;

      return res.status(200).json({ domain, percentComplete, steps, nextStep, firstRunHint, modules, message, error: null });
   } catch (error) {
      console.log('[ERROR] Building onboarding status for ', domain, error);
      return res.status(400).json({ error: 'Error Building Onboarding Status for this Domain.' });
   }
};
