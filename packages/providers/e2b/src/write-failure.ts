import { z } from "zod";

const ErrorName = z.enum([
  "Error",
  "TypeError",
  "AbortError",
  "SandboxError",
  "TimeoutError",
  "InvalidArgumentError",
  "NotEnoughSpaceError",
  "AuthenticationError",
  "FileNotFoundError",
  "SandboxNotFoundError",
  "RateLimitError",
  "ServiceBusyError",
  "UnknownError",
]);

export const WriteFailure = z.strictObject({
  stage: z.enum(["connect", "upload", "link", "unknown"]),
  errorName: ErrorName,
  httpStatus: z.number().int().min(100).max(599).optional(),
});

type Failure = z.infer<typeof WriteFailure>;

/** Contains classification only; native messages, causes and IDs never enter recovery. */
export class E2BWriteFailure extends Error {
  /**
   * envd answered that it could not open the destination for writing, so no bytes were written.
   * Overwriting a file directly in a sticky directory such as /tmp fails this way: envd runs as
   * root, first chowns the existing file to the sandbox user, then reopens it with O_CREAT, which
   * fs.protected_regular refuses for a file owned by someone other than root or the directory
   * owner.
   */
  readonly openDenied: boolean;

  constructor(
    readonly failure: Failure,
    openDenied = false,
  ) {
    super("E2B native file write failed");
    this.name = "E2BWriteFailure";
    this.openDenied = openDenied;
  }
}

// envd's upload handler wraps the open(2) error as "error opening file: open <path>: <errno>".
const OPEN_DENIED = /error opening file: open .*: permission denied/;

/** True only for envd's definite "could not open the destination" answer; reads the message, never keeps it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native exceptions cross this boundary and only a boolean leaves it.
export function isOpenDenied(error: unknown, status?: number): boolean {
  const nativeStatus =
    error instanceof Error && "statusCode" in error ? error.statusCode : undefined;

  return (
    (status ?? nativeStatus) === 500 && error instanceof Error && OPEN_DENIED.test(error.message)
  );
}

// oxlint-disable anti-slop/no-unknown-parameters -- Native exceptions cross this boundary and only allowlisted classification is retained.
export function classifyWriteFailure(
  error: unknown,
  stage: Failure["stage"],
  status?: number,
): Failure {
  if (error instanceof E2BWriteFailure) return WriteFailure.parse(error.failure);
  const name = ErrorName.safeParse(error instanceof Error ? error.name : undefined);

  const nativeStatus =
    error instanceof Error && "statusCode" in error ? error.statusCode : undefined;

  const httpStatus = z
    .number()
    .int()
    .min(100)
    .max(599)
    .safeParse(status ?? nativeStatus);

  const failure: Failure = { stage, errorName: name.success ? name.data : "UnknownError" };

  if (httpStatus.success) failure.httpStatus = httpStatus.data;

  return failure;
}

export function writeFailureReason(reason: string, failure?: Failure): string {
  if (!failure) return reason;

  return `${reason}; native write failure: stage=${failure.stage}, error=${failure.errorName}, httpStatus=${failure.httpStatus ?? "unavailable"}`;
}

export type StreamStep = "upload" | "verify" | "publish";

/** Names the streamed-write step that failed and its classification, never the native message. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native exceptions cross this boundary and only allowlisted classification is retained.
export function streamFailureReason(error: unknown, step: StreamStep): string {
  const { errorName, httpStatus } = classifyWriteFailure(error, "unknown");

  return `E2B stream completion could not be confirmed; failed step=${step}, error=${errorName}, httpStatus=${httpStatus ?? "unavailable"}`;
}
