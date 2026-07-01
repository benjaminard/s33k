import { allowedApiRoutes } from '../../utils/allowedApiRoutes';

// Audit A12 guard. The Google Ads OAuth route (/api/adwords) is a LEGACY GLOBAL ADMIN integration:
// its consent URL is built client-side and it stores only global admin credentials. It is a
// cookie-authed (verifyUser) maintenance surface, not an API-key route. This test locks in the
// security property that it must never become reachable with a Bearer API key. If a future change
// makes Google Ads API-accessible, it must move to authorize() first, then update this test.
const ADWORDS_ROUTE = '/api/adwords';
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

describe('Google Ads OAuth route stays admin-only (audit A12)', () => {
   it('is not reachable with a Bearer API key through allowedApiRoutes (any method)', () => {
      for (const method of METHODS) {
         expect(allowedApiRoutes).not.toContain(`${method}:${ADWORDS_ROUTE}`);
      }
   });
});
