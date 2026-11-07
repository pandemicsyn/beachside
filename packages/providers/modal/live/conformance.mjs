import { Beachside, Image } from "beachside";
import { createModalAdapter } from "../dist/index.js";

function required(name) {
  const value = process.env[name];

  if (!value)
    throw new Error(`${name} is required for an explicitly authorized live conformance run`);

  return value;
}

if (process.env.BEACHSIDE_MODAL_LIVE !== "1")
  throw new Error("Set BEACHSIDE_MODAL_LIVE=1 to opt in");

if (process.env.BEACHSIDE_MODAL_BUDGET_ACK !== "one sandbox, at most 300 seconds")
  throw new Error("Acknowledge the one-sandbox, 300-second native timeout budget");

const client = await Beachside.connect({
  adapter: createModalAdapter(),
  config: {
    appName: required("BEACHSIDE_MODAL_APP"),
    environment: required("BEACHSIDE_MODAL_ENVIRONMENT"),
    region: required("BEACHSIDE_MODAL_REGION"),
    timeoutSeconds: 300,
  },
  credentials: { tokenId: required("MODAL_TOKEN_ID"), tokenSecret: required("MODAL_TOKEN_SECRET") },
});

let box;

try {
  box = await client.sandboxes.create({
    environment: Image.prepared(required("BEACHSIDE_MODAL_IMAGE_ID")),
    region: required("BEACHSIDE_MODAL_REGION"),
    networkPolicy: "blocked",
  });
  const observation = await box.inspect();

  if (observation.state !== "running") throw new Error(`Unexpected state: ${observation.state}`);
  console.log(JSON.stringify({ sandboxId: box.id, observation }));
} finally {
  try {
    if (box) await box.destroy();
  } finally {
    await client.close();
  }
}
