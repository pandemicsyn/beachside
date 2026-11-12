import { Beachside } from "beachside";
import { boatAdapter } from "@beachside/boat";

const apiKey = process.env.BOAT_API_KEY;

if (!apiKey) throw new Error("Set BOAT_API_KEY before running this example");

const beachside = await Beachside.connect({
  adapter: boatAdapter,
  credentials: { apiKey },
  config: {},
});

try {
  await beachside.sandboxes.with({}, async (box) => {
    const output = await box.exec(["printf", "Hello from Beachside!\n"]);
    console.log(output.stdoutText());
  });
} finally {
  await beachside.close();
}
