import { Beachside, type DirectConnectOptions, type AdapterSandbox } from "beachside";
import { daytona } from "@beachside/daytona";
import { acmeAdapter } from "./acme-adapter";

const options: DirectConnectOptions = { cleanup: { storage: "allow-unconfirmed" } };

export function connectDaytona(config: Parameters<typeof daytona>[0]) {
  return Beachside.connect(daytona(config), options);
}

export function connectExplicit() {
  return Beachside.connect({
    adapter: acmeAdapter,
    config: { region: "us" },
    credentials: { token: "example" },
    ...options,
  });
}

export async function cleanup(box: AdapterSandbox) {
  const result = await box.destroy();
  console.log(result.mountDurability, result.retainedResources);
}

export async function strictCleanup(box: AdapterSandbox) {
  return (await box.submitDestroy({ storage: "require-durable" })).wait();
}
