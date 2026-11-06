import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STREAM_TELEMETRY_PREFIX,
  StreamRequestTelemetry,
  isValidPlaybackId,
  telemetryEnabled,
} from '../src/streamTelemetry.js';

function parseEvent(line: string): Record<string, unknown> {
  assert.ok(line.startsWith(STREAM_TELEMETRY_PREFIX));
  return JSON.parse(line.slice(STREAM_TELEMETRY_PREFIX.length));
}

test('emits a correlated lifecycle without sensitive request data', () => {
  const lines: string[] = [];
  const playbackId = 'fef6e80d-c32b-4bc8-a535-1f24cdffed8a';
  const telemetry = new StreamRequestTelemetry({
    playbackId,
    mode: 'proxy',
    rangeStart: 1024,
    rangeEnd: null,
    enabled: true,
    emit: (line) => lines.push(line),
    now: () => new Date('2026-11-06T12:00:00.000Z'),
  });

  telemetry.start();
  telemetry.setResponse(206, 10_000);
  telemetry.addBytes(4096);
  telemetry.setReconnects(2);
  telemetry.progress();
  telemetry.end('client_disconnect');

  assert.equal(lines.length, 3);
  const [start, progress, end] = lines.map(parseEvent);
  assert.equal(start.event, 'request_start');
  assert.equal(progress.event, 'request_progress');
  assert.equal(end.event, 'request_end');
  assert.equal(end.playback_id, playbackId);
  assert.equal(end.request_id, start.request_id);
  assert.equal(end.bytes_written, 4096);
  assert.equal(end.reconnects, 2);
  assert.equal(end.reason, 'client_disconnect');
  assert.equal(end.status, 206);
  assert.equal(end.total_size, 10_000);

  for (const event of [start, progress, end]) {
    for (const forbidden of ['url', 'path', 'client_ip', 'headers', 'manifest_key', 'credentials']) {
      assert.ok(!(forbidden in event), `event must not expose ${forbidden}`);
    }
  }
});

test('does not emit when telemetry is disabled and ends only once', () => {
  const disabledLines: string[] = [];
  const disabled = new StreamRequestTelemetry({
    mode: 'pipe',
    rangeStart: 0,
    rangeEnd: null,
    enabled: false,
    emit: (line) => disabledLines.push(line),
  });
  disabled.start();
  disabled.progress();
  disabled.end('complete');
  assert.deepEqual(disabledLines, []);

  const lines: string[] = [];
  const enabled = new StreamRequestTelemetry({
    mode: 'pipe',
    rangeStart: 0,
    rangeEnd: 99,
    enabled: true,
    emit: (line) => lines.push(line),
  });
  enabled.start();
  enabled.end('complete');
  enabled.end('proxy_error');
  enabled.progress();
  assert.equal(lines.length, 2);
  assert.equal(parseEvent(lines[1]).reason, 'complete');
});

test('validates playback IDs and explicit enable values', () => {
  assert.equal(isValidPlaybackId('fef6e80d-c32b-4bc8-a535-1f24cdffed8a'), true);
  assert.equal(isValidPlaybackId('not-a-uuid'), false);
  assert.equal(telemetryEnabled('TRUE'), true);
  assert.equal(telemetryEnabled('on'), true);
  assert.equal(telemetryEnabled('false'), false);
});
