import type { GetServerSideProps, NextPage } from 'next';
import Head from 'next/head';
import React, { useState } from 'react';
import { getInstallGuides } from '../utils/install-guides';
import { isSetupCompleted, publicBaseUrlHeaderFree, verifySetupToken } from '../utils/setupState';

/*
 * GET /setup?token=...: the first-run installer page, and the ONLY browser moment the product has.
 *
 * s33k is fully MCP-driven; there is no dashboard to learn. This page exists for exactly one boot:
 * the server log prints a one-time token URL, the operator opens it, optionally pastes a Serper
 * key (a secret, which is why this is a browser form and not an LLM conversation: the key goes
 * browser-to-server and never through a chat), and gets back the MCP connect commands and the
 * beacon snippet. After completion the page 404s forever.
 *
 * AUTH: gated server-side in getServerSideProps by the in-memory boot token (constant-time
 * compare). Wrong/missing token, or an already-set-up instance (including every pre-existing
 * install via the settings backfill rule in utils/setupState.ts), returns Next's own 404 with no
 * hints. The instance APIKEY is embedded in the page ONLY behind that gate.
 */

type SetupPageProps = {
   token: string,
   baseUrl: string,
   /** The instance APIKEY (process.env.APIKEY), shown in the MCP connect commands. '' when unset. */
   apiKey: string,
   /** The beacon snippet with a placeholder domain (no domain exists yet at first run). */
   beaconSnippet: string,
};

export const getServerSideProps: GetServerSideProps<SetupPageProps> = async (context) => {
   // Completed instances (flag, backfill rule, or env-configured scraper) never see this page.
   if (await isSetupCompleted()) { return { notFound: true }; }
   const token = typeof context.query.token === 'string' ? context.query.token : '';
   if (!verifySetupToken(token)) { return { notFound: true }; }
   const baseUrl = publicBaseUrlHeaderFree();
   return {
      props: {
         token,
         baseUrl,
         apiKey: process.env.APIKEY || '',
         beaconSnippet: getInstallGuides('yourdomain.com', 'yourdomain.com').snippet,
      },
   };
};

// Deliberately plain: inline styles, no app chrome, no components. This page must render even if
// the rest of the UI is deleted in the headless phase.
const styles: Record<string, React.CSSProperties> = {
   page: {
      minHeight: '100vh',
      margin: 0,
      background: '#0b0f17',
      color: '#e6edf3',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      display: 'flex',
      justifyContent: 'center',
      padding: '48px 16px',
   },
   card: { maxWidth: 720, width: '100%' },
   h1: { fontSize: 24, margin: '0 0 8px' },
   p: { fontSize: 15, lineHeight: 1.6, color: '#9ca3af', margin: '0 0 16px' },
   label: { display: 'block', fontSize: 14, margin: '24px 0 6px', color: '#e6edf3' },
   input: {
      width: '100%',
      boxSizing: 'border-box',
      padding: '10px 12px',
      fontSize: 14,
      background: '#111827',
      color: '#e6edf3',
      border: '1px solid #1f2937',
      borderRadius: 8,
   },
   buttonRow: { display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap' },
   primary: {
      padding: '10px 18px',
      fontSize: 14,
      background: '#2563eb',
      color: '#fff',
      border: 'none',
      borderRadius: 8,
      cursor: 'pointer',
   },
   secondary: {
      padding: '10px 18px',
      fontSize: 14,
      background: 'transparent',
      color: '#9ca3af',
      border: '1px solid #1f2937',
      borderRadius: 8,
      cursor: 'pointer',
   },
   pre: {
      background: '#111827',
      border: '1px solid #1f2937',
      borderRadius: 8,
      padding: 16,
      fontSize: 13,
      overflowX: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
   },
   h2: { fontSize: 17, margin: '32px 0 8px' },
   error: { color: '#f87171', fontSize: 14, marginTop: 12 },
};

const SetupPage: NextPage<SetupPageProps> = ({ token, baseUrl, apiKey, beaconSnippet }) => {
   const [phase, setPhase] = useState<'form' | 'saving' | 'done'>('form');
   const [serperKey, setSerperKey] = useState('');
   const [savedWithKey, setSavedWithKey] = useState(false);
   const [error, setError] = useState('');

   const submit = async (withKey: boolean) => {
      setError('');
      setPhase('saving');
      try {
         const payload: Record<string, string> = { token };
         if (withKey && serperKey.trim()) { payload.serper_key = serperKey.trim(); }
         const res = await fetch('/api/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
         });
         if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            setError(data.error || 'Setup failed. Check the server log and retry.');
            setPhase('form');
            return;
         }
         setSavedWithKey(Boolean(withKey && serperKey.trim()));
         setPhase('done');
      } catch {
         setError('Setup failed. Check the server log and retry.');
         setPhase('form');
      }
   };

   const remoteCommand = `claude mcp add --transport http s33k ${baseUrl}/api/mcp \\\n`
      + `  --header "Authorization: Bearer ${apiKey || 'YOUR_APIKEY'}"`;
   const stdioCommand = 'claude mcp add s33k \\\n'
      + `  -e S33K_API_KEY="${apiKey || 'YOUR_APIKEY'}" \\\n`
      + `  -e S33K_BASE_URL=${baseUrl} \\\n`
      + '  -- node "$(pwd)/mcp/dist/index.js"';

   return (
      <div style={styles.page}>
         <Head><title>s33k setup</title><meta name='robots' content='noindex' /></Head>
         <div style={styles.card}>
            <h1 style={styles.h1}>Set up s33k</h1>
            {phase !== 'done' && (
               <>
                  <p style={styles.p}>
                     One optional step, then you are done with the browser forever. Everything else
                     (adding your site, keywords, reports) happens from your own AI over MCP.
                  </p>
                  <label style={styles.label} htmlFor='serper-key'>
                     Serper API key (optional, enables the SEO module: Google rank tracking)
                  </label>
                  <input
                     id='serper-key'
                     style={styles.input}
                     type='password'
                     autoComplete='off'
                     placeholder='Paste your serper.dev API key, or skip'
                     value={serperKey}
                     onChange={(e) => setSerperKey(e.target.value)}
                  />
                  <div style={styles.buttonRow}>
                     <button type='button' style={styles.primary} disabled={phase === 'saving'} onClick={() => submit(true)}>
                        {phase === 'saving' ? 'Saving...' : 'Save and finish'}
                     </button>
                     <button type='button' style={styles.secondary} disabled={phase === 'saving'} onClick={() => submit(false)}>
                        Skip for now: you can enable SEO later from your LLM
                     </button>
                  </div>
                  {error && <p style={styles.error}>{error}</p>}
               </>
            )}
            {phase === 'done' && (
               <>
                  <p style={styles.p}>
                     Setup is complete{savedWithKey ? ' and the SEO module is enabled' : ' (SEO module off, enable it any time'
                        + ' by asking your AI to enable SEO)'}. This page will not open again. Connect your AI, then close this tab.
                  </p>
                  <h2 style={styles.h2}>1. Connect your AI (Claude Code shown; any MCP client works)</h2>
                  <p style={styles.p}>Remote (HTTP + Bearer), when s33k runs on a server:</p>
                  <pre style={styles.pre}>{remoteCommand}</pre>
                  <p style={styles.p}>Local (stdio), when s33k runs on this machine (run from the s33k folder):</p>
                  <pre style={styles.pre}>{stdioCommand}</pre>
                  <h2 style={styles.h2}>2. Put the beacon on your site</h2>
                  <p style={styles.p}>
                     Paste this one line into your site&apos;s head, with data-domain set to your real
                     domain. Your AI can hand you platform-specific steps (install_instructions).
                  </p>
                  <pre style={styles.pre}>{beaconSnippet}</pre>
                  <h2 style={styles.h2}>3. Done</h2>
                  <p style={styles.p}>
                     Open your AI and say: &quot;Onboard yourdomain.com from scratch&quot; or just &quot;start_here&quot;.
                  </p>
               </>
            )}
         </div>
      </div>
   );
};

export default SetupPage;
