import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import express from 'express';
// The legacy route imports start a user-agent metadata poller. Keep import-time
// work offline and its background timers unreferenced in this HTTP-only suite.
const originalFetch = globalThis.fetch;
const originalInterval = globalThis.setInterval;
globalThis.fetch = async () => new Response(null, { status: 503 });
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  const timer = originalInterval(...args);
  timer.unref();
  return timer;
}) as typeof setInterval;
const { createNzbdavStreamRoutes } = await import('../src/routes/nzbdav.js');
await wait(0);
globalThis.fetch = originalFetch;
globalThis.setInterval = originalInterval;
import type { Config } from '../src/types.js';

// Exercise the real HTTP routes with synthetic bytes and a fully consumed GET.
// No provider, indexer, external network, or application credentials are used.
const payload = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => i % 251));
async function eventually(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(5);
  }
  assert.fail(message);
}
async function listen(server: http.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
type Kind = 'stream' | 'range' | 'pending' | 'redirect' | 'no-range' | 'reconnect' | 'retry-pending' | 'connect-fail';
async function fixture(t: TestContext, kind: Kind, mode: 'proxy' | 'pipe' = 'proxy') {
  const previousLog = console.log;
  const previousTelemetry = process.env.STREAM_TELEMETRY_ENABLED;
  const events: any[] = [];
  process.env.STREAM_TELEMETRY_ENABLED = 'true';
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('UU_STREAM_EVENT ')) {
      events.push(JSON.parse(args[0].slice('UU_STREAM_EVENT '.length)));
    }
  };
  t.after(() => {
    console.log = previousLog;
    if (previousTelemetry === undefined) delete process.env.STREAM_TELEMETRY_ENABLED;
    else process.env.STREAM_TELEMETRY_ENABLED = previousTelemetry;
  });
  const state = { active: 0, requests: [] as { path: string; range: string | undefined }[], upstreamBytes: 0, consumedRequests: 0 };
  const timers = new Set<ReturnType<typeof setInterval>>();
  const upstream = http.createServer((req, res) => {
    const nth = state.requests.push({ path: req.url!, range: req.headers.range });
    state.active++;
    let timer: ReturnType<typeof setInterval> | undefined;
    res.on('error', () => {});
    res.once('close', () => {
      state.active--;
      if (timer) { clearInterval(timer); timers.delete(timer); }
    });
    if (kind === 'pending' || (kind === 'redirect' && req.url === '/held') ||
        (kind === 'no-range' && nth > 1) || (kind === 'retry-pending' && nth > 1)) return;
    if (kind === 'redirect') { res.writeHead(302, { Location: '/held' }); res.end(); return; }
    if (kind === 'no-range') { res.writeHead(416); res.end(); return; }
    if (kind === 'connect-fail') { req.socket.destroy(); return; }
    const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = Number(match?.[1] || 0);
    const end = match?.[2] ? Number(match[2]) : payload.length - 1;
    if (kind === 'range') {
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${payload.length}`, 'Content-Length': end - start + 1 });
      res.end(payload.subarray(start, end + 1));
      return;
    }
    if (kind === 'reconnect' || kind === 'retry-pending') {
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`, 'Content-Length': payload.length - start });
      if (nth === 1) {
        res.write(payload.subarray(start, start + 32 * 1024));
        timer = setTimeout(() => res.destroy(), 30);
        timers.add(timer);
      } else res.end(payload.subarray(start));
      return;
    }
    res.writeHead(match ? 206 : 200, { 'Content-Type': 'video/mp4' });
    timer = setInterval(() => {
      if (res.destroyed) return;
      const chunk = payload.subarray(0, 32 * 1024);
      state.upstreamBytes += chunk.length;
      res.write(chunk);
    }, 2);
    timers.add(timer);
  });
  const port = await listen(upstream);
  const app = express();
  app.use((req, _res, next) => {
    req.resume();
    req.once('end', () => setImmediate(() => {
      if (req.complete && req.destroyed) state.consumedRequests++;
      next();
    }));
  });
  app.use(createNzbdavStreamRoutes({
    config: { nzbdavUrl: `http://127.0.0.1:${port}`, nzbdavStreamingMethod: mode, nzbdavStreamBufferMB: 1, nzbdavPipeBufferMB: 1 } as Config,
    handleStream: async () => {}, getCacheStats: () => ({}), clearStreamCache: () => {},
    clearReadyCache: () => 0, clearFailedCache: () => 0, deleteCacheEntry: () => false,
    getCacheEntries: () => [], isStreamCached: () => false, getLatestVersions: () => ({ chrome: 'synthetic-test' }),
  }));
  const gateway = http.createServer(app);
  const gatewayPort = await listen(gateway);
  const clients: http.ClientRequest[] = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    for (const timer of timers) clearInterval(timer);
    gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(r => gateway.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]);
  });
  function open(range: string | null = 'bytes=0-', pause = false) {
    const playbackId = randomUUID();
    const result = { playbackId, bytes: 0, chunks: [] as Buffer[], ended: false, status: 0, response: undefined as http.IncomingMessage | undefined };
    const path = kind === 'redirect' ? '/start' : '/synthetic';
    const request = http.get({ host: '127.0.0.1', port: gatewayPort, path: `/v?path=${path}&_sid=${playbackId}`, headers: range ? { Range: range } : {} }, response => {
      result.response = response; result.status = response.statusCode!;
      response.on('error', () => {});
      response.on('data', chunk => { result.bytes += chunk.length; result.chunks.push(chunk); });
      response.once('end', () => { result.ended = true; });
      if (pause) response.pause();
    });
    request.on('error', () => {}); clients.push(request);
    return { result, destroy: () => { request.destroy(); result.response?.destroy(); } };
  }
  const ends = (client: ReturnType<typeof open>) => events.filter(e => e.playback_id === client.result.playbackId && e.event === 'request_end');
  async function assertCancelled(client: ReturnType<typeof open>, reason = 'client_disconnect') {
    await eventually(() => ends(client).length === 1, 'missing terminal event');
    assert.equal(ends(client)[0].reason, reason);
    const count = events.filter(e => e.playback_id === client.result.playbackId).length;
    await wait(40);
    assert.equal(events.filter(e => e.playback_id === client.result.playbackId).length, count, 'events emitted after terminal');
  }
  return { state, open, ends, assertCancelled };
}

for (const mode of ['proxy', 'pipe'] as const) {
  test(`${mode}: disconnect stops provider reads and emits one terminal`, async t => {
    const f = await fixture(t, 'stream', mode); const client = f.open();
    await eventually(() => client.result.bytes > 0, 'no stream data');
    assert.ok(f.state.consumedRequests > 0, 'GET must be consumed before streaming');
    client.destroy();
    await eventually(() => f.state.active === 0, 'orphaned upstream');
    const bytes = f.state.upstreamBytes; await f.assertCancelled(client);
    assert.equal(f.state.upstreamBytes, bytes, 'upstream kept fetching after disconnect');
  });
  test(`${mode}: exact byte-range seeking completes without cancellation`, async t => {
    const f = await fixture(t, 'range', mode); const client = f.open('bytes=1234-65535');
    await eventually(() => client.result.ended, 'range never completed');
    assert.equal(client.result.status, 206);
    assert.ok(Buffer.concat(client.result.chunks).equals(payload.subarray(1234, 65536)), 'range payload differs');
    await eventually(() => f.ends(client).length === 1, 'missing completion');
    assert.equal(f.ends(client)[0].reason, 'complete');
    assert.equal(f.ends(client)[0].bytes_written, 65536 - 1234);
  });
}
for (const kind of ['pending', 'redirect', 'no-range', 'retry-pending'] as const) {
  test(`disconnect cancels ${kind} upstream request`, async t => {
    const f = await fixture(t, kind); const client = f.open();
    const expected = kind === 'pending' ? 1 : 2;
    await eventually(() => f.state.requests.length === expected, 'pending request not reached');
    client.destroy(); await eventually(() => f.state.active === 0, 'pending upstream remained open');
    await f.assertCancelled(client); await wait(120);
    assert.equal(f.state.requests.length, expected, 'retried after client disconnect');
    if (kind === 'no-range') assert.equal(f.state.requests[1].range, undefined);
  });
}
test('upstream interruption reconnects while completed GET response remains alive', async t => {
  const f = await fixture(t, 'reconnect'); const client = f.open();
  await eventually(() => client.result.ended, 'reconnect never completed');
  assert.ok(f.state.consumedRequests > 0);
  assert.ok(Buffer.concat(client.result.chunks).equals(payload), 'reconnected payload differs');
  assert.equal(f.state.requests.length, 2);
  assert.equal(f.state.requests[1].range, `bytes=${32 * 1024}-${payload.length - 1}`);
  assert.equal(f.ends(client)[0].reason, 'complete'); assert.equal(f.ends(client)[0].reconnects, 1);
});
test('disconnect cancels a retry backoff before another connection starts', async t => {
  const f = await fixture(t, 'connect-fail'); const client = f.open();
  await eventually(() => f.state.requests.length === 1, 'initial request missing');
  await wait(15); client.destroy(); await f.assertCancelled(client); await wait(160);
  assert.equal(f.state.requests.length, 1);
});
test('disconnect while client is paused releases buffered upstream', async t => {
  const f = await fixture(t, 'stream'); const client = f.open('bytes=0-', true);
  await eventually(() => f.state.upstreamBytes >= 2 * 1024 * 1024, 'buffer not filled');
  client.destroy(); await eventually(() => f.state.active === 0, 'buffered upstream leaked');
  await f.assertCancelled(client);
});
test('disconnecting one viewer preserves another range stream of the same file', async t => {
  const f = await fixture(t, 'stream'); const first = f.open(); const second = f.open('bytes=65536-');
  await eventually(() => first.result.bytes > 0 && second.result.bytes > 0, 'parallel streams not serving');
  first.destroy(); await eventually(() => f.state.active === 1, 'wrong viewer cancellation');
  await f.assertCancelled(first); const previous = second.result.bytes;
  await eventually(() => second.result.bytes > previous, 'second viewer interrupted');
  assert.equal(f.ends(second).length, 0);
  second.destroy(); await eventually(() => f.state.active === 0, 'second viewer leaked'); await f.assertCancelled(second);
});
test('superseding a full request preserves its reason and the replacement range', async t => {
  const f = await fixture(t, 'stream'); const full = f.open(null);
  await eventually(() => full.result.bytes > 0, 'full stream not serving');
  const range = f.open('bytes=1024-'); await eventually(() => range.result.bytes > 0, 'replacement not serving');
  await f.assertCancelled(full, 'superseded'); assert.equal(f.state.active, 1);
  range.destroy(); await eventually(() => f.state.active === 0, 'replacement leaked'); await f.assertCancelled(range);
});
