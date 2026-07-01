import { NextRouter } from 'next/router';
import { useQuery } from 'react-query';

export async function fetchAiReferrals(router: NextRouter, domain: string) {
   const res = await fetch(
      `${window.location.origin}/api/ai-referrals?domain=${encodeURIComponent(domain)}&period=90d`,
      { method: 'GET' },
   );
   if (res.status >= 400 && res.status < 600) {
      if (res.status === 401) {
         router.push('/login');
      }
      throw new Error('Bad response from server');
   }
   return res.json();
}

export function useFetchAiReferrals(router: NextRouter, domain: string, enabled: boolean = false) {
   return useQuery(['aiReferrals', domain], () => fetchAiReferrals(router, domain), { enabled: enabled && !!domain });
}
