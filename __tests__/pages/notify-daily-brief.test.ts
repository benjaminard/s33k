/**
 * Tests for the PUSH half of daily_brief wired into the notification cron
 * (pages/api/notify.ts): composeAndSendDailyBrief and the DAILY_BRIEF_ENABLED flag.
 *
 * The contracts under test:
 *   1. OPT-IN / SAFE-BY-DEFAULT: with DAILY_BRIEF_ENABLED unset, the notify run sends
 *      only the existing keyword-position email and NEVER the brief email, so enabling
 *      a deploy can never start spamming briefs.
 *   2. ENABLED: with the flag truthy, the brief email is sent ALONGSIDE (not instead
 *      of) the keyword email.
 *   3. RECIPIENTS: composeAndSendDailyBrief targets the domain's notification_emails,
 *      falling back to the global notification_email when the domain has none.
 *   4. RESILIENT: a compose/send failure is swallowed, never thrown into the cron loop.
 *
 * nodemailer, generateEmail, the daily-brief composer, settings, and the models are
 * mocked; the flag logic and recipient selection run for real. No DB, no SMTP.
 */

const sendMailMock = jest.fn().mockResolvedValue(undefined);
jest.mock('nodemailer', () => ({ __esModule: true, default: { createTransport: jest.fn(() => ({ sendMail: sendMailMock })) } }));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) }, ensureSynced: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/domain-access', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../utils/generateEmail', () => ({ __esModule: true, default: jest.fn().mockResolvedValue('<p>keyword email</p>') }));
jest.mock('../../utils/parseKeywords', () => ({ __esModule: true, default: jest.fn(() => []) }));
jest.mock('../../pages/api/settings', () => ({
   __esModule: true,
   getAppSettings: jest.fn().mockResolvedValue({
      smtp_server: 'smtp.test', smtp_port: '587', smtp_username: 'u', smtp_password: 'p',
      notification_email: 'fallback@example.com', notification_email_from: 'from@example.com', notification_email_from_name: 's33k',
   }),
}));
// The daily-brief composer is mocked so this suite tests the WIRING (flag + recipients +
// resilience), not the compose logic (covered in daily-brief.test.ts).
const composeMock = jest.fn();
jest.mock('../../pages/api/daily-brief', () => ({ __esModule: true, composeDailyBriefForDomain: (...a: unknown[]) => composeMock(...a) }));

// eslint-disable-next-line import/first
import handler, { composeAndSendDailyBrief } from '../../pages/api/notify';
// eslint-disable-next-line import/first
import authorize from '../../utils/authorize';
// eslint-disable-next-line import/first
import Domain from '../../database/models/domain';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockedDomainFindAll = (Domain as unknown as { findAll: jest.Mock }).findAll;

const okBrief = (domain: string) => ({
   domain, period: '7d', headline: 'Quiet period.', quiet: true, whatChanged: [], topAction: 'Keep pages fresh.',
});

const makeReqRes = (query: Record<string, string> = {}) => {
   const req = { method: 'POST', query, headers: {}, url: '/api/notify' } as any;
   const captured: { status: number, body: any } = { status: 0, body: null };
   const res: any = {
      status(code: number) { captured.status = code; return res; },
      json(payload: any) { captured.body = payload; return res; },
   };
   return { req, res, captured };
};

beforeEach(() => {
   jest.clearAllMocks();
   delete process.env.DAILY_BRIEF_ENABLED;
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   composeMock.mockImplementation((domain: string) => Promise.resolve(okBrief(domain)));
   // One domain with notifications on and its own recipient list.
   mockedDomainFindAll.mockResolvedValue([
      { get: () => ({ domain: 'getmasset.com', notification: true, notification_emails: 'owner@example.com' }) },
   ]);
});

describe('DAILY_BRIEF_ENABLED gate (all-domains cron path)', () => {
   it('does NOT send the brief email when the flag is unset (keyword email still sends)', async () => {
      const { req, res, captured } = makeReqRes();
      await handler(req, res);
      expect(captured.status).toBe(200);
      // Exactly one email sent: the keyword email. No brief email.
      expect(sendMailMock).toHaveBeenCalledTimes(1);
      const subjects = sendMailMock.mock.calls.map((c) => c[0].subject as string);
      expect(subjects.some((s) => /Keyword Positions Update/.test(s))).toBe(true);
      expect(subjects.some((s) => /Daily Brief/.test(s))).toBe(false);
      // The composer was never invoked when the flag is off.
      expect(composeMock).not.toHaveBeenCalled();
   });

   it('DOES send the brief email ALONGSIDE the keyword email when the flag is on', async () => {
      process.env.DAILY_BRIEF_ENABLED = 'true';
      const { req, res, captured } = makeReqRes();
      await handler(req, res);
      expect(captured.status).toBe(200);
      // Two emails: keyword + brief.
      expect(sendMailMock).toHaveBeenCalledTimes(2);
      const subjects = sendMailMock.mock.calls.map((c) => c[0].subject as string);
      expect(subjects.some((s) => /Keyword Positions Update/.test(s))).toBe(true);
      expect(subjects.some((s) => /Daily Brief/.test(s))).toBe(true);
   });
});

describe('composeAndSendDailyBrief: recipients and resilience', () => {
   const settings: any = {
      smtp_server: 'smtp.test', smtp_port: '587', notification_email: 'fallback@example.com',
      notification_email_from: 'from@example.com', notification_email_from_name: 's33k',
   };

   it('targets the domain notification_emails when present', async () => {
      await composeAndSendDailyBrief({ domain: 'getmasset.com', notification_emails: 'owner@example.com' } as any, settings, { ID: 1 } as any);
      expect(sendMailMock).toHaveBeenCalledTimes(1);
      expect(sendMailMock.mock.calls[0][0].to).toBe('owner@example.com');
   });

   it('falls back to the global notification_email when the domain has none', async () => {
      await composeAndSendDailyBrief({ domain: 'getmasset.com', notification_emails: '' } as any, settings, { ID: 1 } as any);
      expect(sendMailMock).toHaveBeenCalledTimes(1);
      expect(sendMailMock.mock.calls[0][0].to).toBe('fallback@example.com');
   });

   it('swallows a compose failure and never throws into the caller', async () => {
      composeMock.mockRejectedValueOnce(new Error('compose exploded'));
      await expect(
         composeAndSendDailyBrief({ domain: 'getmasset.com', notification_emails: 'owner@example.com' } as any, settings, { ID: 1 } as any),
      ).resolves.toBeUndefined();
      expect(sendMailMock).not.toHaveBeenCalled();
   });
});
