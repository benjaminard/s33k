import { isDatacenterIp } from '../../utils/datacenter-ip';

describe('isDatacenterIp', () => {
   it('flags IPs inside known datacenter CIDR blocks', () => {
      expect(isDatacenterIp('34.64.1.2')).toBe(true); // Google Cloud (34.64.0.0/10)
      expect(isDatacenterIp('52.0.0.1')).toBe(true); // AWS (52.0.0.0/10)
      expect(isDatacenterIp('20.0.0.1')).toBe(true); // Azure (20.0.0.0/11)
      expect(isDatacenterIp('159.65.10.20')).toBe(true); // DigitalOcean (159.65.0.0/16)
      expect(isDatacenterIp('5.9.4.4')).toBe(true); // Hetzner (5.9.0.0/16)
      expect(isDatacenterIp('51.75.1.1')).toBe(true); // OVH (51.75.0.0/16)
   });

   it('unwraps an IPv4-mapped IPv6 address before matching', () => {
      expect(isDatacenterIp('::ffff:34.64.1.2')).toBe(true);
      expect(isDatacenterIp('::ffff:1.2.3.4')).toBe(false);
   });

   it('does NOT flag residential / non-hosting or private IPs (no false positives)', () => {
      expect(isDatacenterIp('8.8.8.8')).toBe(false); // not in the hosting list
      expect(isDatacenterIp('1.2.3.4')).toBe(false);
      expect(isDatacenterIp('192.168.1.1')).toBe(false); // private
      expect(isDatacenterIp('10.0.0.5')).toBe(false); // private
      expect(isDatacenterIp('203.0.113.7')).toBe(false); // TEST-NET, not hosting
   });

   it('returns false for missing or malformed input rather than throwing', () => {
      expect(isDatacenterIp('')).toBe(false);
      expect(isDatacenterIp(undefined)).toBe(false);
      expect(isDatacenterIp(null)).toBe(false);
      expect(isDatacenterIp('not-an-ip')).toBe(false);
      expect(isDatacenterIp('999.999.999.999')).toBe(false);
      expect(isDatacenterIp('2001:db8::1')).toBe(false); // IPv6 treated as unknown
   });
});
