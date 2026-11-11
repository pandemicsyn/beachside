import { Beachside } from "beachside";
import { freestyleAdapter } from "@beachside/freestyle";
import { z } from "zod";
import { defineProviderProfile } from "./profile";
import { features, supportMetadataSchema } from "./support";

const Routing = z.object({
  networkPolicy: z.literal("internet"),
  nativeLifetimeSeconds: z.literal(900),
});

const implemented = new Set([
  "lifecycle",
  "execution",
  "streaming",
  "finiteStdin",
  "directories",
  "previewPublic",
  "files",
  "suspension",
  "renewal",
  "reopening",
  "snapshots",
  "network",
  "termination",
]);

const notes: Partial<Record<keyof typeof features, string>> = {
  lifecycle:
    "One VM from the default `freestyle/ubuntu` snapshot with `ttlSeconds` expiry; destroy waits until Freestyle no longer returns it.",
  execution:
    "Argv and shell through a quoting `sh` wrapper with base64 output, so bytes survive the text channel; output bounded to 1 MiB.",
  finiteStdin: "Freestyle's `stdin` field, up to 1 MiB.",
  files:
    "Reads and overwrites up to 8 MiB in one sha256-verified upload; larger files stream through range reads and staged writes.",
  directories:
    "Copy, move, mkdir, remove, stat, exists and listings through a Python 3 helper; paused VMs serve reads through the native file API.",
  previewPublic: "`style.dev` routes per port, published at create or on first lookup.",
  suspension: "Freestyle pause keeps memory; start resumes the same processes.",
  renewal: "Sets `ttlSeconds` to the VM's age plus the requested window.",
  reopening: "References hold the VM id and a key fingerprint, never the key.",
  snapshots:
    "Memory and disk from a running or paused VM; restore boots a new VM that resumes the captured processes.",
  streaming:
    "Detached guest jobs with polled, byte-exact stdout and stderr; PTY terminals over WebSocket.",
  termination: "Process-group signals on the detached job.",
  network: "Blocked (empty firewall), internet, and IPv4 allowlists.",
  oci: "No OCI images; images are Freestyle snapshots.",
};

// SAFETY: These keys are taken from the fixed features literal.
const featureIds = Object.keys(features) as (keyof typeof features)[];

export default defineProviderProfile({
  id: "freestyle",
  nativeVersion: "freestyle SDK 0.2.21",
  configuredEnvironment: true,
  fileNoClobber: true,
  credentialVariables: ["BEACHSIDE_FREESTYLE_API_KEY"],
  bounds: { nativeLifetimeSeconds: 900, exerciseMs: 240000, cleanupMs: 60000 },
  support: {
    id: "freestyle",
    name: "Freestyle",
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
  configure(_environment, saved) {
    return Routing.parse(saved ?? { networkPolicy: "internet", nativeLifetimeSeconds: 900 });
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
        adapter: freestyleAdapter,
        credentials: { apiKey: credentials.BEACHSIDE_FREESTYLE_API_KEY },
        config: {
          network: config.networkPolicy,
          lifecycle: { lifetimeSeconds: config.nativeLifetimeSeconds },
          preview: { access: "public", ports: [3000, 3001] },
        },
        onReference,
        onDiagnostic,
      });
  },
});
