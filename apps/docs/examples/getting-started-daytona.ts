import { Image, Beachside } from "beachside";
import { daytonaAdapter } from "@beachside/daytona";

const apiKey = process.env.DAYTONA_API_KEY;

if (!apiKey) throw new Error("Set DAYTONA_API_KEY before running this example");

const beachside = await Beachside.connect({
  adapter: daytonaAdapter,
  credentials: { apiKey },
  config: {
    target: "us",
    environment: Image.prepared("daytona-small"),
    lifecycle: { lifetimeSeconds: 900 },
    network: "daytona-default",
  },
});

try {
  await beachside.sandboxes.with({}, async (box) => {
    const output = await box.exec(["printf", "Hello from Beachside!\n"]);
    console.log(output.stdoutText());
  });
} finally {
  await beachside.close();
}
