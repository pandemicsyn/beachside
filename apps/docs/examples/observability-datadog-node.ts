import tracer from "dd-trace";

tracer.init({ service: "beachside-demo" });

const provider = new tracer.TracerProvider();

provider.register();

// Import the SDK after registering the application's existing Datadog tracer.
const { Beachside, Image } = await import("beachside");

const { daytona } = await import("@beachside/daytona");

const client = await Beachside.connect(
  daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    target: process.env.DAYTONA_TARGET ?? "us",
    ttlMinutes: 15,
    network: "daytona-default",
  }),
);

try {
  await tracer.trace("beachside-demo", async () => {
    const box = await client.sandboxes.create({
      environment: Image.prepared("daytona-small"),
    });

    await box.destroy();
  });
} finally {
  await client.close();
}
