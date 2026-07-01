import { NextRouter } from 'next/router';
import { useQuery } from 'react-query';

export async function fetchSCKeywords(router: NextRouter) {
   // if (!router.query.slug) { throw new Error('Invalid Domain Name'); }
   const res = await fetch(`${window.location.origin}/api/searchconsole?domain=${router.query.slug}`, { method: 'GET' });
   if (res.status >= 400 && res.status < 600) {
      if (res.status === 401) {
         router.push('/login');
      }
      throw new Error('Bad response from server');
   }
   return res.json();
}

export function useFetchSCKeywords(router: NextRouter, domainLoaded: boolean = false) {
   return useQuery('sckeywords', () => router.query.slug && fetchSCKeywords(router), { enabled: domainLoaded });
}

export async function fetchSCInsight(router: NextRouter) {
   const res = await fetch(`${window.location.origin}/api/insight?domain=${router.query.slug}`, { method: 'GET' });
   if (res.status >= 400 && res.status < 600) {
      if (res.status === 401) {
         router.push('/login');
      }
      throw new Error('Bad response from server');
   }
   return res.json();
}

export function useFetchSCInsight(router: NextRouter, domainLoaded: boolean = false) {
   return useQuery('scinsight', () => router.query.slug && fetchSCInsight(router), { enabled: domainLoaded });
}
