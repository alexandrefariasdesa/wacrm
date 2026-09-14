import { describe, it, expect } from 'vitest';

import {
  parseAttribution,
  inferPlatform,
  hasAttribution,
  mergeTagNames,
  buildClickRow,
  proposedToken,
  parseDealRequest,
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
  it('_fbp alone is not a campaign — the pixel sets it on every visitor', () => {
    expect(hasAttribution({ fbp: 'fb.1.1700000000000.123' })).toBe(false);
    expect(hasAttribution({ fbc: 'fb.1.1700000000000.IwAR' })).toBe(true);
    expect(hasAttribution({ adset_id: '120' })).toBe(true);
  });
});

describe('parseDealRequest', () => {
  it('creates by default, in the inbox pipeline', () => {
    expect(parseDealRequest({})).toEqual({ create: true, pipelineId: null, title: null });
  });
  it('honours create_deal=false and a valid pipeline id', () => {
    const id = '0b6f1f7e-3a3c-4d8e-9a57-6a8a2f0d1c11';
    expect(parseDealRequest({ create_deal: false, pipeline_id: id, deal_title: ' EsPCEx ' })).toEqual({
      create: false,
      pipelineId: id,
      title: 'EsPCEx',
    });
  });
  it('ignores a pipeline id that is not a uuid', () => {
    expect(parseDealRequest({ pipeline_id: "1' or 1=1" }).pipelineId).toBeNull();
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
  it('keeps adset, Meta cookies and placement', () => {
    const row = buildClickRow(
      'acc',
      { adset_id: '9', fbc: 'fb.1.1.x', fbp: 'fb.1.2.y', placement: 'instagram_reels' },
      'ABC123'
    );
    expect(row).toMatchObject({
      adset_external_id: '9',
      fbc: 'fb.1.1.x',
      fbp: 'fb.1.2.y',
      placement: 'instagram_reels',
      platform: 'meta',
    });
  });

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

describe('proposedToken', () => {
  it('accepts a Crockford token, uppercased', () => {
    expect(proposedToken('k7m2qx')).toBe('K7M2QX');
  });
  it('rejects ambiguous letters, wrong length and garbage', () => {
    expect(proposedToken('K7M2QI')).toBeNull(); // I não existe no alfabeto
    expect(proposedToken('K7M2Q')).toBeNull();
    expect(proposedToken(123)).toBeNull();
  });
});
