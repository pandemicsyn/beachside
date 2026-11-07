import { Beachside } from "beachside";
import { e2b } from "@beachside/e2b";

const apiKey = process.env.E2B_API_KEY;

if (!apiKey) throw new Error("Set E2B_API_KEY before running this example");

const beachside = await Beachside.connect(e2b({ apiKey }));

try {
  await beachside.sandboxes.with({}, async (box) => {
    const output = await box.exec(["printf", "Hello from Beachside!\n"]);
    console.log(output.stdoutText());
  });
} finally {
  await beachside.close();
}
