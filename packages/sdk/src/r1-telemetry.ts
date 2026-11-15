/**
 * E5-S2 OTel-compatible task/model/tool telemetry
 * - Emit spans for task, agent, recall, model, approval wait, tool, outcome
 * - Record model/latency/token metadata when available
 * - Do not capture prompt/memory/file/tool content by default
 * - Trace IDs correlate with audit, receipt, task, approval
 * - Metrics cover task outcomes, retries, approval latency, recall mode/usefulness, tool failures, provider health
 * - Exporter failure cannot fail task or mutate domain state
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';

export const SpanKindSchema = z.enum(['task', 'agent', 'recall', 'model', 'approval_wait', 'tool', 'outcome', 'checkpoint']);
export type SpanKind = z.infer<typeof SpanKindSchema>;

export const SpanStatusSchema = z.enum(['ok', 'error', 'unset']);
export type SpanStatus = z.infer<typeof SpanStatusSchema>;

export const TelemetrySpanSchema = z.object({
  spanId: z.string().min(1),
  traceId: z.string().min(1),
  parentSpanId: z.string().min(1).optional(),
  kind: SpanKindSchema,
  name: z.string().min(1).max(500),
  startAt: z.string().datetime(),
  endAt: z.string().datetime().optional(),
  status: SpanStatusSchema.default('unset'),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  taskId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  approvalId: z.string().uuid().optional(),
  receiptId: z.string().uuid().optional(),
});
export type TelemetrySpan = z.infer<typeof TelemetrySpanSchema>;

export const MetricNameSchema = z.enum([
  'task.outcome',
  'task.retry',
  'approval.latency',
  'recall.mode',
  'recall.usefulness',
  'tool.failure',
  'provider.health',
]);
export type MetricName = z.infer<typeof MetricNameSchema>;

export const MetricEventSchema = z.object({
  name: MetricNameSchema,
  value: z.number(),
  timestamp: z.string().datetime(),
  labels: z.record(z.string(), z.string()).default({}),
});
export type MetricEvent = z.infer<typeof MetricEventSchema>;

export interface SpanExporter {
  export(spans: readonly TelemetrySpan[]): Promise<void>;
}

export interface MetricExporter {
  export(metrics: readonly MetricEvent[]): Promise<void>;
}

class NoopSpanExporter implements SpanExporter {
  async export(_spans: readonly TelemetrySpan[]): Promise<void> {}
}
class NoopMetricExporter implements MetricExporter {
  async export(_metrics: readonly MetricEvent[]): Promise<void> {}
}

export interface TelemetryOptions {
  readonly now?: () => string;
  readonly spanExporter?: SpanExporter;
  readonly metricExporter?: MetricExporter;
}

/**
 * Safe telemetry service - exporter failure cannot fail task.
 */
export class TelemetryService {
  private readonly now: () => string;
  private readonly spanExporter: SpanExporter;
  private readonly metricExporter: MetricExporter;
  private readonly spans: TelemetrySpan[] = [];
  private readonly metrics: MetricEvent[] = [];

  constructor(options: TelemetryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.spanExporter = options.spanExporter ?? new NoopSpanExporter();
    this.metricExporter = options.metricExporter ?? new NoopMetricExporter();
  }

  startSpan(input: { kind: SpanKind; name: string; traceId?: string; parentSpanId?: string; taskId?: string; projectId?: string; attributes?: Record<string, string | number | boolean> }): TelemetrySpan {
    const span: TelemetrySpan = {
      spanId: randomUUID(),
      traceId: input.traceId ?? randomUUID(),
      parentSpanId: input.parentSpanId,
      kind: input.kind,
      name: input.name,
      startAt: this.now(),
      status: 'unset',
      attributes: input.attributes ?? {},
      taskId: input.taskId,
      projectId: input.projectId,
    };
    this.spans.push(span);
    return span;
  }

  endSpan(spanId: string, status: SpanStatus = 'ok', attrs?: Record<string, string | number | boolean>): TelemetrySpan | null {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (!span) return null;
    span.endAt = this.now();
    span.status = status;
    if (attrs) span.attributes = { ...span.attributes, ...attrs };
    return span;
  }

  /** Record latency/token metadata without content */
  recordModelMetadata(spanId: string, meta: { model?: string; latencyMs?: number; tokensUsed?: number; tokensInput?: number; tokensOutput?: number }): void {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (!span) return;
    span.attributes = {
      ...span.attributes,
      ...(meta.model ? { 'model.name': meta.model } : {}),
      ...(meta.latencyMs != null ? { 'model.latency_ms': meta.latencyMs } : {}),
      ...(meta.tokensUsed != null ? { 'model.tokens_used': meta.tokensUsed } : {}),
      ...(meta.tokensInput != null ? { 'model.tokens_input': meta.tokensInput } : {}),
      ...(meta.tokensOutput != null ? { 'model.tokens_output': meta.tokensOutput } : {}),
    };
  }

  // Metrics
  recordMetric(name: MetricName, value: number, labels: Record<string, string> = {}): MetricEvent {
    const metric: MetricEvent = { name, value, timestamp: this.now(), labels };
    this.metrics.push(metric);
    return metric;
  }

  // Convenience helpers
  taskOutcome(taskId: string, projectId: string, outcome: string, traceId?: string): void {
    this.recordMetric('task.outcome', 1, { outcome, taskId, projectId });
  }
  retry(taskId: string, projectId: string, attempt: number): void {
    this.recordMetric('task.retry', attempt, { taskId, projectId });
  }
  approvalLatency(approvalId: string, latencyMs: number, projectId: string): void {
    this.recordMetric('approval.latency', latencyMs, { approvalId, projectId });
  }
  recallMode(mode: string, projectId: string): void {
    this.recordMetric('recall.mode', 1, { mode, projectId });
  }
  recallUsefulness(resultId: string, helpful: boolean, projectId: string): void {
    this.recordMetric('recall.usefulness', helpful ? 1 : 0, { resultId, projectId });
  }
  toolFailure(tool: string, projectId: string, taskId: string): void {
    this.recordMetric('tool.failure', 1, { tool, projectId, taskId });
  }

  async flush(): Promise<void> {
    // Exporter failure cannot fail task or mutate domain state
    try {
      if (this.spans.length) await this.spanExporter.export([...this.spans]);
    } catch {
      // swallow
    }
    try {
      if (this.metrics.length) await this.metricExporter.export([...this.metrics]);
    } catch {
      // swallow
    }
  }

  listSpans(): readonly TelemetrySpan[] { return [...this.spans]; }
  listMetrics(): readonly MetricEvent[] { return [...this.metrics]; }
  correlationIds(spanId: string): { traceId: string; taskId?: string; projectId?: string } | null {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (!span) return null;
    return { traceId: span.traceId, taskId: span.taskId, projectId: span.projectId };
  }
}
