import crypto from 'node:crypto';

export const STREAM_TELEMETRY_PREFIX = 'UU_STREAM_EVENT ';

export type StreamTelemetryEventName = 'request_start' | 'request_progress' | 'request_end';

export type StreamEndReason =
  | 'complete'
  | 'client_disconnect'
  | 'superseded'
  | 'concurrency_limit'
  | 'upstream_connect_error'
  | 'upstream_not_found'
  | 'upstream_http_error'
  | 'upstream_interrupted'
  | 'upstream_truncated'
  | 'file_size_changed'
  | 'range_gap'
  | 'reconnect_exhausted'
  | 'proxy_error';

export interface StreamTelemetryEvent {
  schema: 1;
  event: StreamTelemetryEventName;
  event_id: string;
  playback_id: string;
  request_id: string;
  timestamp: string;
  mode: 'proxy' | 'pipe';
  range_start: number;
  range_end: number | null;
  status: number | null;
  total_size: number | null;
  bytes_written: number;
  reconnects: number;
  reason?: StreamEndReason;
}

export interface StreamTelemetryOptions {
  playbackId?: string;
  mode: 'proxy' | 'pipe';
  rangeStart: number;
  rangeEnd: number | null;
  enabled?: boolean;
  emit?: (line: string) => void;
  now?: () => Date;
}

export function isValidPlaybackId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function createPlaybackId(): string {
  return crypto.randomUUID();
}

export function telemetryEnabled(value = process.env.STREAM_TELEMETRY_ENABLED): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? '');
}

export class StreamRequestTelemetry {
  readonly playbackId: string;
  readonly requestId: string;
  readonly enabled: boolean;

  private readonly mode: 'proxy' | 'pipe';
  private readonly rangeStart: number;
  private readonly rangeEnd: number | null;
  private readonly emitLine: (line: string) => void;
  private readonly now: () => Date;
  private status: number | null = null;
  private totalSize: number | null = null;
  private bytesWritten = 0;
  private reconnects = 0;
  private ended = false;

  constructor(options: StreamTelemetryOptions) {
    this.playbackId = isValidPlaybackId(options.playbackId)
      ? options.playbackId
      : createPlaybackId();
    this.requestId = crypto.randomUUID();
    this.enabled = options.enabled ?? telemetryEnabled();
    this.mode = options.mode;
    this.rangeStart = options.rangeStart;
    this.rangeEnd = options.rangeEnd;
    this.emitLine = options.emit ?? console.log;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    this.emit('request_start');
  }

  progress(): void {
    if (!this.ended) this.emit('request_progress');
  }

  setResponse(status: number, totalSize: number | null): void {
    this.status = status;
    this.totalSize = totalSize;
  }

  addBytes(count: number): void {
    if (Number.isFinite(count) && count > 0) this.bytesWritten += count;
  }

  setReconnects(count: number): void {
    if (Number.isInteger(count) && count >= 0) this.reconnects = count;
  }

  end(reason: StreamEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.emit('request_end', reason);
  }

  private emit(event: StreamTelemetryEventName, reason?: StreamEndReason): void {
    if (!this.enabled) return;
    const payload: StreamTelemetryEvent = {
      schema: 1,
      event,
      event_id: crypto.randomUUID(),
      playback_id: this.playbackId,
      request_id: this.requestId,
      timestamp: this.now().toISOString(),
      mode: this.mode,
      range_start: this.rangeStart,
      range_end: this.rangeEnd,
      status: this.status,
      total_size: this.totalSize,
      bytes_written: this.bytesWritten,
      reconnects: this.reconnects,
      ...(reason ? { reason } : {}),
    };
    this.emitLine(`${STREAM_TELEMETRY_PREFIX}${JSON.stringify(payload)}`);
  }
}
