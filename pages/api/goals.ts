import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere, ownerIdFor } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Goal from '../../database/models/goal';
import type Account from '../../database/models/account';

// /api/goals  -  CRUD for NAMED conversion goals (see database/models/goal.ts).
//   GET    ?domain=            list a domain's goals
//   POST   { domain, name, kind, matchValue, matchPage?, matchMode?, value? }   create a goal
//   PUT    ?id=  { value }     update a goal's monetary value (set, or clear with null)
//   DELETE ?id=                delete a goal
// Every operation is ownership-gated (scopeWhere) so a tenant only ever touches its own goals.
// value is the optional money one completion is worth: it powers the revenue fields on the
// conversion reads (totalRevenue, revenue per channel / per keyword). Omit it and behavior is
// unchanged.

type GoalsResponse = {
   goals?: Record<string, unknown>[], goal?: Record<string, unknown>, removed?: number, updated?: number, error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<GoalsResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method === 'GET') { return listGoals(req, res, account); }
   if (req.method === 'POST') { return createGoal(req, res, account); }
   if (req.method === 'PUT') { return updateGoal(req, res, account); }
   if (req.method === 'DELETE') { return deleteGoal(req, res, account); }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

const listGoals = async (req: NextApiRequest, res: NextApiResponse<GoalsResponse>, account?: Account | null) => {
   const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
   try {
      const where = domain ? { domain, ...scopeWhere(account) } : { ...scopeWhere(account) };
      const goals = await Goal.findAll({ where });
      return res.status(200).json({ goals: goals.map((g) => g.get({ plain: true }) as Record<string, unknown>) });
   } catch (error) {
      console.log('[ERROR] Listing goals: ', error);
      return res.status(400).json({ error: 'Error Listing Goals.' });
   }
};

// Parse an optional monetary goal value. Returns { ok, value } where value is a finite number >= 0
// or null when omitted. A present-but-invalid value (non-numeric, negative, NaN, Infinity) is a
// hard error so a bad value never silently becomes null and skews revenue math.
const parseGoalValue = (raw: unknown): { ok: boolean, value: number | null } => {
   if (raw === undefined || raw === null || raw === '') { return { ok: true, value: null }; }
   let n = NaN;
   if (typeof raw === 'number') { n = raw; } else if (typeof raw === 'string') { n = Number(raw.trim()); }
   if (!Number.isFinite(n) || n < 0) { return { ok: false, value: null }; }
   return { ok: true, value: n };
};

const createGoal = async (req: NextApiRequest, res: NextApiResponse<GoalsResponse>, account?: Account | null) => {
   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
   const name = typeof body.name === 'string' ? body.name.trim() : '';
   const kind = body.kind === 'event' ? 'event' : 'page_reached';
   const matchValue = typeof body.matchValue === 'string' ? body.matchValue.trim() : '';
   const matchPage = typeof body.matchPage === 'string' && body.matchPage.trim() ? body.matchPage.trim() : null;
   const matchMode = body.matchMode === 'exact' ? 'exact' : 'prefix';
   const parsedValue = parseGoalValue(body.value);

   if (!domain || !name || !matchValue) {
      return res.status(400).json({ error: 'domain, name, and matchValue are required.' });
   }
   if (!parsedValue.ok) {
      return res.status(400).json({ error: 'value must be a finite number >= 0 if provided.' });
   }
   try {
      // Ownership gate: the caller must own the domain before defining a goal on it.
      const owned = await resolveDomainAccess(account, domain, { write: true });
      if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

      // Reject a duplicate goal name for this (domain, owner). Otherwise the by-name resolvers
      // (goal-analytics, conversion-attribution) would findOne an arbitrary one of the duplicates
      // and silently report the wrong goal's data.
      const existing = await Goal.findOne({ where: { name, domain, ...scopeWhere(account) } });
      if (existing) {
         return res.status(409).json({ error: `A goal named "${name}" already exists for this domain.` });
      }

      const goal = await Goal.create({
         domain,
         owner_id: ownerIdFor(account),
         name,
         kind,
         match_value: matchValue,
         match_page: kind === 'event' ? matchPage : null,
         match_mode: matchMode,
         value: parsedValue.value,
         created: new Date().toJSON(),
      });
      return res.status(201).json({ goal: goal.get({ plain: true }) as Record<string, unknown> });
   } catch (error) {
      console.log('[ERROR] Creating goal: ', error);
      return res.status(400).json({ error: 'Error Creating Goal.' });
   }
};

// Update a goal's monetary value (the only mutable field today). Ownership-gated via scopeWhere, so
// a tenant can only update its own goals. Pass value=null (or omit) to clear it.
const updateGoal = async (req: NextApiRequest, res: NextApiResponse<GoalsResponse>, account?: Account | null) => {
   const id = typeof req.query.id === 'string' ? parseInt(req.query.id, 10) : NaN;
   if (!Number.isFinite(id)) { return res.status(400).json({ error: 'Goal id is required.' }); }
   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const parsedValue = parseGoalValue(body.value);
   if (!parsedValue.ok) {
      return res.status(400).json({ error: 'value must be a finite number >= 0 if provided.' });
   }
   try {
      const [updated] = await Goal.update({ value: parsedValue.value }, { where: { ID: id, ...scopeWhere(account) } });
      return res.status(200).json({ updated });
   } catch (error) {
      console.log('[ERROR] Updating goal: ', error);
      return res.status(400).json({ error: 'Error Updating Goal.' });
   }
};

const deleteGoal = async (req: NextApiRequest, res: NextApiResponse<GoalsResponse>, account?: Account | null) => {
   const id = typeof req.query.id === 'string' ? parseInt(req.query.id, 10) : NaN;
   if (!Number.isFinite(id)) { return res.status(400).json({ error: 'Goal id is required.' }); }
   try {
      const removed = await Goal.destroy({ where: { ID: id, ...scopeWhere(account) } });
      return res.status(200).json({ removed });
   } catch (error) {
      console.log('[ERROR] Deleting goal: ', error);
      return res.status(400).json({ error: 'Error Deleting Goal.' });
   }
};
