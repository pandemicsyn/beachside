import { Beachside } from "beachside";
import { runloopAdapter } from "@beachside/runloop";

const apiKey = process.env.RUNLOOP_API_KEY;

if (!apiKey) throw new Error("Set RUNLOOP_API_KEY before running this example");

const beachside = await Beachside.connect({
  adapter: runloopAdapter,
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
