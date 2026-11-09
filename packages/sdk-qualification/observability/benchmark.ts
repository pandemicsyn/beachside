import { performance } from "node:perf_hooks";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  AlwaysOffSampler,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Beachside, Image } from "beachside";
import { fixtureAdapter } from "./adapter";

const manager = new AsyncLocalStorageContextManager().enable();

context.setGlobalContextManager(manager);

const measurements: { mode: string; concurrency: number; medianWorkloadMs: number }[] = [];

const modes = ["disabled", "unsampled", "sampled"] as const;

const REPEATS = 15;

for (const concurrency of [1, 4]) {
  const runs = await Promise.all(
    modes.map(async (mode) => {
      const exporter = new InMemorySpanExporter();

      const provider = new NodeTracerProvider({
        sampler: mode === "unsampled" ? new AlwaysOffSampler() : undefined,
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });

      const fixture = fixtureAdapter({ exitCode: 0 });

      const client = await Beachside.connect({
        adapter: fixture.adapter,
        config: {},
        credentials: {},
        tracing: mode === "disabled" ? false : { tracerProvider: provider },
      });

      const work = async () => {
        const op = await client.sandboxes.submitCreate({ environment: Image.prepared("fixture") });
        const box = await op.wait();
        await box.exec({ command: { kind: "argv", argv: ["fixture"] }, maxOutputBytes: 1024 });
        await box.readFile("/fixture");
        await box.writeFile("/fixture", new Uint8Array([1, 2]));
        await box.destroy();
      };

      const samples: number[] = [];

      return { mode, exporter, provider, client, work, samples };
    }),
  );

  for (const run of runs) for (let i = 0; i < 50; i++) await run.work();

  // Interleave the modes, so machine noise and runtime warm-up hit each mode alike.
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    for (const run of runs) {
      run.exporter.reset();
      const start = performance.now();

      for (let batch = 0; batch < 40; batch++) {
        await Promise.all(Array.from({ length: concurrency }, run.work));
        run.exporter.reset();
      }

      run.samples.push((performance.now() - start) / (40 * concurrency));
    }
  }

  for (const run of runs) {
    run.samples.sort((a, b) => a - b);
    measurements.push({
      mode: run.mode,
      concurrency,
      medianWorkloadMs: Number(run.samples[Math.floor(REPEATS / 2)]!.toFixed(4)),
    });
    await run.client.close();
    await run.provider.shutdown();
  }
}

context.disable();

manager.disable();

for (const concurrency of [1, 4]) {
  const baseline = measurements.find(
    (m) => m.mode === "disabled" && m.concurrency === concurrency,
  )!.medianWorkloadMs;

  for (const entry of measurements.filter((m) => m.concurrency === concurrency)) {
    if (entry.medianWorkloadMs - baseline > 1)
      throw new Error("Tracing exceeded the 1ms incremental workload budget");
  }
}

console.log(
  JSON.stringify(
    {
      runtime: process.versions.bun ? "bun" : "node",
      version: process.versions.bun ?? process.version,
      workload: "submit-create/wait/exec/read/write/destroy",
      budget: "<1ms incremental median per six-call workload",
      measurements,
    },
    null,
    2,
  ),
);
