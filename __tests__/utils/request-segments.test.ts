import { deviceFromUA, countryFromHeaders } from '../../utils/request-segments';

describe('deviceFromUA', () => {
   it('buckets common user-agents', () => {
      expect(deviceFromUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Mobile')).toBe('mobile');
      expect(deviceFromUA('Mozilla/5.0 (Linux; Android 13; Pixel 7) Chrome Mobile')).toBe('mobile');
      expect(deviceFromUA('Mozilla/5.0 (iPad; CPU OS 17_0) AppleWebKit')).toBe('tablet');
      expect(deviceFromUA('Mozilla/5.0 (Linux; Android 13; SM-T970) Chrome Safari')).toBe('tablet'); // android no "mobile"
      expect(deviceFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome Safari')).toBe('desktop');
      expect(deviceFromUA('Mozilla/5.0 (Windows NT 10.0; Win64) Chrome')).toBe('desktop');
      expect(deviceFromUA(undefined)).toBe('');
   });
});

describe('countryFromHeaders', () => {
   it('reads a country from any known geo header, uppercased', () => {
      expect(countryFromHeaders({ 'cf-ipcountry': 'us' })).toBe('US');
      expect(countryFromHeaders({ 'x-vercel-ip-country': 'GB' })).toBe('GB');
      expect(countryFromHeaders({ 'fastly-geo-country': 'de' })).toBe('DE');
   });
   it('treats Cloudflare placeholders and missing geo as no data', () => {
      expect(countryFromHeaders({ 'cf-ipcountry': 'XX' })).toBe('');
      expect(countryFromHeaders({ 'cf-ipcountry': 'T1' })).toBe('');
      expect(countryFromHeaders({})).toBe('');
      expect(countryFromHeaders({ 'cf-ipcountry': 'USA' })).toBe(''); // not a 2-letter code
   });
});
