import * as Sentry from "@sentry/node";
import { Beachside, Image } from "beachside";
import { daytona } from "@beachside/daytona";

Sentry.init({
  dsn: process.env.SENTRY_DSN!,
  tracesSampleRate: 1,
  enableOpenTelemetrySetup: true,
});

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
    await Sentry.startSpan({ name: "beachside-demo" }, async () => {
      const box = await client.sandboxes.create({
        environment: Image.prepared("daytona-small"),
      });

      await box.destroy();
    });
  } finally {
    await client.close();
  }
} finally {
  await Sentry.close(2000);
}
