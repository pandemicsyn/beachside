import { Beachside } from "beachside";
import { e2bAdapter } from "@beachside/e2b";

const apiKey = process.env.E2B_API_KEY;

if (!apiKey) throw new Error("Set E2B_API_KEY before running this example");

const beachside = await Beachside.connect({
  adapter: e2bAdapter,
  credentials: { apiKey },
  config: { network: "blocked" },
});

try {
  await beachside.sandboxes.with({}, async (box) => {
    const output = await box.exec(["printf", "Hello from Beachside!\n"]);
    console.log(output.stdoutText());
  });
} finally {
  await beachside.close();
}
