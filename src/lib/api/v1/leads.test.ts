import { describe, it, expect } from 'vitest';

import {
  parseAttribution,
  inferPlatform,
  hasAttribution,
  mergeTagNames,
  buildClickRow,
} from './leads';

describe('parseAttribution', () => {
  it('keeps known keys, drops unknown and empty ones', () => {
    expect(
      parseAttribution({
        utm_source: ' facebook ',
        fbclid: 'IwAR123',
        evil: 'x',
        utm_term: '',
      })
    ).toEqual({ utm_source: 'facebook', fbclid: 'IwAR123' });
  });

  it('tolerates garbage', () => {
    expect(parseAttribution(null)).toEqual({});
    expect(parseAttribution('x')).toEqual({});
  });

  it('does not cut a long fbclid at 120 chars', () => {
    const fbclid = 'a'.repeat(300);
    expect(parseAttribution({ fbclid }).fbclid).toHaveLength(300);
  });
});

describe('inferPlatform', () => {
  it('click ids beat utm_source', () => {
    expect(inferPlatform({ fbclid: 'x', utm_source: 'google' })).toBe('meta');
    expect(inferPlatform({ gbraid: 'x', utm_source: 'facebook' })).toBe('google');
  });
  it('falls back to utm_source, then other', () => {
    expect(inferPlatform({ utm_source: 'Instagram' })).toBe('meta');
    expect(inferPlatform({ utm_source: 'youtube' })).toBe('google');
    expect(inferPlatform({ utm_source: 'newsletter' })).toBe('other');
    expect(inferPlatform({})).toBe('other');
  });
});

describe('hasAttribution', () => {
  it('landing and referrer alone are not a campaign', () => {
    expect(hasAttribution({ landing_url: '/x', referrer: 'https://g.co' })).toBe(false);
    expect(hasAttribution({ utm_campaign: 'espcex' })).toBe(true);
  });
});

describe('mergeTagNames', () => {
  it('keeps existing tags and adds new ones without duplicates', () => {
    expect(mergeTagNames(['portal', 'curso:espcex'], ['Portal', 'curso:cfo'])).toEqual([
      'portal',
      'curso:espcex',
      'curso:cfo',
    ]);
  });
});

describe('buildClickRow', () => {
  it('maps attribution and is born matched', () => {
    const row = buildClickRow('acc', { fbclid: 'f', ad_id: '123', landing_url: '/o' }, 'ABC123');
    expect(row).toMatchObject({
      account_id: 'acc',
      tracking_link_id: null,
      click_token: 'ABC123',
      platform: 'meta',
      fbclid: 'f',
      ad_external_id: '123',
      landing_url: '/o',
    });
    expect(row.matched_at).toBeTruthy();
  });
});
