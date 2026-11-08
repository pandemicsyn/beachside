import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  AdapterError,
  AdapterFilesystemError,
  bindAdapter,
  defineAdapter,
} from "@beachside/adapter";
import { AdapterImage } from "beachside";
import { createFakeAdapter } from "@beachside-internal/provider-fake";
import { z } from "zod";

const url = process.env.BEACHSIDE_FAKE_URL;

const token = process.env.BEACHSIDE_FAKE_TOKEN;

if (!url || !token) throw new Error("BEACHSIDE_FAKE_URL and BEACHSIDE_FAKE_TOKEN are required");

const definition = createFakeAdapter({ url, token });

/** A bound fake adapter so CLI processes in tests reach the test's fake provider server. */
export const fake = bindAdapter(definition, {}, {});

/** The fake adapter behind a token credential, to prove how the CLI resolves credentials. */
export const guarded = defineAdapter({
  name: "fake",
  displayName: "Fake test provider with a token",
  config: z.strictObject({}),
  credentials: z.strictObject({ token: z.string() }),
  async connect({ credentials, host }) {
    if (credentials.token !== token) throw new Error(`wrong token ${credentials.token}`);

    return definition.connect({ config: {}, credentials: {}, host });
  },
});

/** The fake adapter without create-time env, like a provider that cannot guarantee it. */
export const withoutCreateEnv = bindAdapter(
  defineAdapter({
    name: "fake",
    displayName: "Fake test provider without create env",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      const session = await definition.connect({ config: {}, credentials: {}, host });

      return { ...session, supports: { ...session.supports, createEnv: false } };
    },
  }),
  {},
  {},
);

/** The fake adapter without image inspection, inventory or deletion, like boxd or Vercel. */
export const plain = bindAdapter(
  defineAdapter({
    name: "fake",
    displayName: "Fake test provider without image management",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      const {
        imageInspect: _inspect,
        imageList: _list,
        imageListCoverage: _coverage,
        imageDelete: _delete,
        ...session
      } = await definition.connect({ config: {}, credentials: {}, host });

      return session;
    },
  }),
  {},
  {},
);

const terminations = process.env.BEACHSIDE_FAKE_TERMINATIONS;

/** The fake adapter with its byte-streaming process transport; BEACHSIDE_FAKE_TERMINATIONS logs terminations. */
function streamingAdapter(holdMs: number, textOnly = false) {
  const processing = createFakeAdapter({
    url: url!,
    token: token!,
    processes: { holdMs, textOnly },
  });

  return bindAdapter(
    defineAdapter({
      name: "fake",
      displayName: "Fake test provider that streams process output",
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect({ host }) {
        const session = await processing.connect({ config: {}, credentials: {}, host });
        const processes = session.processes!;

        return {
          ...session,
          processes: {
            ...processes,
            async start(
              input: Parameters<typeof processes.start>[0],
              ctx: Parameters<typeof processes.start>[1],
            ) {
              const native = await processes.start(input, ctx);
              const terminate = native.terminate!;

              return Object.assign(native, {
                async terminate(context: Parameters<typeof terminate>[0]) {
                  if (terminations) await appendFile(terminations, "terminate\n");

                  return terminate(context);
                },
              });
            },
          },
        };
      },
    }),
    {},
    {},
  );
}

/** Streams each seeded command's output, then exits, like Daytona, E2B or Vercel. */
export const streaming = streamingAdapter(0);

/** Streams the output, then keeps running for a minute unless it is terminated. */
export const hanging = streamingAdapter(60_000);

/** Streams text only and keeps running, like Boat or Runloop. */
export const hangingText = streamingAdapter(60_000, true);

const builds = process.env.BEACHSIDE_FAKE_BUILDS;

const building = createFakeAdapter({ url, token, imageBuild: true });

/** The fake session with its simulated image build; BEACHSIDE_FAKE_BUILDS logs every build. */
async function buildingSession(host: Parameters<typeof building.connect>[0]["host"]) {
  const session = await building.connect({ config: {}, credentials: {}, host });
  const build = session.imageBuild;

  if (!build || !("submit" in build)) throw new Error("The fake must build images");

  return {
    ...session,
    imageBuild: {
      ...build,
      async submit(
        input: Parameters<typeof build.submit>[0],
        ctx: Parameters<typeof build.submit>[1],
      ) {
        if (builds) await appendFile(builds, `${input.source.value}\n`);

        return build.submit(input, ctx);
      },
    },
  };
}

/**
 * The fake adapter with its simulated image build, standing in for build-first providers such as
 * E2B. Each build is a new fake image; a `lost/` reference loses the build and delete responses.
 */
export const builder = bindAdapter(
  defineAdapter({
    name: "fake",
    displayName: "Fake test provider that builds images",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    connect: ({ host }) => buildingSession(host),
  }),
  {},
  {},
);

/**
 * A builder whose image delete fails outside the SDK's operation tracking, so the outcome is
 * unknown and no operation reference exists to observe. Connecting patches this process's SDK.
 */
export const unobservableDelete = bindAdapter(
  defineAdapter({
    name: "fake",
    displayName: "Fake test provider whose image deletes cannot be observed",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      AdapterImage.prototype.delete = async () => {
        throw new Error("Fake image delete failed without an operation reference");
      };

      return buildingSession(host);
    },
  }),
  {},
  {},
);

/** The builder connected to another account, so references saved by `builder` do not match it. */
export const otherAccount = bindAdapter(
  defineAdapter({
    name: "fake",
    displayName: "Fake test provider in another account",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      const session = await buildingSession(host);

      return {
        ...session,
        scope: { ...session.scope, authority: { kind: "fixture", id: "other" } },
      };
    },
  }),
  {},
  {},
);

/** The fake adapter with simulated filesystem snapshots, like Daytona, E2B or Modal. */
export const snapshotting = bindAdapter(createFakeAdapter({ url, token, snapshots: true }), {}, {});

const streamedFiles = process.env.BEACHSIDE_FAKE_FILES;

/** Sandbox paths of the file-streaming fake live under BEACHSIDE_FAKE_FILES on the test host. */
function hostPath(path: string): string {
  if (!streamedFiles) throw new Error("BEACHSIDE_FAKE_FILES is required");

  return join(streamedFiles, path);
}

/** The fake adapter with incremental file streams, like boxd, Daytona, E2B or Vercel. */
export const fileStreaming = bindAdapter(
  defineAdapter({
    name: "fake",
    displayName: "Fake test provider that streams files",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      const session = await definition.connect({ config: {}, credentials: {}, host });

      return {
        ...session,
        files: {
          ...session.files!,
          async readStream(input: { path: string }) {
            const chunks = createReadStream(hostPath(input.path))[Symbol.asyncIterator]();

            return new ReadableStream<Uint8Array>({
              async pull(controller) {
                const next = await chunks.next();

                if (next.done) controller.close();
                else controller.enqueue(new Uint8Array(next.value));
              },
              async cancel() {
                await chunks.return?.();
              },
            });
          },
          async writeStream(input: {
            path: string;
            bytes: AsyncIterable<Uint8Array>;
            overwrite: boolean;
          }) {
            const target = hostPath(input.path);
            let bytesWritten = 0;
            await mkdir(dirname(target), { recursive: true });

            try {
              await pipeline(
                async function* () {
                  for await (const chunk of input.bytes) {
                    bytesWritten += chunk.byteLength;
                    yield chunk;
                  }
                },
                createWriteStream(target, { flags: input.overwrite ? "w" : "wx" }),
              );
            } catch (cause) {
              if (cause instanceof Error && "code" in cause && cause.code === "EEXIST")
                throw new AdapterFilesystemError("CONFLICT", "File exists", { effect: "none" });
              throw cause;
            }

            return { bytesWritten };
          },
        },
      };
    },
  }),
  {},
  {},
);

const stdinLog = process.env.BEACHSIDE_FAKE_STDIN;

/** With BEACHSIDE_FAKE_STDIN_FAIL_AFTER, writes past that many bytes fail like a dropped link. */
const failAfter = process.env.BEACHSIDE_FAKE_STDIN_FAIL_AFTER
  ? Number(process.env.BEACHSIDE_FAKE_STDIN_FAIL_AFTER)
  : undefined;

/**
 * Streams output and takes incremental stdin, like Daytona, E2B or Vercel. Each command appends
 * its input to BEACHSIDE_FAKE_STDIN and exits once its stdin is closed; a buffered exec captures
 * the number of input bytes as stdout.
 */
export const stdinStreaming = bindAdapter(
  defineAdapter({
    name: "fake",
    displayName: "Fake test provider that streams stdin",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      const processing = createFakeAdapter({ url: url!, token: token!, processes: { holdMs: 0 } });
      const session = await processing.connect({ config: {}, credentials: {}, host });
      const processes = session.processes!;

      return {
        ...session,
        processes: {
          ...processes,
          supports: {
            ...processes.supports,
            stdin: "bytes" as const,
            execCapture: "bytes" as const,
          },
          async start(
            input: Parameters<typeof processes.start>[0],
            ctx: Parameters<typeof processes.start>[1],
          ) {
            const native = await processes.start(input, ctx);
            let closed = false;
            let received = 0;
            let open: () => void = () => undefined;

            const gate = new Promise<void>((resolve) => {
              open = resolve;
            });

            return {
              get confirmedExit() {
                return closed ? native.confirmedExit : undefined;
              },
              wait: async () => {
                await gate;

                return native.wait();
              },
              outputDone: gate.then(() => native.outputDone),
              // Buffered exec captures the byte count received, like `wc -c`.
              capture: gate.then(async () => ({
                exitCode: (await native.wait()).exitCode,
                stdout: new TextEncoder().encode(`${received}\n`),
                stderr: new Uint8Array(),
                truncated: false,
              })),
              detachOutput: () => native.detachOutput!(),
              async terminate(context: Parameters<NonNullable<typeof native.terminate>>[0]) {
                closed = true;
                open();

                return native.terminate!(context);
              },
              detach: () => native.detach(),
              async write(bytes: Uint8Array) {
                if (failAfter !== undefined && received + bytes.byteLength > failAfter)
                  throw new AdapterError("UNAVAILABLE", "Fake stdin transport dropped");
                received += bytes.byteLength;

                if (stdinLog) await appendFile(stdinLog, bytes);
              },
              async closeStdin() {
                closed = true;
                open();
              },
            };
          },
        },
      };
    },
  }),
  {},
  {},
);
