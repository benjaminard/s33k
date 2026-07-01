/**
 * Install-guide library for the s33k onboarding tracking snippet.
 *
 * To collect analytics and AEO/AI-referral signal, the self-hoster adds the s33k tracker
 * script to their own site. This module turns a domain into (1) the exact script snippet
 * and (2) accurate, copy-paste-ready, per-platform install instructions for the surfaces a
 * marketer is most likely to be on.
 *
 * It is pure product knowledge: no network calls, no LLM, no secrets. The snippet's
 * data-domain attribute IS the site domain, which is how public/s33k.js identifies the
 * site (it reads data-domain). Every s33k_event row is keyed by that domain.
 *
 * Script src: a relative "/s33k.js" path by default, since the s33k app serves the beacon
 * from its own origin. Two optional env vars override that (both documented in .env.example):
 *   S33K_SCRIPT_URL   Full URL to the s33k.js beacon (used verbatim if set).
 *   S33K_BEACON_HOST  Base URL that serves s33k.js; the src becomes `${S33K_BEACON_HOST}/s33k.js`
 *                     when S33K_SCRIPT_URL is not set. Useful when the beacon is served from a
 *                     different host than the app.
 */

export type InstallGuide = {
   platform: string,
   steps: string[],
};

export type InstallGuides = {
   snippet: string,
   scriptUrl: string,
   websiteId: string,
   platforms: InstallGuide[],
};

/**
 * Normalize a base URL: strip a trailing slash and a trailing /api segment.
 * @param {string} raw - The configured base URL.
 * @returns {string} The normalized base URL.
 */
const normalizeBaseUrl = (raw: string): string => {
   let base = String(raw || '').trim().replace(/\/+$/, '');
   base = base.replace(/\/api$/i, '');
   return base;
};

/**
 * Resolve the full URL of the s33k.js beacon script.
 * Prefers S33K_SCRIPT_URL; otherwise derives `${S33K_BEACON_HOST}/s33k.js` from the configured
 * beacon host. Falls back to a bare "/s33k.js" path when no host is configured so the snippet is
 * still shaped correctly (the self-host user can point it at their own app URL).
 * @returns {string} The script src to use in the snippet.
 */
const resolveScriptUrl = (): string => {
   const explicit = String(process.env.S33K_SCRIPT_URL || '').trim();
   if (explicit) { return explicit; }
   const rawBase = process.env.S33K_BEACON_HOST;
   if (!rawBase) { return '/s33k.js'; }
   return `${normalizeBaseUrl(rawBase)}/s33k.js`;
};

/**
 * Build the exact s33k tracking snippet for a domain.
 * This is the single line a self-hoster pastes into their site's <head>.
 * The data-domain attribute IS the site domain, which is what public/s33k.js reads to
 * identify the site (the beacon returns early if data-domain is missing).
 * @param {string} scriptUrl - Full URL of the s33k tracker script.
 * @param {string} domain - The site domain (used as the beacon's data-domain).
 * @returns {string} The <script> snippet.
 */
const buildSnippet = (scriptUrl: string, domain: string): string => `<script defer src="${scriptUrl}" data-domain="${domain}"></script>`;

/**
 * Build the snippet and the per-platform install instructions for a domain.
 *
 * Covers the platforms an SEO/marketing buyer is most likely to run: raw HTML, Google Tag
 * Manager, WordPress, Webflow, Shopify, Squarespace, Wix, and Next.js/React. Each guide is
 * a numbered list of exact, current steps ending at where the snippet goes.
 * @param {string} domain - The site domain, e.g. "example.com" (also the beacon's data-domain).
 * @param {string} siteId - The per-domain site id; for the first-party beacon this IS the domain.
 * @returns {InstallGuides} The snippet, resolved script URL, website id, and platform guides.
 */
export const getInstallGuides = (domain: string, siteId: string): InstallGuides => {
   // For the first-party beacon the site id IS the domain (see pages/api/install-instructions.ts).
   // public/s33k.js reads data-domain, so the snippet must emit data-domain, not data-website-id.
   const websiteId = String(siteId || '').trim();
   const scriptUrl = resolveScriptUrl();
   const snippet = buildSnippet(scriptUrl, websiteId);

   const platforms: InstallGuide[] = [
      {
         platform: 'Raw HTML',
         steps: [
            'Open the HTML template or layout file that renders the <head> of every page on your site.',
            'Paste the snippet immediately before the closing </head> tag.',
            'Save and deploy. Load any page once, then check s33k for analytics within a few minutes.',
         ],
      },
      {
         platform: 'Google Tag Manager',
         steps: [
            'In Google Tag Manager, open the container for your site and click Tags, then New.',
            'Click Tag Configuration and choose the "Custom HTML" tag type.',
            'Paste the snippet into the HTML field exactly as given.',
            'Under Triggering, choose "All Pages" (the built-in Page View trigger) so it fires site-wide.',
            'Name the tag (for example "s33k Analytics"), click Save, then click Submit and Publish to push it live.',
         ],
      },
      {
         platform: 'WordPress',
         steps: [
            'Easiest path: install a header-script plugin such as "WPCode" or "Insert Headers and Footers".',
            'Open the plugin\'s settings and find the "Header" or "Scripts in Header" box.',
            'Paste the snippet into that Header box and save. This injects it into <head> on every page.',
            'Alternative without a plugin: in Appearance, Theme File Editor, open header.php in a child theme and paste the snippet '
               + 'directly before </head> (use a child theme so a theme update does not overwrite it).',
         ],
      },
      {
         platform: 'Webflow',
         steps: [
            'In the Webflow Designer, open your project, then go to the project settings (the gear icon or Site Settings).',
            'Open the "Custom Code" tab.',
            'Paste the snippet into the "Head Code" box (the field labeled "Inside <head> tag").',
            'Click Save Changes, then Publish your site so the code goes live on the published domain.',
         ],
      },
      {
         platform: 'Shopify',
         steps: [
            'In Shopify admin, go to Online Store, then Themes.',
            'On your live theme click the three-dot menu (or "Actions"), then "Edit code".',
            'Under "Layout", open theme.liquid.',
            'Paste the snippet just before the closing </head> tag, then click Save. It now loads on every storefront page.',
         ],
      },
      {
         platform: 'Squarespace',
         steps: [
            'In the Squarespace dashboard, go to Settings, then Advanced, then "Code Injection".',
            'Paste the snippet into the "Header" box.',
            'Click Save. The script is injected into <head> across the whole site.',
            'Note: Code Injection requires a Business or Commerce plan.',
         ],
      },
      {
         platform: 'Wix',
         steps: [
            'In the Wix dashboard, go to Settings, then "Custom Code" (under the Advanced section).',
            'Click "Add Custom Code" in the Head section.',
            'Paste the snippet into the code box and give it a name (for example "s33k Analytics").',
            'Set it to load on "All pages" and place it in the "Head", then click Apply.',
         ],
      },
      {
         platform: 'Next.js / React',
         steps: [
            'App Router: in app/layout.tsx, import Script from "next/script" and render it inside the <head> (or at the top of <body>):',
            `  <Script defer src="${scriptUrl}" data-domain="${websiteId}" strategy="afterInteractive" />`,
            'Pages Router: in pages/_document.tsx, add the snippet inside the <Head> element of the Document, '
               + 'or render the next/script <Script> tag in _app.tsx.',
            'Plain React (Vite/CRA) with no SSR: paste the raw snippet into the <head> of public/index.html.',
            'Deploy. Because the tracker is a plain script, it works regardless of which rendering strategy the rest of the app uses.',
         ],
      },
   ];

   return { snippet, scriptUrl, websiteId, platforms };
};

export default getInstallGuides;
