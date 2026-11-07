import { Image, Beachside } from "beachside";
import { modalAdapter } from "@beachside/modal";

const tokenId = process.env.MODAL_TOKEN_ID;

const tokenSecret = process.env.MODAL_TOKEN_SECRET;

const appName = process.env.MODAL_APP_NAME;

const imageId = process.env.MODAL_IMAGE_ID;

if (!tokenId || !tokenSecret || !appName || !imageId)
  throw new Error("Set MODAL_TOKEN_ID, MODAL_TOKEN_SECRET, MODAL_APP_NAME, and MODAL_IMAGE_ID");

const beachside = await Beachside.connect({
  adapter: modalAdapter,
  credentials: { tokenId, tokenSecret },
  config: { appName, environment: "main", lifecycle: { lifetimeSeconds: 300 } },
});

try {
  const box = await beachside.sandboxes.create({
    environment: Image.prepared(imageId),
    network: "blocked",
  });

  try {
    const output = await box.exec(["/bin/sh", "-c", "printf 'Hello from Beachside!\n'"]);
    console.log(output.stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await beachside.close();
}
