import { trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Beachside, Image } from "beachside";
import { daytona } from "@beachside/daytona";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const manager = new AsyncLocalStorageContextManager().enable();

const provider = new NodeTracerProvider({
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "http://127.0.0.1:4318/v1/traces",
        timeoutMillis: 1000,
      }),
    ),
  ],
});

provider.register({ contextManager: manager });

try {
  const client = await Beachside.connect(
    daytona({
      apiKey: process.env.DAYTONA_API_KEY!,
      target: process.env.DAYTONA_TARGET ?? "us",
      ttlMinutes: 15,
      network: "daytona-default",
    }),
  );

  try {
    await trace.getTracer("my-application").startActiveSpan("beachside-demo", async (span) => {
      try {
        const box = await client.sandboxes.create({
          environment: Image.prepared("daytona-small"),
        });

        await box.destroy();
      } finally {
        span.end();
      }
    });
  } finally {
    await client.close();
  }
} finally {
  try {
    await provider.shutdown();
  } finally {
    manager.disable();
  }
}
