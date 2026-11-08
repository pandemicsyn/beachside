/* oxlint-disable anti-slop/no-unknown-parameters -- Applications may catch arbitrary values; only diagnosticContext's bounded record reaches Sentry. */
import * as Sentry from "@sentry/node"; // use @sentry/bun on Bun
import { context, trace } from "@opentelemetry/api";
import { diagnosticContext } from "beachside";

export function captureBeachsideFailure(
  error: unknown,
  sentry: Pick<typeof Sentry, "withScope" | "captureMessage"> = Sentry,
) {
  const active = trace.getSpanContext(context.active());
  const diagnostic = { ...diagnosticContext(error) };

  sentry.withScope((scope) => {
    scope.addEventProcessor((event) => ({
      event_id: event.event_id,
      timestamp: event.timestamp,
      level: "error",
      message: "Beachside operation failed",
      contexts: {
        trace: active ? { trace_id: active.traceId, span_id: active.spanId } : undefined,
        beachside: diagnostic,
      },
    }));
    sentry.captureMessage("Beachside operation failed", { level: "error" });
  });
}
