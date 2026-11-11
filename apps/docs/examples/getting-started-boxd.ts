import { Beachside } from "beachside";
import { boxdAdapter } from "@beachside/boxd";

const apiKey = process.env.BOXD_API_KEY;

const org = process.env.BOXD_ORG;

if (!apiKey || !org) throw new Error("Set BOXD_API_KEY and BOXD_ORG before running this example");

const beachside = await Beachside.connect({
  adapter: boxdAdapter,
  credentials: { apiKey },
  config: { org, network: "blocked" },
});

try {
  await beachside.sandboxes.with({}, async (box) => {
    const output = await box.exec(["printf", "Hello from Beachside!\n"]);
    console.log(output.stdoutText());
  });
} finally {
  await beachside.close();
}
