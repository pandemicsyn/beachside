import { Beachside } from "beachside";
import { freestyleAdapter } from "@beachside/freestyle";

const apiKey = process.env.FREESTYLE_API_KEY;

if (!apiKey) throw new Error("Set FREESTYLE_API_KEY before running this example");

const beachside = await Beachside.connect({
  adapter: freestyleAdapter,
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
