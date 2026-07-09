/**
 * M1 迭代 1：简化的 observability stub。
 * M3 阶段替换为真正的 metrics（Prometheus）+ tracing（OpenTelemetry）。
 */

export interface Span {
  finish(tags?: Record<string, unknown>): void;
}

class StubSpan implements Span {
  constructor(
    private readonly operation: string,
    private readonly start: number,
    private readonly tags: Record<string, unknown>,
  ) {}

  finish(tags?: Record<string, unknown>): void {
    const durationMs = Date.now() - this.start;
    if (process.env.OMNIAGENT_TRACE === '1') {
      // eslint-disable-next-line no-console
      console.error(`[trace] ${this.operation} ${durationMs}ms`, { ...this.tags, ...tags });
    }
  }
}

export const tracer = {
  startSpan(operation: string, tags: Record<string, unknown> = {}): Span {
    return new StubSpan(operation, Date.now(), tags);
  },
};

export const metrics = {
  counter(name: string, tags: Record<string, unknown> = {}): void {
    if (process.env.OMNIAGENT_METRICS === '1') {
      // eslint-disable-next-line no-console
      console.error(`[metric:counter] ${name}`, tags);
    }
  },
  increment(name: string, tags: Record<string, unknown> = {}): void {
    this.counter(name, tags);
  },
  histogram(_name: string, _value: number, _tags: Record<string, unknown> = {}): void {
    // M1 stub: no-op
  },
  gauge(_name: string, _value: number, _tags: Record<string, unknown> = {}): void {
    // M1 stub: no-op
  },
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
