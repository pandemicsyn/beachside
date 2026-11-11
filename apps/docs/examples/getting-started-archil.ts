import { Beachside } from "beachside";
import { archilAdapter } from "@beachside/archil";

const apiKey = process.env.ARCHIL_API_KEY;

if (!apiKey) throw new Error("Set ARCHIL_API_KEY before running this example");

const beachside = await Beachside.connect({
  adapter: archilAdapter,
  credentials: { apiKey },
  config: { region: "aws-us-east-1", network: "blocked" },
});

try {
  await beachside.sandboxes.with({}, async (box) => {
    const output = await box.exec(["printf", "Hello from Beachside!\n"]);
    console.log(output.stdoutText());
  });
} finally {
  await beachside.close();
}
