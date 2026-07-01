/**
 * Tests for the SECURITY / TRUST FACTS surface (pages/api/security.ts and the structured
 * source it returns, utils/securityFacts.ts).
 *
 * Contract under test:
 *   1. GET /api/security returns the full structured trust facts (the same single source
 *      a trial user's LLM reads via the security_facts MCP tool).
 *   2. It returns NO tenant data and NO secrets: the response is identical for every caller
 *      and contains only the static facts object.
 *   3. The facts object covers every promised trust pillar (no-training, single-user,
 *      encryption at rest, data ownership, open source, cookieless/no-PII), names the
 *      sub-processors, and points at the files/tests that prove each claim.
 *   4. Auth + method are gated (401 unauthorized, 405 non-GET).
 *
 * The DB layer is mocked to a no-op sync and authorize is mocked per-test. No network, no DB.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import securityHandler from '../../pages/api/security';
// eslint-disable-next-line import/first
import { securityFacts } from '../../utils/securityFacts';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockAuthorize = authorizeFn as unknown as jest.Mock;

const TENANT_A = { ID: 2, name: 'Tenant A', plan: 'free', status: 'active' };
const TENANT_B = { ID: 3, name: 'Tenant B', plan: 'free', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

const makeReq = (opts: { method?: string } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   body: {},
   query: {},
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

beforeEach(() => { jest.clearAllMocks(); });

describe('securityFacts structured source', () => {
   it('covers every promised trust pillar with a question, answer, and proof references', () => {
      const ids = securityFacts.facts.map((f) => f.id);
      expect(ids).toEqual(expect.arrayContaining([
         'no_training',
         'single_user',
         'encryption_at_rest',
         'data_ownership',
         'open_source',
         'cookieless_no_pii',
      ]));
      securityFacts.facts.forEach((f) => {
         expect(typeof f.question).toBe('string');
         expect(f.question.length).toBeGreaterThan(0);
         expect(typeof f.answer).toBe('string');
         expect(f.answer.length).toBeGreaterThan(0);
         expect(Array.isArray(f.verifyIn)).toBe(true);
         expect(f.verifyIn.length).toBeGreaterThan(0);
      });
   });

   it('states the no-training guarantee as structural, and points at the AI-route trust markers', () => {
      const noTraining = securityFacts.facts.find((f) => f.id === 'no_training');
      expect(noTraining).toBeDefined();
      expect(noTraining!.answer.toLowerCase()).toContain('no');
      expect(noTraining!.verifyIn.join(' ')).toContain('briefing.ts');
      expect(noTraining!.verifyIn.join(' ')).toContain('insights.ts');
      expect(noTraining!.verifyIn.join(' ')).toContain('ai-visibility.ts');
   });

   it('states the single-user fact and points at the auth + account-resolution seam', () => {
      const singleUser = securityFacts.facts.find((f) => f.id === 'single_user');
      expect(singleUser).toBeDefined();
      const proof = singleUser!.verifyIn.join(' ');
      expect(proof).toContain('utils/resolveAccount.ts');
      expect(proof).toContain('utils/authorize.ts');
   });

   it('points the data-ownership fact at the export route/tool and describes owner-controlled deletion', () => {
      const ownership = securityFacts.facts.find((f) => f.id === 'data_ownership');
      expect(ownership).toBeDefined();
      const proof = ownership!.verifyIn.join(' ');
      expect(proof).toContain('pages/api/export.ts');
      expect(ownership!.answer).toContain('export_data');
      // Single-user: deletion is direct (you own the DB), not a hard-delete route.
      expect(ownership!.answer.toLowerCase()).toContain('delet');
   });

   it('names the single-user sub-processors (Serper, Google optional)', () => {
      const names = securityFacts.subProcessors.map((p) => p.name);
      expect(names).toEqual(expect.arrayContaining(['Serper', 'Google (optional)']));
   });
});

describe('GET /api/security', () => {
   it('returns the full structured trust facts on a 200', async () => {
      asCaller(TENANT_A);
      const res = makeRes();
      await securityHandler(makeReq({ method: 'GET' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual(securityFacts);
      // It must include the principle, summary, facts, sub-processors, and trust doc pointer.
      const payload = res.payload as Record<string, unknown>;
      expect(payload.principle).toBeDefined();
      expect(payload.summary).toBeDefined();
      expect(Array.isArray(payload.facts)).toBe(true);
      expect(Array.isArray(payload.subProcessors)).toBe(true);
      expect(payload.trustDoc).toBeDefined();
   });

   it('returns the SAME facts for any caller and leaks no tenant data or secrets', async () => {
      asCaller(TENANT_A);
      const resA = makeRes();
      await securityHandler(makeReq({ method: 'GET' }), resA);

      asCaller(TENANT_B);
      const resB = makeRes();
      await securityHandler(makeReq({ method: 'GET' }), resB);

      // Identical for both tenants: the response is static, not tenant-derived.
      expect(resA.payload).toEqual(resB.payload);
      const serialized = JSON.stringify(resA.payload);
      // No tenant identity, no key material, no encrypted blobs in the response.
      expect(serialized).not.toContain('Tenant A');
      expect(serialized).not.toContain('Tenant B');
      expect(serialized).not.toContain('key_hash');
      expect(serialized).not.toContain('private_key');
   });
});

describe('GET /api/security auth + method gating', () => {
   it('401s an unauthorized caller', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: undefined, error: 'nope' });
      const res = makeRes();
      await securityHandler(makeReq({ method: 'GET' }), res);

      expect(res.statusCode).toBe(401);
   });

   it('405s a non-GET method', async () => {
      asCaller(TENANT_A);
      const res = makeRes();
      await securityHandler(makeReq({ method: 'POST' }), res);

      expect(res.statusCode).toBe(405);
   });
});
