/* eslint-disable no-new */
const { Cron } = require('croner');
require('dotenv').config({ path: './.env.local' });

// THIN, FILE-FREE, ENV-CONFIGURED SCHEDULER.
//
// cron.js no longer reads data/settings.json or data/failed_queue.json (or any file). The SERVER owns
// all DB state: this process only fires timed POSTs to the API, which decide server-side (from the
// Postgres-backed settings row and the keyword rows) whether to actually scrape, notify, or retry.
// Schedules come from env vars so a self-hoster can tune cadence without a settings file:
//   - SCRAPE_INTERVAL       (default 'weekly')  -> POST /api/cron        (full rank scrape)
//   - NOTIFICATION_INTERVAL (default 'never')   -> POST /api/notify      (email digest)
//   - hourly (fixed)                            -> POST /api/cron?mode=retry (DB-backed failed retry)
//   - SEARCH_CONSOLE_* env present              -> daily POST /api/searchconsole

// Build the internal base URL for cron->server requests.
// NEXT_PUBLIC_APP_URL is the external/browser URL which may use a different port
// (e.g. Docker -p 5000:3000). Inside the container the server listens on PORT (default 3000).
const getInternalBaseURL = () => {
   const serverPort = process.env.PORT || 3000;
   return `http://localhost:${serverPort}`;
};

const INTERNAL_BASE_URL = getInternalBaseURL();

const generateCronTime = (interval) => {
   let cronTime = false;
   if (interval === 'hourly') {
      cronTime = '0 0 */1 * * *';
   }
   if (interval === 'daily') {
      cronTime = '0 0 0 * * *';
   }
   if (interval === 'other_day') {
      cronTime = '0 0 2-30/2 * *';
   }
   if (interval === 'daily_morning') {
      cronTime = '0 0 3 * * *';
   }
   if (interval === 'weekly') {
      cronTime = '0 0 * * 1';
   }
   if (interval === 'monthly') {
      cronTime = '0 0 1 * *'; // Run every first day of the month at 00:00(midnight)
   }

   return cronTime;
};

const runAppCronJobs = () => {
   // RUN SERP Scraping CRON. Default is WEEKLY (Monday 00:00, cron '0 0 * * 1'): rankings are checked
   // once a week, which is the s33k default and the basis of the pricing margin (50 keywords x ~4.3
   // weekly checks is about 217 SERP calls per site per month). Override with SCRAPE_INTERVAL
   // (hourly/daily/other_day/weekly/monthly, or 'never' to disable). The server decides from the DB
   // settings whether scraping is actually configured, so this only fires the trigger.
   const scrapeInterval = process.env.SCRAPE_INTERVAL || 'weekly';
   if (scrapeInterval !== 'never') {
      const scrapeCronTime = generateCronTime(scrapeInterval);
      if (scrapeCronTime) {
         new Cron(scrapeCronTime, () => {
            const fetchOpts = { method: 'POST', headers: { Authorization: `Bearer ${process.env.APIKEY}` } };
            fetch(`${INTERNAL_BASE_URL}/api/cron`, fetchOpts)
            .then((res) => res.json())
            .catch((err) => {
               console.log('ERROR Making SERP Scraper Cron Request..');
               console.log(err);
            });
         }, { scheduled: true });
      }
   }

   // RUN Email Notification CRON. Off by default ('never'); set NOTIFICATION_INTERVAL to enable.
   const notifInterval = process.env.NOTIFICATION_INTERVAL || 'never';
   if (notifInterval && notifInterval !== 'never') {
      const cronTime = generateCronTime(notifInterval === 'daily' ? 'daily_morning' : notifInterval);
      if (cronTime) {
         new Cron(cronTime, () => {
            const fetchOpts = { method: 'POST', headers: { Authorization: `Bearer ${process.env.APIKEY}` } };
            fetch(`${INTERNAL_BASE_URL}/api/notify`, fetchOpts)
            .then((res) => res.json())
            .then((data) => console.log(data))
            .catch((err) => {
               console.log('ERROR Making Cron Email Notification Request..');
               console.log(err);
            });
         }, { scheduled: true });
      }
   }

   // Run the DB-backed failed-scrape RETRY CRON (every hour). No file read: the server resolves the
   // keywords that currently have a real lastUpdateError and re-scrapes only those.
   const failedCronTime = generateCronTime('hourly');
   new Cron(failedCronTime, () => {
      const fetchOpts = { method: 'POST', headers: { Authorization: `Bearer ${process.env.APIKEY}` } };
      fetch(`${INTERNAL_BASE_URL}/api/cron?mode=retry`, fetchOpts)
      .then((res) => res.json())
      .then((data) => console.log(data))
      .catch((err) => {
         console.log('ERROR Making failed-retry Cron Request..');
         console.log(err);
      });
   }, { scheduled: true });

   // Run Google Search Console Scraper Daily (gated on the service-account env vars, unchanged).
   if (process.env.SEARCH_CONSOLE_PRIVATE_KEY && process.env.SEARCH_CONSOLE_CLIENT_EMAIL) {
      const searchConsoleCRONTime = generateCronTime('daily');
      new Cron(searchConsoleCRONTime, () => {
         const fetchOpts = { method: 'POST', headers: { Authorization: `Bearer ${process.env.APIKEY}` } };
         fetch(`${INTERNAL_BASE_URL}/api/searchconsole`, fetchOpts)
         .then((res) => res.json())
         .then((data) => console.log(data))
         .catch((err) => {
            console.log('ERROR Making Google Search Console Scraper Cron Request..');
            console.log(err);
         });
      }, { scheduled: true });
   }
};

runAppCronJobs();
