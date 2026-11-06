import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeTileEnvelope,
  encodeTileEnvelope,
  incrementRedirectCounterOnUrl,
  parseTilePayload,
} from '../src/nzbdav/redirectHelpers.js';

test('parses a valid playback ID and library path from the tile envelope', () => {
  const sid = 'fef6e80d-c32b-4bc8-a535-1f24cdffed8a';
  const t = encodeTileEnvelope({ sid, lp: '/content/movies/example.mkv' });
  assert.deepEqual(parseTilePayload(t), {
    sid,
    lp: '/content/movies/example.mkv',
    sk: undefined,
    fbg: undefined,
    rc: undefined,
    ci: undefined,
    idx: undefined,
    url: undefined,
    title: undefined,
    indexer: undefined,
    season: undefined,
    episode: undefined,
    seasonpack: undefined,
    epcount: undefined,
    aired: undefined,
    ty: undefined,
    ip: undefined,
  });
});

test('rejects an invalid playback ID', () => {
  const t = encodeTileEnvelope({ sid: 'attacker-controlled', url: 'https://example.invalid/file.nzb' });
  assert.equal(parseTilePayload(t).sid, undefined);
});

test('preserves playback ID through fallback redirects', () => {
  const sid = 'fef6e80d-c32b-4bc8-a535-1f24cdffed8a';
  const url = new URL(`https://stream.example/stream/movie?t=${encodeTileEnvelope({ sid, rc: 4, ci: 2 })}`);
  incrementRedirectCounterOnUrl(url, true);
  const decoded = decodeTileEnvelope(url.searchParams.get('t') ?? '');
  assert.equal(decoded?.sid, sid);
  assert.equal(decoded?.rc, 5);
  assert.equal(decoded?.ci, 3);
  assert.deepEqual([...url.searchParams.keys()], ['t']);
});
