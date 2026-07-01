// Coarse, non-identifying request segments derived at ingest: device class and country.
//
// These are SEGMENTS, not a fingerprint. device is one of four buckets from the User-Agent;
// country is an ISO code from a geo header the host already attaches. Neither stores the raw IP or
// UA, and neither can identify a person. They power the device and geography analytics filters.

type Headers = Record<string, string | string[] | undefined>;

const firstHeader = (headers: Headers, name: string): string => {
   const v = headers[name];
   if (Array.isArray(v)) { return v[0] || ''; }
   return typeof v === 'string' ? v : '';
};

/**
 * Bucket a User-Agent into 'mobile' | 'tablet' | 'desktop'. Returns '' when there is no UA.
 * Tablet is checked before mobile (an iPad UA contains neither "mobile" reliably nor a phone
 * token, and an Android tablet lacks "Mobile"), so the order matters.
 * @param {string | undefined} ua - The request User-Agent.
 * @returns {string} 'mobile' | 'tablet' | 'desktop' | ''.
 */
export const deviceFromUA = (ua: string | undefined): string => {
   const s = String(ua || '').toLowerCase();
   if (!s) { return ''; }
   if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(s)) { return 'tablet'; }
   if (/mobi|iphone|ipod|android.*mobile|windows phone|blackberry|bb10|opera mini/.test(s)) { return 'mobile'; }
   return 'desktop';
};

/**
 * Read an ISO country code from whichever geo header the host attaches. Returns '' when none is
 * present (e.g. a Railway-direct deploy with no CDN geo). Country-level only; never finer geo.
 * @param {Headers} headers - The request headers.
 * @returns {string} Uppercased 2-letter country code, or ''.
 */
export const countryFromHeaders = (headers: Headers): string => {
   const candidates = ['cf-ipcountry', 'x-vercel-ip-country', 'x-geo-country', 'x-country-code', 'fastly-geo-country'];
   for (const h of candidates) {
      const v = firstHeader(headers, h).trim().toUpperCase();
      // 'XX' and 'T1' are Cloudflare placeholders for unknown / Tor; treat as no data.
      if (v && v.length === 2 && v !== 'XX' && v !== 'T1') { return v; }
   }
   return '';
};
