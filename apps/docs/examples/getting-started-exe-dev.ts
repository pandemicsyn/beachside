import { Beachside } from "beachside";
import { exeDevAdapter } from "@beachside/exe-dev";

const token = process.env.EXE_API_KEY;

if (!token) throw new Error("Set EXE_API_KEY before running this example");

const beachside = await Beachside.connect({
  adapter: exeDevAdapter,
  credentials: { token },
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
