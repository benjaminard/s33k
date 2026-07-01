// Datacenter / hosting IP classification.
//
// THE bot signal. A page view that executes JavaScript still reveals nothing about whether it
// is a person, except where it comes FROM. Real people browse from residential and mobile ISPs;
// the automated traffic that floods a site (headless-Chrome scrapers, SEO crawlers, uptime
// monitors, AI fetchers, click farms) runs in cloud and hosting datacenters. Classifying the
// source IP as datacenter-vs-not is the one signal that catches the JS-executing bots a
// user-agent filter and a JS pageview tracker (Umami, GA) both miss. example.com's own traffic
// shows the pattern plainly: heavy Singapore, Beijing, and "The Dalles, Oregon" (a Google
// datacenter town) volume that no behavioral heuristic was catching.
//
// This module is dependency-free and offline: it matches an IPv4 address against a curated set of
// published CIDR blocks for the largest cloud and VPS providers (the hosts that dominate bot
// traffic). It is intentionally a high-confidence, not exhaustive, list: the goal is to flag the
// obvious datacenter ranges with near-zero false positives on real residential users, not to
// catch every niche host. Coverage is meant to be widened over time, and the accuracy upgrade is
// to swap in a MaxMind GeoLite2-ASN lookup (every hosting ASN, refreshed) behind this same
// isDatacenterIp() interface. IPv6 is treated as unknown (not datacenter) for now.

// Curated datacenter / hosting CIDR blocks, grouped by provider for maintainability. These are
// broad, well-established published ranges. Add to this list to widen coverage; keep each entry a
// block you are confident is hosting space, since a wrong block would flag real visitors as bots.
const DATACENTER_CIDRS: string[] = [
   // Google Cloud Platform (incl. the The Dalles, OR region in example.com's data).
   '34.64.0.0/10', '34.128.0.0/10', '35.184.0.0/13', '35.192.0.0/14', '35.196.0.0/15',
   '35.198.0.0/16', '35.199.0.0/16', '35.200.0.0/13', '104.154.0.0/15', '104.196.0.0/14',
   '130.211.0.0/16', '146.148.0.0/17', '108.59.80.0/20',
   // Amazon Web Services (major blocks).
   '3.0.0.0/9', '13.32.0.0/15', '13.224.0.0/14', '15.177.0.0/18', '15.220.0.0/14',
   '18.32.0.0/11', '34.192.0.0/10', '35.71.64.0/18', '44.192.0.0/11', '52.0.0.0/10',
   '54.64.0.0/11', '54.144.0.0/12', '54.224.0.0/11', '99.77.128.0/17', '100.20.0.0/14',
   // Microsoft Azure (major blocks).
   '13.64.0.0/11', '20.0.0.0/11', '20.32.0.0/11', '20.64.0.0/10', '20.128.0.0/16',
   '40.64.0.0/10', '52.224.0.0/11', '104.40.0.0/13', '137.116.0.0/15', '168.61.0.0/16',
   // DigitalOcean.
   '104.131.0.0/16', '134.209.0.0/16', '138.197.0.0/16', '142.93.0.0/16', '143.110.0.0/16',
   '146.190.0.0/16', '157.230.0.0/16', '159.65.0.0/16', '159.89.0.0/16', '161.35.0.0/16',
   '164.90.0.0/16', '165.227.0.0/16', '167.71.0.0/16', '167.99.0.0/16', '178.62.0.0/16',
   '188.166.0.0/16', '206.189.0.0/16', '209.97.0.0/16',
   // Hetzner.
   '5.9.0.0/16', '49.12.0.0/15', '65.108.0.0/15', '88.99.0.0/16', '95.216.0.0/15',
   '116.202.0.0/16', '135.181.0.0/16', '138.201.0.0/16', '144.76.0.0/16', '148.251.0.0/16',
   '159.69.0.0/16', '162.55.0.0/16', '168.119.0.0/16', '176.9.0.0/16', '178.63.0.0/16',
   '188.40.0.0/16', '195.201.0.0/16', '213.239.0.0/16',
   // OVH.
   '51.68.0.0/14', '51.75.0.0/16', '51.79.0.0/16', '51.81.0.0/16', '51.83.0.0/16',
   '51.89.0.0/16', '51.91.0.0/16', '54.36.0.0/14', '137.74.0.0/16', '139.99.0.0/16',
   '144.217.0.0/16', '145.239.0.0/16', '147.135.0.0/16', '158.69.0.0/16', '164.132.0.0/16',
   '167.114.0.0/16', '178.32.0.0/15', '188.165.0.0/16', '192.99.0.0/16', '217.182.0.0/16',
   // Akamai / Linode.
   '45.33.0.0/16', '45.56.0.0/16', '45.79.0.0/16', '50.116.0.0/16', '139.144.0.0/16',
   '172.104.0.0/15', '172.232.0.0/16', '178.79.128.0/18', '198.58.96.0/19', '23.92.16.0/20',
   '96.126.96.0/19', '173.255.192.0/18',
   // Contabo.
   '62.171.128.0/18', '75.119.128.0/18', '84.247.0.0/18', '89.117.0.0/18', '144.91.64.0/18',
   '158.220.80.0/20', '161.97.64.0/18', '167.86.64.0/18', '173.212.192.0/18', '173.249.0.0/16',
   '207.180.192.0/18', '213.136.64.0/18',
   // Alibaba Cloud (heavy in the Singapore / Beijing volume).
   '8.128.0.0/10', '8.208.0.0/12', '47.74.0.0/15', '47.235.0.0/16', '47.236.0.0/14',
   '47.240.0.0/13', '120.24.0.0/14', '120.76.0.0/14', '121.40.0.0/14',
   // Tencent Cloud.
   '43.128.0.0/12', '49.51.0.0/16', '101.32.0.0/14', '119.28.0.0/15', '124.156.0.0/16',
   '150.109.0.0/16', '162.14.0.0/16', '170.106.0.0/16',
];

// Parse a CIDR string into [networkInt, maskBits]. Computed once at module load.
const parsedCidrs: { network: number, bits: number }[] = DATACENTER_CIDRS.map((cidr) => {
   const [base, bitsStr] = cidr.split('/');
   return { network: ipv4ToInt(base), bits: parseInt(bitsStr, 10) };
}).filter((c) => Number.isFinite(c.network) && c.bits >= 0 && c.bits <= 32);

/**
 * Convert a dotted-quad IPv4 string to an unsigned 32-bit integer, or NaN if it is not a
 * well-formed IPv4 address.
 * @param {string} ip - Dotted-quad IPv4, e.g. "34.64.1.2".
 * @returns {number} Unsigned int, or NaN.
 */
function ipv4ToInt(ip: string): number {
   const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
   if (!m) { return NaN; }
   const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
   if (octets.some((o) => o > 255)) { return NaN; }
   // >>> 0 forces an unsigned 32-bit result.
   return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

/**
 * True when an IP belongs to a known datacenter / hosting provider, the core bot signal.
 *
 * Accepts an IPv4 literal or an IPv4-mapped IPv6 form (::ffff:a.b.c.d) and matches it against the
 * curated CIDR set. Returns false for anything it cannot positively place in a datacenter block
 * (unknown, malformed, private, or IPv6), so a real residential visitor is never flagged on a
 * miss. This is a deliberately conservative classifier: it only says "bot" when it is sure.
 *
 * @param {string | undefined | null} ip - The client IP.
 * @returns {boolean} True if the IP is in a known datacenter range.
 */
export const isDatacenterIp = (ip: string | undefined | null): boolean => {
   if (!ip) { return false; }
   let host = String(ip).trim().toLowerCase();
   // Unwrap an IPv4-mapped IPv6 address (::ffff:34.64.1.2) to its IPv4 form.
   const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
   if (mapped) { host = mapped[1]; }
   const value = ipv4ToInt(host);
   if (!Number.isFinite(value)) { return false; }
   for (const { network, bits } of parsedCidrs) {
      // A /0 would match everything; none exist in the list, but guard anyway.
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((value & mask) >>> 0 === (network & mask) >>> 0) { return true; }
   }
   return false;
};

export default isDatacenterIp;
