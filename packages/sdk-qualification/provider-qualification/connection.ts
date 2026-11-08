import type { AdapterDirectClient, AdapterRecoveryReference } from "beachside";

export type ConnectionFactory = (
  onReference: (reference: AdapterRecoveryReference) => Promise<void>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public SDK diagnostic callback boundary.
  onDiagnostic?: (error: unknown) => void,
) => Promise<AdapterDirectClient>;
