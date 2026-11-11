import { Beachside } from "beachside";
import { exeDevAdapter } from "@beachside/exe-dev";
import { z } from "zod";
import { defineProviderProfile } from "./profile";
import { features, supportMetadataSchema } from "./support";

const Routing = z.object({
  imageId: z.string().min(1),
  networkPolicy: z.literal("internet"),
  // exe.dev VMs have no native expiry; this is the harness's approved per-run bound, and an
  // interrupted run is cleaned up through ledger reconciliation and `beachside gc`.
  nativeLifetimeSeconds: z.literal(900),
});

const implemented = new Set([
  "lifecycle",
  "execution",
  "streaming",
  "finiteStdin",
  "directories",
  "files",
  "suspension",
  "reopening",
  "termination",
  "previewProtected",
  "previewPublic",
]);

const notes: Partial<Record<keyof typeof features, string>> = {
  lifecycle:
    "One tagged VM from the default `exeuntu` image; exe.dev VMs have no lifetime, so destroy deletes them and `beachside gc` finds leftovers by tag.",
  execution:
    "Argv and shell through an `sh` wrapper that bounds output in the guest and returns exact bytes; each command must fit one 64 KB request.",
  finiteStdin: "Staged to a private guest file before the command runs, up to 1 MiB.",
  files:
    "A Python 3 helper; uploads are parallel 40 KiB positioned writes checked by size and SHA-256 before publish.",
  directories: "Copy, move, mkdir, remove, stat, exists and listings through the same helper.",
  suspension: "exe.dev pause keeps memory; resume continues the same processes.",
  reopening: "References hold the VM name and a digest of the account, never a token.",
  streaming: "Detached guest jobs with polled, byte-exact stdout and stderr; no terminals.",
  termination: "Process-group signals on the detached job.",
  previewProtected:
    "Signed one-hour VM token sent as `X-Exedev-Authorization`; needs an SSH key credential.",
  previewPublic: "`share port` plus `share set-public` on the VM's web port.",
  network: "Internet egress only; `blocked` and allowlists are refused.",
  renewal: "exe.dev VMs have no lifetime to renew.",
  snapshots: "exe.dev has no snapshots; `fork()` copies a VM instead.",
  oci: "Boots OCI images directly; no image builds.",
};

// SAFETY: These keys are taken from the fixed features literal.
const featureIds = Object.keys(features) as (keyof typeof features)[];

export default defineProviderProfile({
  id: "exe-dev",
  nativeVersion: "@exedev/sdk 0.4.1",
  configuredEnvironment: true,
  fileNoClobber: true,
  credentialVariables: ["EXE_API_KEY"],
  bounds: { nativeLifetimeSeconds: 900, exerciseMs: 240000, cleanupMs: 60000 },
  support: {
    id: "exe-dev",
    name: "exe.dev",
    features: supportMetadataSchema.shape.features.parse(
      Object.fromEntries(
        featureIds.map((id) => [
          id,
          {
            support: implemented.has(id) ? "conditional" : "unsupported",
            note:
              notes[id] ??
              (implemented.has(id)
                ? "Implemented with deterministic native-boundary tests; no live qualification yet."
                : "Not implemented by this adapter."),
          },
        ]),
      ),
    ),
  },
  configure(environment, saved) {
    return Routing.parse(
      saved ?? {
        imageId: environment.BEACHSIDE_EXE_DEV_IMAGE ?? "exeuntu",
        networkPolicy: "internet",
        nativeLifetimeSeconds: 900,
      },
    );
  },
  configuration() {
    return {
      imageClass: "prepared",
      fileRoot: "/tmp",
      authorityClass: "api-key",
      network: "internet-requested",
      regionClass: "hosted-default",
    };
  },
  connection(routing, credentials) {
    const config = Routing.parse(routing);

    return (onReference, onDiagnostic) =>
      Beachside.connect({
        adapter: exeDevAdapter,
        credentials: { token: credentials.EXE_API_KEY },
        config: { image: config.imageId, network: config.networkPolicy },
        onReference,
        onDiagnostic,
      });
  },
});
