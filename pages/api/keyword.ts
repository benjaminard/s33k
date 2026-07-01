import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Keyword from '../../database/models/keyword';
import parseKeywords from '../../utils/parseKeywords';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';

type KeywordGetResponse = {
   keyword?: KeywordType | null
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   const { authorized, account, error } = await authorize(req, res);
   if (authorized && req.method === 'GET') {
      await ensureSynced();
      return getKeyword(req, res, account);
   }
   return res.status(401).json({ error: error || 'Not authorized' });
}

const getKeyword = async (req: NextApiRequest, res: NextApiResponse<KeywordGetResponse>, account?: Account | null) => {
   if (!req.query.id && typeof req.query.id !== 'string') {
       return res.status(400).json({ error: 'Keyword ID is Required!' });
   }

   try {
      const query = { ID: parseInt((req.query.id as string), 10), ...scopeWhere(account) };
      const foundKeyword:Keyword| null = await Keyword.findOne({ where: query });
      const parsedKeyword = foundKeyword && parseKeywords([foundKeyword.get({ plain: true })]);
      const keywords = parsedKeyword && parsedKeyword[0] ? parsedKeyword[0] : null;
      return res.status(200).json({ keyword: keywords });
   } catch (error) {
      console.log('[ERROR] Getting Keyword: ', error);
      return res.status(400).json({ error: 'Error Loading Keyword' });
   }
};
