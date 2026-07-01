/*
 * s33k.js - autocapture engagement analytics client.
 *
 * One script tag. Zero per-element setup. This is the GA4-killer: instead of wiring every
 * button and form into a tag manager, drop this in and it autocaptures rich engagement
 * automatically, then POSTs batches to the first-party /api/collect endpoint.
 *
 * Install:
 *   <script defer src="https://YOUR-S33K-HOST/s33k.js" data-domain="example.com"></script>
 *
 * What it captures (5 event types):
 *   1. click       - clicks on buttons and links: the element's visible text (truncated) and a
 *                    short, stable CSS selector path, plus the page path.
 *   2. form_submit - form submissions: the form id or name (or 'form' if neither), and the page.
 *   3. scroll      - the max % of the page scrolled in the session.
 *   4. engagement  - summed ACTIVE seconds on the page (paused on tab hide / blur / idle).
 *   5. outbound    - clicks on links to a different host: the destination HOST only.
 *
 * PRIVACY (non-negotiable): it captures the EVENT, never the PII.
 *   - It NEVER reads the value of an <input>, <textarea>, <select>, [contenteditable], or any
 *     password field. It never captures keystrokes or anything a person typed.
 *   - Click text is taken from buttons/links only, and is trimmed + truncated + control-char
 *     stripped. Inputs are explicitly excluded from text capture.
 *   - For forms it records THAT a submit happened (form id/name), never the field values.
 *   - For outbound it records the destination host, never the full URL/query.
 *   - No cookies. No fingerprinting. The session id lives in sessionStorage only and is a
 *     daily-rotating value: it cannot identify a person and cannot be joined across days.
 *   - Honors Do-Not-Track: if DNT is on, the script does nothing.
 *
 * Safety: every handler is wrapped in try/catch and all listeners are passive where possible.
 * If anything in here throws, it is swallowed. It must NEVER break the host page.
 */
(function s33k() {
   'use strict';
   try {
      if (typeof window === 'undefined' || typeof document === 'undefined') { return; }

      // --- Do-Not-Track: respect it and bail entirely. ---
      var dnt = window.doNotTrack || navigator.doNotTrack || navigator.msDoNotTrack;
      if (dnt === '1' || dnt === 'yes' || dnt === true) { return; }

      // --- Resolve config from the script tag. ---
      var current = document.currentScript;
      if (!current) {
         var scripts = document.getElementsByTagName('script');
         for (var i = scripts.length - 1; i >= 0; i--) {
            if (scripts[i].src && scripts[i].src.indexOf('s33k.js') !== -1) { current = scripts[i]; break; }
         }
      }
      var domain = current && current.getAttribute('data-domain');
      if (!domain) { return; }
      domain = String(domain).trim().toLowerCase();

      // Endpoint: same origin as the script by default; overridable via data-host.
      var host = (current && current.getAttribute('data-host')) || '';
      if (!host && current && current.src) {
         try { host = new URL(current.src).origin; } catch (e) { host = ''; }
      }
      var endpoint = (host ? host.replace(/\/+$/, '') : '') + '/api/collect';

      // --- Limits / tuning. ---
      var MAX_LABEL = 120;
      var MAX_SELECTOR = 160;
      var BATCH_MAX = 10;
      var FLUSH_MS = 30000;
      var IDLE_MS = 60000;
      var MAX_QUEUE = 100;

      // ===================== Cookieless, daily-rotating anonymous session ===================
      // A non-persistent, non-identifying token. It is a hash of UA + today's date + a random
      // per-tab seed, kept in sessionStorage so it survives in-tab navigations only. There is
      // NO cookie and NO cross-day or cross-tab linkage.
      function djb2(str) {
         var h = 5381;
         for (var i = 0; i < str.length; i++) { h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; }
         return h.toString(36);
      }
      function getSession() {
         try {
            var key = 's33k_sid';
            var existing = window.sessionStorage.getItem(key);
            if (existing) { return existing; }
            var today = new Date().toISOString().slice(0, 10);
            var seed = Math.random().toString(36).slice(2) + Date.now().toString(36);
            var sid = djb2((navigator.userAgent || '') + today + seed);
            window.sessionStorage.setItem(key, sid);
            return sid;
         } catch (e) {
            // sessionStorage blocked (private mode, etc.): fall back to an in-memory id.
            return 'mem-' + Math.random().toString(36).slice(2);
         }
      }
      var session = getSession();

      // ===================== First-touch SOURCE (PII-safe, computed once) ===================
      // Read document.referrer ONCE at session start and reduce it to a single first-touch
      // class: 'direct' | 'organic-search' | 'ai' | 'referral'. This is carried at the top
      // level of every batch so conversions can be attributed by source server-side.
      //
      // PRIVACY (non-negotiable): we send a CLASSIFICATION only, never a full referrer URL and
      // never any query string (a query can carry PII like ?email=...). We never send a path.
      // The most identifying thing this can ever produce is a bare host, and only as the value
      // the server can keep for a 'referral'; the classes themselves leak nothing.
      //
      // The host substrings below mirror the server's notions (utils/ai-sources.ts) but are
      // kept inline and small on purpose: the client cannot import server modules.
      var AI_HOSTS = [
         'chatgpt', 'chat.openai.com', 'openai.com', 'perplexity', 'gemini.google.com',
         'bard.google.com', 'claude.ai', 'anthropic', 'copilot.microsoft.com', 'you.com',
         'poe.com', 'phind', 'meta.ai', 'deepseek', 'x.ai',
      ];
      var SEARCH_HOSTS = [
         'google.', 'bing.', 'duckduckgo', 'yahoo.', 'yandex.', 'baidu.', 'ecosia.',
         'brave.com/search', 'search.brave', 'startpage', 'qwant', 'ask.com', 'aol.',
         'naver.', 'seznam.',
      ];
      function classifySource() {
         try {
            var ref = document.referrer || '';
            if (!ref) { return 'direct'; }
            var refHost = '';
            var refHostPath = '';
            try {
               var u = new URL(ref);
               // Same-origin referral is an in-site navigation, not an external source.
               if (u.host === window.location.host) { return 'direct'; }
               refHost = (u.host || '').toLowerCase();
               // Host + path only (NO query, NO hash) so a path-specific pattern can match
               // without ever carrying query-string PII.
               refHostPath = (refHost + (u.pathname || '')).toLowerCase();
            } catch (e) { return 'direct'; }
            if (!refHost) { return 'direct'; }
            function hit(list) {
               for (var i = 0; i < list.length; i++) {
                  if (refHostPath.indexOf(list[i]) !== -1) { return true; }
               }
               return false;
            }
            if (hit(AI_HOSTS)) { return 'ai'; }
            if (hit(SEARCH_HOSTS)) { return 'organic-search'; }
            // External, unknown source: send the bare HOST only (never the path or query).
            return refHost;
         } catch (e) { return 'direct'; }
      }
      var sessionSource = classifySource();

      // ===================== Campaign tags (UTM), computed once ============================
      // Parse the five standard UTM params from THIS page's querystring once at session start and
      // carry them at the top level of every batch so the server can attribute traffic and
      // conversions to a campaign without any GA4-style setup. Read once: the landing URL is the
      // campaign-bearing one, and a later in-site navigation without UTMs must not blank them out.
      //
      // PRIVACY: only these five fixed campaign keys are read. We never copy the whole querystring
      // (which can carry PII like ?email=...), only the named utm_* values, each trimmed/truncated
      // exactly like every other label. The server re-sanitizes and length-caps them again.
      var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
      function readUtm() {
         var out = {};
         try {
            var params = new URLSearchParams(window.location.search || '');
            for (var i = 0; i < UTM_KEYS.length; i++) {
               var key = UTM_KEYS[i];
               var val = params.get(key);
               if (val) {
                  var cleaned = clean(val, MAX_LABEL);
                  if (cleaned) { out[key] = cleaned; }
               }
            }
         } catch (e) { /* swallow: a missing URLSearchParams just means no campaign tags */ }
         return out;
      }
      var sessionUtm = readUtm();

      // ===================== Text + selector helpers (PII-safe) ============================
      function clean(text, max) {
         if (text == null) { return ''; }
         var s = String(text).replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s+/g, ' ').trim();
         return s.length > max ? s.slice(0, max) : s;
      }
      // Visible text of a button/link. Deliberately uses textContent of the element only, and
      // NEVER reads input/textarea/select values. Falls back to aria-label / title / alt.
      function elementText(el) {
         try {
            var tag = (el.tagName || '').toLowerCase();
            // Never derive text from form fields. They can hold typed PII.
            if (tag === 'input' || tag === 'textarea' || tag === 'select') {
               return clean(el.getAttribute('aria-label') || el.getAttribute('title') || '', MAX_LABEL);
            }
            var t = el.textContent || '';
            if (!t.trim()) {
               t = el.getAttribute('aria-label') || el.getAttribute('title') || '';
               // For an <img>-only link/button, alt text is a safe visible label.
               if (!t && el.querySelector) {
                  var img = el.querySelector('img[alt]');
                  if (img) { t = img.getAttribute('alt') || ''; }
               }
            }
            return clean(t, MAX_LABEL);
         } catch (e) { return ''; }
      }
      // A short, reasonably stable CSS selector path. Uses tag + id + first class, max 3 levels.
      // Never includes attribute values that could be PII.
      function cssPath(el) {
         try {
            var parts = [];
            var node = el;
            var depth = 0;
            while (node && node.nodeType === 1 && depth < 3) {
               var tag = (node.tagName || '').toLowerCase();
               var seg = tag;
               if (node.id) {
                  seg = tag + '#' + node.id;
                  parts.unshift(seg);
                  break; // an id is unique enough; stop climbing.
               }
               if (node.className && typeof node.className === 'string') {
                  var first = node.className.trim().split(/\s+/)[0];
                  if (first) { seg += '.' + first; }
               }
               parts.unshift(seg);
               node = node.parentElement;
               depth++;
            }
            return clean(parts.join(' > '), MAX_SELECTOR);
         } catch (e) { return ''; }
      }
      function pagePath() {
         try { return (window.location.pathname || '/') || '/'; } catch (e) { return '/'; }
      }
      // Find the nearest button or anchor ancestor of a click target (delegated capture).
      function nearestActionable(target) {
         var node = target;
         var hops = 0;
         while (node && node.nodeType === 1 && hops < 8) {
            var tag = (node.tagName || '').toLowerCase();
            var role = node.getAttribute ? (node.getAttribute('role') || '') : '';
            if (tag === 'a' || tag === 'button' || role === 'button'
               || (tag === 'input' && /^(submit|button)$/i.test(node.type || ''))) {
               return node;
            }
            node = node.parentElement;
            hops++;
         }
         return null;
      }

      // ===================== Event queue + transport =======================================
      var queue = [];
      function enqueue(ev) {
         if (queue.length >= MAX_QUEUE) { return; }
         ev.created = new Date().toISOString();
         queue.push(ev);
         if (queue.length >= BATCH_MAX) { flush(false); }
      }
      function payload(events) {
         // source is a top-level, session-level classification (or bare host). The server
         // re-sanitizes it and stamps it on every stored event.
         var body = { domain: domain, session: session, source: sessionSource, events: events };
         // Campaign tags are top-level and session-level too. Each utm_* key is included only when
         // the landing URL carried it, so an untagged visit sends nothing extra (keeps the payload
         // tiny and the server stores null for absent tags).
         for (var i = 0; i < UTM_KEYS.length; i++) {
            var key = UTM_KEYS[i];
            if (sessionUtm[key]) { body[key] = sessionUtm[key]; }
         }
         return JSON.stringify(body);
      }
      function flush(useBeacon) {
         try {
            if (!queue.length) { return; }
            var batch = queue.splice(0, queue.length);
            var body = payload(batch);
            if (useBeacon && navigator.sendBeacon) {
               var blob = new Blob([body], { type: 'application/json' });
               navigator.sendBeacon(endpoint, blob);
               return;
            }
            if (typeof fetch === 'function') {
               fetch(endpoint, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: body,
                  keepalive: true,
                  credentials: 'omit',
                  mode: 'cors',
               }).catch(function () { /* swallow: never surface a network error to the page */ });
            }
         } catch (e) { /* never throw out of flush */ }
      }

      // ===================== 0. Pageview (first-party traffic signal) =======================
      // One pageview per page load. This is the hit whose IP the server classifies as
      // datacenter-or-not, so human-only traffic, bounce, and exit rate are all computed from
      // pageview rows. A bounce (single-pageview session) is still captured because the queue is
      // flushed via sendBeacon on pagehide/visibilitychange even if the visitor leaves at once.
      // (SPA route changes are not tracked here; this is the full-page-load baseline.)
      enqueue({ type: 'pageview', page: pagePath() });

      // ===================== 1. Clicks (buttons/links) + 5. Outbound ========================
      document.addEventListener('click', function (e) {
         try {
            var el = nearestActionable(e.target);
            if (!el) { return; }
            var tag = (el.tagName || '').toLowerCase();

            // Outbound detection for anchors with an href on a different host.
            if (tag === 'a' && el.href) {
               var url;
               try { url = new URL(el.href, window.location.href); } catch (urlErr) { url = null; }
               if (url && /^https?:$/.test(url.protocol) && url.host && url.host !== window.location.host) {
                  enqueue({ type: 'outbound', page: pagePath(), label: clean(url.host, MAX_LABEL) });
                  // An outbound click is still a click; record both for in-page click stats.
               }
            }

            enqueue({
               type: 'click',
               page: pagePath(),
               label: elementText(el),
               selector: cssPath(el),
            });
         } catch (err) { /* swallow */ }
      }, true);

      // ===================== 2. Form submissions ===========================================
      // Records THAT a form was submitted and which form (id/name), NEVER the field values.
      document.addEventListener('submit', function (e) {
         try {
            var form = e.target;
            if (!form || (form.tagName || '').toLowerCase() !== 'form') { return; }
            var name = form.getAttribute('id') || form.getAttribute('name')
               || form.getAttribute('aria-label') || 'form';
            enqueue({ type: 'form_submit', page: pagePath(), label: clean(name, MAX_LABEL) });
         } catch (err) { /* swallow */ }
      }, true);

      // ===================== 3. Scroll depth ===============================================
      var maxScroll = 0;
      function computeScroll() {
         try {
            var doc = document.documentElement;
            var body = document.body || {};
            var scrollTop = window.pageYOffset || doc.scrollTop || body.scrollTop || 0;
            var viewport = window.innerHeight || doc.clientHeight || 0;
            var full = Math.max(
               doc.scrollHeight || 0, body.scrollHeight || 0,
               doc.offsetHeight || 0, body.offsetHeight || 0,
            );
            var scrollable = full - viewport;
            var pct = scrollable > 0 ? Math.round(((scrollTop + viewport) / full) * 100) : 100;
            if (pct > 100) { pct = 100; }
            if (pct < 0) { pct = 0; }
            if (pct > maxScroll) { maxScroll = pct; }
         } catch (e) { /* swallow */ }
      }
      var scrollTimer = null;
      window.addEventListener('scroll', function () {
         if (scrollTimer) { return; }
         scrollTimer = window.setTimeout(function () {
            scrollTimer = null;
            computeScroll();
         }, 250);
      }, { passive: true });

      // ===================== 4. Engagement (active dwell seconds) ===========================
      // Sum of seconds the page is actually engaged: visible, focused, and not idle.
      var activeMs = 0;
      var lastTick = Date.now();
      var engaged = true;
      var lastActivity = Date.now();

      function isVisible() {
         return document.visibilityState ? document.visibilityState === 'visible' : true;
      }
      function accumulate() {
         var now = Date.now();
         if (engaged && isVisible() && (now - lastActivity) < IDLE_MS) {
            activeMs += (now - lastTick);
         }
         lastTick = now;
      }
      // Tick every second so the active total stays current for the final flush.
      window.setInterval(function () { try { accumulate(); } catch (e) { /* swallow */ } }, 1000);

      function markActive() { lastActivity = Date.now(); }
      ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(function (evt) {
         window.addEventListener(evt, markActive, { passive: true });
      });
      window.addEventListener('focus', function () { engaged = true; lastTick = Date.now(); markActive(); });
      window.addEventListener('blur', function () { accumulate(); engaged = false; });
      document.addEventListener('visibilitychange', function () {
         accumulate();
         engaged = isVisible();
         lastTick = Date.now();
      });

      // ===================== Core Web Vitals (real-user field data) ========================
      // Capture the Core Web Vitals the way Google's field tooling does: from REAL users, with
      // native PerformanceObserver only (no web-vitals library, no extra bytes). Each metric is
      // accumulated as the page lives and emitted ONCE on the way out (visibility hidden), when its
      // value is final, as a type:'webvital' event carrying label:<METRIC> and metric_value:<number>.
      //
      // PRIVACY: these are numeric performance measurements, never PII. They carry no URL beyond the
      // page path already captured on every event.
      //
      // Feature-detected and fully guarded: on a browser without PerformanceObserver (or without a
      // given entry type) the block simply records nothing for that metric and never throws.
      var webVitals = { LCP: null, CLS: null, INP: null, FID: null, FCP: null, TTFB: null };
      function observe(type, buffered, cb) {
         try {
            if (typeof PerformanceObserver !== 'function') { return; }
            var po = new PerformanceObserver(function (list) {
               try {
                  var entries = list.getEntries();
                  for (var i = 0; i < entries.length; i++) { cb(entries[i]); }
               } catch (e) { /* swallow: one bad entry must never break the page */ }
            });
            po.observe({ type: type, buffered: buffered });
         } catch (e) { /* swallow: unsupported entry type on this browser */ }
      }
      // LCP: keep the LAST largest-contentful-paint entry's startTime (the metric is the final one).
      observe('largest-contentful-paint', true, function (entry) {
         webVitals.LCP = entry.startTime;
      });
      // CLS: sum layout-shift entries that did NOT follow recent user input (the spec's definition).
      observe('layout-shift', true, function (entry) {
         if (!entry.hadRecentInput) { webVitals.CLS = (webVitals.CLS || 0) + (entry.value || 0); }
      });
      // FCP: the first-contentful-paint paint entry's startTime.
      observe('paint', true, function (entry) {
         if (entry.name === 'first-contentful-paint') { webVitals.FCP = entry.startTime; }
      });
      // INP / interaction latency: track the worst event-timing duration as a representative INP.
      // 'event' timing is the natively-available signal for interaction responsiveness; we keep the
      // max duration seen. If the browser supports no 'event' timing at all, we fall back to FID
      // from the first 'first-input' entry below, so one of INP or FID is reported.
      observe('event', true, function (entry) {
         var d = entry.duration;
         if (typeof d === 'number' && (webVitals.INP === null || d > webVitals.INP)) { webVitals.INP = d; }
      });
      // FID: the first-input delay, used as the fallback when 'event' timing is unavailable.
      observe('first-input', true, function (entry) {
         if (typeof entry.processingStart === 'number' && typeof entry.startTime === 'number') {
            webVitals.FID = entry.processingStart - entry.startTime;
         }
      });
      // TTFB: responseStart off the navigation timing entry (time to first byte). Read once.
      try {
         if (window.performance && typeof window.performance.getEntriesByType === 'function') {
            var navEntries = window.performance.getEntriesByType('navigation');
            if (navEntries && navEntries.length && typeof navEntries[0].responseStart === 'number') {
               webVitals.TTFB = navEntries[0].responseStart;
            }
         }
      } catch (e) { /* swallow: navigation timing unavailable */ }

      // Emit each captured web-vital ONCE, on the final flush. INP and FID are mutually exclusive in
      // practice (INP supersedes FID); when INP was captured we skip FID to avoid double-counting.
      var webVitalsSent = false;
      function enqueueWebVitals() {
         try {
            if (webVitalsSent) { return; }
            webVitalsSent = true;
            var metrics = ['LCP', 'CLS', 'INP', 'FID', 'FCP', 'TTFB'];
            for (var i = 0; i < metrics.length; i++) {
               var name = metrics[i];
               if (name === 'FID' && webVitals.INP !== null) { continue; }
               var v = webVitals[name];
               if (typeof v === 'number' && isFinite(v) && v >= 0) {
                  enqueue({ type: 'webvital', page: pagePath(), label: name, metric_value: v });
               }
            }
         } catch (e) { /* swallow */ }
      }

      // ===================== Periodic + final flush ========================================
      function flushSessionMetrics(useBeacon) {
         try {
            accumulate();
            computeScroll();
            var seconds = Math.round(activeMs / 1000);
            if (seconds > 0) {
               enqueue({ type: 'engagement', page: pagePath(), value: seconds });
               activeMs = 0; // reset so we report incremental active time, not cumulative.
            }
            if (maxScroll > 0) {
               enqueue({ type: 'scroll', page: pagePath(), value: maxScroll });
            }
            // Final-only: web-vitals are emitted on the way out so their values are settled.
            if (useBeacon) { enqueueWebVitals(); }
            flush(useBeacon);
         } catch (e) { /* swallow */ }
      }

      window.setInterval(function () { flushSessionMetrics(false); }, FLUSH_MS);

      // On the way out, beacon whatever is left (engagement + scroll + queued clicks).
      window.addEventListener('pagehide', function () { flushSessionMetrics(true); });
      document.addEventListener('visibilitychange', function () {
         if (document.visibilityState === 'hidden') { flushSessionMetrics(true); }
      });
   } catch (outer) {
      // Absolute last resort: never let s33k.js throw into the host page.
   }
}());
