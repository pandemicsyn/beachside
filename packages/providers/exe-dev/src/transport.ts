import { AdapterError, type AdapterErrorCode } from "@beachside/adapter";
import {
  ExeAPIError,
  ExeNetworkError,
  ExeProtocolError,
  exedev,
  SSHStreamError,
  type ExedevClient,
} from "@exedev/sdk";

/** Fixed exe.dev API origin; it is not a project-controlled setting. */
export const EXE_DEV_API = "https://exe.dev";

/** Largest lobby (non-`ssh`) response body the adapter accepts. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Request body bound of `POST /exec` (64 KB). Every guest command, including its encoded
 * input, must fit in one body.
 */
export const MAX_REQUEST_BYTES = 64 * 1024;

const codes = new Map<number, AdapterErrorCode>([
  [400, "INVALID_ARGUMENT"],
  [401, "UNAUTHENTICATED"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [405, "INVALID_ARGUMENT"],
  [409, "CONFLICT"],
  [413, "CAPACITY"],
  [422, "INVALID_ARGUMENT"],
  [429, "RATE_LIMIT"],
  [503, "UNAVAILABLE"],
  [504, "TIMEOUT"],
]);

/**
 * HTTP statuses that mean exe.dev refused the command before any effect: a malformed or
 * unauthorized request, an unknown command, an oversized body, a name conflict or rate
 * limiting. exe.dev documents 422 as "the command ran but returned a non-zero exit code", so
 * it is not proof of no effect and stays unknown, like a 5xx or 504.
 */
const definitive = new Set([400, 401, 403, 404, 405, 409, 413, 429]);

/** The fetch signature the adapter accepts and hands to the SDK. */
export type NativeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A request the adapter's fetch refused; it has no `code`, so it never reads as transient. */
export class FetchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchRefused";
  }
}

export type NativeFailure = {
  /** HTTP status, or undefined when no response arrived. */
  status?: number;
  error: AdapterError;
};

function clean(text: string, secrets: readonly string[]): string {
  let value = text;

  for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[redacted]");

  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/exe[01]\.[A-Za-z0-9_.-]+/g, "[redacted]")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, 300);
}

/** Normalize an SDK throw into a redacted AdapterError plus the native status. */
export function nativeFailure(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK and fetch throws are parsed and redacted at this boundary.
  error: unknown,
  secrets: readonly string[],
): NativeFailure {
  if (error instanceof AdapterError) return { error };

  if (error instanceof FetchRefused) return { error: new AdapterError("INTERNAL", error.message) };

  if (error instanceof ExeAPIError) {
    const code = codes.get(error.status) ?? (error.status >= 500 ? "UNAVAILABLE" : "INTERNAL");
    const detail = clean(error.message.replace(/^exe\.dev API error \(\d+\) during /, ""), secrets);

    return {
      status: error.status,
      error: new AdapterError(code, `exe.dev API ${error.status}${detail ? `: ${detail}` : ""}`),
    };
  }

  if (error instanceof ExeProtocolError)
    return { error: new AdapterError("UNAVAILABLE", "exe.dev returned an incompatible response") };

  if (error instanceof SSHStreamError)
    return {
      error: new AdapterError(
        error.code === "output_limit" ? "CAPACITY" : "UNAVAILABLE",
        error.code === "output_limit"
          ? "exe.dev command output exceeds the adapter bound"
          : "exe.dev command stream ended before its exit status arrived",
      ),
    };

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Fetch and abort failures arrive as plain Error objects at this boundary.
  const name = error instanceof Error ? error.name : "";

  if (error instanceof ExeNetworkError || name === "AbortError" || name === "TimeoutError")
    return {
      error: new AdapterError(
        name === "AbortError" || name === "TimeoutError" ? "TIMEOUT" : "UNAVAILABLE",
        "exe.dev request did not complete",
      ),
    };

  return { error: new AdapterError("UNAVAILABLE", "exe.dev request did not complete") };
}

/** True only when exe.dev answered with a refusal that proves the command had no effect. */
export function refusedBeforeEffect(failure: NativeFailure): boolean {
  return failure.status !== undefined && definitive.has(failure.status);
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

/**
 * The `fetch` handed to the official SDK for one adapter call. The SDK sends each command
 * exactly once (only its readiness probe retries, and the adapter never uses it); this
 * wrapper refuses other origins and redirects so the token stays on exe.dev, and ties every
 * request to the call's signal.
 */
/** Rate-limited requests are sent again this many times, waiting longer each time. */
export const RATE_LIMIT_RETRIES = 4;

export const RATE_LIMIT_BASE_MS = 500;

const RATE_LIMIT_MAX_WAIT_MS = 10_000;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);

      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);

    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    signal.addEventListener("abort", stop, { once: true });
  });
}

export function callFetch(base: NativeFetch, signal: AbortSignal): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);

    if (url.origin !== EXE_DEV_API || url.pathname !== "/exec")
      throw new FetchRefused("exe.dev SDK requested another endpoint");
    const signals = init?.signal ? [signal, init.signal] : [signal];
    const combined = AbortSignal.any(signals);

    // exe.dev answers 429 before it runs anything, so sending the same request again cannot
    // repeat an effect. Every other status, and every lost response, is returned as it is.
    for (let attempt = 0; ; attempt++) {
      const response = await base(input, { ...init, redirect: "error", signal: combined });

      if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return response;
      await response.body?.cancel();
      const after = Number(response.headers.get("retry-after"));
      await pause(
        Number.isFinite(after) && after > 0
          ? Math.min(after * 1000, RATE_LIMIT_MAX_WAIT_MS)
          : RATE_LIMIT_BASE_MS * 2 ** attempt,
        combined,
      );
    }
  };

  // SAFETY: the wrapper has fetch's call signature; `typeof fetch` also carries Bun's static
  // `preconnect`, which the SDK never reads.
  return wrapped as typeof fetch;
}

/** An exe.dev SDK client whose every request belongs to one adapter call. */
export function createExeClient(
  token: string,
  base: NativeFetch,
  signal: AbortSignal,
): ExedevClient {
  return exedev({ token, baseURL: EXE_DEV_API, fetch: callFetch(base, signal) });
}
