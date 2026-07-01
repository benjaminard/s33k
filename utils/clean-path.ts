// Path normalization, the canonical home for cleanPath.
//
// A url/path is normalized to a clean comparable path so a SERP url, a client pageview path, and a
// tracked keyword's target page all compare apples-to-apples. It lives here, in the first-party
// analytics stack, with no dependency on any external analytics provider.

/**
 * Normalize a url/path to a clean comparable path.
 * Lowercases, strips the origin and any query string or fragment, and removes a trailing slash.
 * The root path "/" is preserved as "/".
 * @param {string} input - A url or path, e.g. "/Compare/Masset-vs-Seismic/?ref=x".
 * @returns {string} The cleaned path, e.g. "/compare/masset-vs-seismic".
 */
export const cleanPath = (input: string): string => {
   if (!input) { return ''; }
   let path = String(input).trim();
   // Drop the origin if a full URL was passed; keep only the path.
   try {
      if (/^https?:\/\//i.test(path)) {
         path = new URL(path).pathname;
      }
   } catch {
      // Not a parseable URL, fall through and treat as a path.
   }
   path = path.toLowerCase();
   // Remove any query string or fragment.
   [path] = path.split('?');
   [path] = path.split('#');
   // Remove a trailing slash, but keep the root "/".
   if (path.length > 1 && path.endsWith('/')) {
      path = path.replace(/\/+$/, '');
   }
   if (path === '') { path = '/'; }
   return path;
};

export default cleanPath;
