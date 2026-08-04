// Structured logs + CloudWatch metrics with zero AWS dependencies.
//
// Logs are JSON lines on stdout — the ECS awslogs driver ships them to the
// existing log group. Metrics use CloudWatch Embedded Metric Format (EMF):
// a metric is just a log line carrying an _aws envelope, which CloudWatch
// extracts into real metrics automatically. No SDK calls, no new IAM, no
// network path that can fail — if the process can log, it can meter.
//
// Locally (no namespace configured) metric lines degrade to plain JSON logs.

export interface TelemetryOptions {
  /** Service dimension value (default 'match-server') */
  service?: string;
  /** CloudWatch namespace; unset → metric lines are plain logs, no EMF */
  metricsNamespace?: string;
  /** line sink, injectable for tests (default console.log) */
  write?: (line: string) => void;
}

export type MetricUnit = 'Count' | 'Milliseconds';

export interface Telemetry {
  log(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  metric(name: string, value: number, unit?: MetricUnit): void;
}

/** Default for library use: silent. Servers opt into real telemetry (the CLI
 *  always does); tests stay quiet and inject a sink only to assert. */
export const noopTelemetry: Telemetry = {
  log: () => {}, warn: () => {}, error: () => {}, metric: () => {},
};

export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  const service = options.service ?? 'match-server';
  const write = options.write ?? ((line: string) => console.log(line));
  const namespace = options.metricsNamespace;

  const emit = (level: string, msg: string, fields?: Record<string, unknown>): void => {
    write(JSON.stringify({ ts: new Date().toISOString(), level, service, msg, ...fields }));
  };

  return {
    log: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    metric(name, value, unit = 'Count'){
      if (!namespace) return emit('metric', name, { value, unit });
      write(JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [{
            Namespace: namespace,
            Dimensions: [['Service']],
            Metrics: [{ Name: name, Unit: unit }],
          }],
        },
        Service: service,
        [name]: value,
      }));
    },
  };
}
