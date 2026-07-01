import type { NextApiRequest, NextApiResponse } from 'next';
import nodeMailer from 'nodemailer';
import { ensureSynced } from '../../database/database';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import generateEmail from '../../utils/generateEmail';
import parseKeywords from '../../utils/parseKeywords';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import resolveDomainAccess from '../../utils/domain-access';
import type Account from '../../database/models/account';
import { getAppSettings } from './settings';
import { composeDailyBriefForDomain } from './daily-brief';
import { renderDailyBriefHtml } from '../../utils/daily-brief-render';

// The scheduled daily brief is OPT-IN and OFF by default. It only sends when this env flag is
// truthy, so enabling the proactive-analyst email is a deliberate act and a deploy never starts
// spamming. The flag gates the EXTRA brief email only; the existing keyword-position email is
// unchanged and still governed solely by the domain's `notification` toggle + interval.
const isDailyBriefEnabled = (): boolean => {
   const v = String(process.env.DAILY_BRIEF_ENABLED || '').trim().toLowerCase();
   return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

// The window the scheduled brief compares period-over-period. A weekly "what changed and what to
// do" standup is the natural cadence; overridable so a deployment can tune it without code change.
const dailyBriefPeriod = (): string => {
   const p = String(process.env.DAILY_BRIEF_PERIOD || '').trim();
   return /^\d+\s*[dhwm]$/i.test(p) ? p : '7d';
};

type NotifyResponse = {
   success?: boolean
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   if (req.method === 'POST') {
      await ensureSynced();
      const { authorized, account, error } = await authorize(req, res);
      if (!authorized) {
         return res.status(401).json({ success: false, error });
      }
      return notify(req, res, account);
   }
   return res.status(401).json({ success: false, error: 'Invalid Method' });
}

const notify = async (req: NextApiRequest, res: NextApiResponse<NotifyResponse>, account?: Account | null) => {
   const reqDomain = req?.query?.domain as string || '';
   try {
      const settings = await getAppSettings();
      const { smtp_server = '', smtp_port = '', notification_email = '' } = settings;

      if (!smtp_server || !smtp_port || !notification_email) {
         return res.status(401).json({ success: false, error: 'SMTP has not been setup properly!' });
      }

      if (reqDomain) {
         // Triggering a notification email is an owner action on the domain's data, so use
         // the WRITE gate: a shared read-only viewer (M2) must not be able to fire emails on
         // a domain owned by someone else. Owner-only now and after sharing lands.
         const theDomain = await resolveDomainAccess(account, reqDomain, { write: true });
         if (theDomain) {
            await sendNotificationEmail(theDomain, settings, account);
            // Additive, opt-in second email. Never throws into the keyword-email path: the brief
            // is best-effort and any failure is swallowed inside composeAndSendDailyBrief. Gate on the
            // domain's notification toggle too, so an explicit per-domain trigger honors a disabled
            // domain exactly like the no-domain cron loop below does (consistent toggle behavior).
            if (isDailyBriefEnabled() && theDomain.notification !== false) {
               await composeAndSendDailyBrief(theDomain, settings, account);
            }
         }
      } else {
         const allDomains: Domain[] = await Domain.findAll({ where: { ...scopeWhere(account) } });
         if (allDomains && allDomains.length > 0) {
            const domains = allDomains.map((el) => el.get({ plain: true }));
            const briefEnabled = isDailyBriefEnabled();
            for (const domain of domains) {
               if (domain.notification !== false) {
                  await sendNotificationEmail(domain, settings, account);
                  // composeAndSendDailyBrief issues its own (~17) reads per domain, separate from the
                  // keyword email's. Acceptable: it is gated behind DAILY_BRIEF_ENABLED (off by default),
                  // so the extra read amplification only happens when an operator opts in.
                  if (briefEnabled) {
                     await composeAndSendDailyBrief(domain, settings, account);
                  }
               }
            }
         }
      }

      return res.status(200).json({ success: true, error: null });
   } catch (error) {
      console.log(error);
      return res.status(401).json({ success: false, error: 'Error Sending Notification Email.' });
   }
};

const sendNotificationEmail = async (domain: Domain, settings: SettingsType, account?: Account | null) => {
   const {
      smtp_server = '',
      smtp_port = '',
      smtp_username = '',
      smtp_password = '',
      notification_email = '',
      notification_email_from = '',
      notification_email_from_name = 's33k',
     } = settings;

   const fromEmail = `${notification_email_from_name} <${notification_email_from || 'no-reply@s33k.io'}>`;
   const mailerSettings:any = { host: smtp_server, port: parseInt(smtp_port, 10) };
   if (smtp_username || smtp_password) {
      mailerSettings.auth = {};
      if (smtp_username) mailerSettings.auth.user = smtp_username;
      if (smtp_password) mailerSettings.auth.pass = smtp_password;
   }
   const transporter = nodeMailer.createTransport(mailerSettings);
   const domainName = domain.domain;
   const query = { where: { domain: domainName, ...scopeWhere(account) } };
   const domainKeywords:Keyword[] = await Keyword.findAll(query);
   const keywordsArray = domainKeywords.map((el) => el.get({ plain: true }));
   const keywords: KeywordType[] = parseKeywords(keywordsArray);
   const emailHTML = await generateEmail(domainName, keywords, settings);
   await transporter.sendMail({
      from: fromEmail,
      to: domain.notification_emails || notification_email,
      subject: `[${domainName}] Keyword Positions Update`,
      html: emailHTML,
   }).catch((err:any) => console.log('[ERROR] Sending Notification Email for', domainName, err?.response || err));
};

/**
 * Compose and send the proactive DAILY BRIEF email for one already-owned domain.
 *
 * This is the PUSH half of daily_brief: the same brief the GET /api/daily-brief route returns,
 * rendered to HTML (utils/daily-brief-render) and delivered to the domain's notification_emails
 * (falling back to the global notification_email) over the EXISTING SMTP transport. It is
 * ADDITIVE: it runs alongside the keyword-position email, never replaces it, and is only ever
 * called when DAILY_BRIEF_ENABLED is set (see isDailyBriefEnabled). It composes the brief with NO
 * HTTP round-trip by calling composeDailyBriefForDomain directly, so the email and the on-demand
 * route are byte-identical by construction.
 *
 * Resilient: it never throws into the caller's loop. A compose failure or a send failure is logged
 * and swallowed so one domain's brief failure can never abort the rest of the notification run or
 * break the keyword email that already sent.
 *
 * @param {Domain} domain - The owned domain (plain or model) to brief.
 * @param {SettingsType} settings - App settings carrying the SMTP config.
 * @param {Account | null | undefined} account - The resolved account for scoping.
 * @returns {Promise<void>}
 */
export const composeAndSendDailyBrief = async (domain: Domain, settings: SettingsType, account?: Account | null): Promise<void> => {
   const {
      smtp_server = '',
      smtp_port = '',
      smtp_username = '',
      smtp_password = '',
      notification_email = '',
      notification_email_from = '',
      notification_email_from_name = 's33k',
   } = settings;
   const domainName = domain.domain;
   try {
      const brief = await composeDailyBriefForDomain(domainName, dailyBriefPeriod(), account);
      const html = renderDailyBriefHtml(brief);

      const fromEmail = `${notification_email_from_name} <${notification_email_from || 'no-reply@s33k.io'}>`;
      const mailerSettings:any = { host: smtp_server, port: parseInt(smtp_port, 10) };
      if (smtp_username || smtp_password) {
         mailerSettings.auth = {};
         if (smtp_username) mailerSettings.auth.user = smtp_username;
         if (smtp_password) mailerSettings.auth.pass = smtp_password;
      }
      const transporter = nodeMailer.createTransport(mailerSettings);
      // Collapse any internal whitespace / control chars in the headline before it goes into the
      // Subject, so a headline carrying odd characters (it is built from keyword / page-path text)
      // renders as one clean line. nodemailer already encodes the header against injection; this is
      // purely cosmetic. The body is separately escaped via escapeHtml in renderDailyBriefHtml.
      const cleanHeadline = String(brief.headline || '').replace(/\s+/g, ' ').trim();
      await transporter.sendMail({
         from: fromEmail,
         to: domain.notification_emails || notification_email,
         subject: `[${domainName}] Daily Brief: ${cleanHeadline}`.slice(0, 160),
         html,
      });
   } catch (err:any) {
      console.log('[ERROR] Sending Daily Brief Email for', domainName, err?.response || err);
   }
};
