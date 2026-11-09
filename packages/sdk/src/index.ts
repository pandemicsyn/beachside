import { connectDirect } from "./adapter-direct";

export type {
  StartProcessInput,
  ProcessOutput,
  ProcessOutputBytes,
  ProcessOutputFormat,
  ProcessChunk,
  ProcessExit,
  ProcessStatus,
  ProcessTermination,
  ProcessHandle,
  ProcessReference,
  ProcessSignal,
  TerminalDimensions,
  StartTerminalInput,
  TerminalHandle,
  ProcessFailure,
  ExecOptions,
} from "./processes";

export {
  AdapterDirectClient,
  AdapterSandbox,
  AdapterOperation,
  PreparedAdapterAttempt,
  ADAPTER_CONTRACT_VERSION,
} from "./adapter-direct";

export type {
  AdapterRecoveryReference,
  AdapterConnectOptions,
  DirectConnectOptions,
  ConnectOptions,
  CloseOptions,
  AdapterCapabilities,
  RecoveredOperation,
  AdvancedOperationResult,
  AdvancedOperationKind,
  AdvancedIdentity,
  AdvancedObservation,
  SandboxInfo,
} from "./adapter-direct";

export const Beachside = { connect: connectDirect };

export {
  Image,
  outputText,
  BeachsideError,
  UnsupportedFeatureError,
  OutcomeUnknownError,
  WaitAbortedError,
  NonzeroExitError,
  NoExitCodeError,
} from "./resource";

export type {
  ImageInput,
  PreparedImage,
  ImageBuildResult,
  CreateInput,
  NetworkPolicy,
  ExecInput,
  ExecStdinStream,
  ExecOutput,
  OutputPreview,
  DirectBeachsideClient,
  DirectSandboxHandle,
  SandboxHandle,
  SnapshotHandle,
  ImageHandle,
  VolumeHandle,
  ReadOptions,
  OperationHandle,
  RecoveryReference,
  BeachsideClient,
} from "./resource";

export {
  ResourceReference,
  ResourceKind,
  validateResourceReference,
  assertResourceScope,
  assertResourceIdentity,
  SnapshotRequest,
  SnapshotRequirements,
  Preserve,
} from "@beachside/adapter";

export type {
  Support,
  Capabilities,
  DirectCapabilities,
  OperationOutcome,
  SnapshotPlan,
  SnapshotProfile,
  SandboxState,
  SandboxReference,
  SuspendResult,
  ResumeResult,
  RenewRequest,
  RenewResult,
  Preview,
  Fact,
  Deadline,
  ResourceMinimums,
  SandboxResources,
  CreatePlan,
} from "@beachside/adapter";

export { AdapterSnapshot, AdapterVolume, AdapterImage } from "./resources";

export type {
  SnapshotResult,
  WaitOptions,
  RestoreInput,
  SandboxList,
  SandboxListEntry,
  SandboxListInput,
  SnapshotListInput,
} from "./resources";

export {
  MountSpec,
  SnapshotInfo,
  ImageInfo,
  VolumeInfo,
  RestoreRequest,
  VolumeCreateInput,
  ArtifactDeletionResult,
} from "@beachside/adapter";

export type {
  MountCapabilities,
  VolumeCapabilities,
  RestoreCapabilities,
} from "@beachside/adapter";

export { diagnosticContext } from "./observability";

export type { ObservabilityOptions, DiagnosticContext } from "./observability";

export { FilesystemError } from "./file-transfer";

export type {
  FileReadOptions,
  FileWriteOptions,
  FileStreamOptions,
  FileStreamWriteOptions,
  TransferPolicy,
} from "./file-transfer";

export type { FileEntry, DirectoryResult, FileStat } from "@beachside/adapter";

export type {
  WalkFilesOptions,
  WalkFileEntry,
  ReadTextLinesOptions,
} from "./filesystem-extensions";

export { createProcessTail, readProcessLines } from "./process-output";

export type {
  ProcessTail,
  ProcessTailOptions,
  ProcessLine,
  ProcessLineOptions,
} from "./process-output";

export { SandboxCleanupError } from "./scoped-sandbox";

export { Setup, SetupDefinition, SetupFailedError } from "./setup";

export type {
  SetupParallel,
  SetupStep,
  SetupStepOptions,
  SetupInput,
  SetupDefinitionInput,
  SetupOutput,
  SetupEvent,
  SetupPhase,
  SetupStepRef,
  SetupReport,
  SetupStepReport,
  SetupRunOptions,
  SetupCreateOptions,
} from "./setup";

export type { RunSetupOptions } from "./setup-flow";

export type { SandboxScopeOptions, SandboxScopeCallbackOutcome } from "./scoped-sandbox";
