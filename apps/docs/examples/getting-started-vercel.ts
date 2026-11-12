import { Beachside } from "beachside";
import { vercelAdapter } from "@beachside/vercel";

const token = process.env.VERCEL_TOKEN;

const teamId = process.env.VERCEL_TEAM_ID;

const projectId = process.env.VERCEL_PROJECT_ID;

if (!token || !teamId || !projectId)
  throw new Error(
    "Set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID before running this example",
  );

const beachside = await Beachside.connect({
  adapter: vercelAdapter,
  credentials: { token },
  config: { teamId, projectId },
});

try {
  await beachside.sandboxes.with({}, async (box) => {
    const output = await box.exec(["printf", "Hello from Beachside!\n"]);
    console.log(output.stdoutText());
  });
} finally {
  await beachside.close();
}
