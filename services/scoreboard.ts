import { NextRouter } from 'next/router';
import { useQuery } from 'react-query';

export async function fetchScoreboard(router: NextRouter, domain: string) {
   const res = await fetch(`${window.location.origin}/api/scoreboard?domain=${encodeURIComponent(domain)}&period=30d`, { method: 'GET' });
   if (res.status >= 400 && res.status < 600) {
      if (res.status === 401) {
         router.push('/login');
      }
      throw new Error('Bad response from server');
   }
   return res.json();
}

export function useFetchScoreboard(router: NextRouter, domain: string, enabled: boolean = false) {
   return useQuery(['scoreboard', domain], () => fetchScoreboard(router, domain), { enabled: enabled && !!domain });
}
