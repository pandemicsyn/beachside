import { AdapterError, type AdapterErrorCode } from "@beachside/adapter";
import { Freestyle, FreestyleApiError } from "freestyle";

/** Fixed Freestyle public API origin; it is not a project-controlled setting. */
export const FREESTYLE_API = "https://api.freestyle.sh";

/** Largest native response body the adapter accepts, before decoding. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Code of the synthetic response a cancelled operation hands the SDK's background poll. The
 * poll keeps retrying ordinary fetch failures for minutes; an API error ends it at once.
 */
export const CANCELLED = "BEACHSIDE_CANCELLED";

/** 409 codes that do not prove the request was refused: the command may already have run. */
const inFlight = new Set(["VM_NON_RESPONSIVE"]);

/** Error codes that describe the background-request machinery rather than the call itself. */
const background = /^BACKGROUND_/;

const codes = new Map<number, AdapterErrorCode>([
  [400, "INVALID_ARGUMENT"],
  [401, "UNAUTHENTICATED"],
  [402, "CAPACITY"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [409, "CONFLICT"],
  [410, "NOT_FOUND"],
  [413, "CAPACITY"],
  [422, "INVALID_ARGUMENT"],
  [429, "RATE_LIMIT"],
  [503, "UNAVAILABLE"],
  [504, "TIMEOUT"],
]);

/** HTTP statuses that mean Freestyle refused the request before any effect. */
const definitive = new Set([400, 401, 402, 403, 404, 410, 413, 422, 429]);

/**
 * A request the adapter's fetch refused or stopped reading. It deliberately has no `code`
 * property: the SDK would otherwise read it as a connection failure and replay a read.
 */
export class FetchRefused extends Error {
  readonly reason: "bound" | "origin";

  constructor(reason: "bound" | "origin", message: string) {
    super(message);
    this.name = "FetchRefused";
    this.reason = reason;
  }
}

/** The fetch signature the adapter accepts and hands to the SDK. */
export type NativeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type NativeFailure = {
  /** HTTP status, or undefined when no response arrived. */
  status?: number;
  code?: string;
  error: AdapterError;
};

function clean(text: string, secrets: readonly string[]): string {
  let value = text;

  for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[redacted]");

  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, 300);
}

/** Normalize an SDK throw into a redacted AdapterError plus the native status and code. */
export function nativeFailure(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK and fetch throws are parsed and redacted at this boundary.
  error: unknown,
  secrets: readonly string[],
): NativeFailure {
  if (error instanceof AdapterError) return { error };

  if (error instanceof FetchRefused)
    return {
      error: new AdapterError(error.reason === "bound" ? "CAPACITY" : "INTERNAL", error.message),
    };

  if (error instanceof FreestyleApiError) {
    if (error.code === CANCELLED)
      return {
        code: error.code,
        error: new AdapterError("TIMEOUT", "Freestyle request was cancelled before it settled"),
      };

    const code =
      error.code === "AGENT_UNSUPPORTED"
        ? "UNSUPPORTED"
        : (codes.get(error.status) ?? (error.status >= 500 ? "UNAVAILABLE" : "INTERNAL"));

    const nativeCode = clean(error.code, secrets).slice(0, 128);
    const detail = clean(error.message, secrets);

    return {
      status: error.status,
      code: error.code,
      error: new AdapterError(
        code,
        `Freestyle API ${error.status}${nativeCode ? ` ${nativeCode}` : ""}${detail ? `: ${detail}` : ""}`,
      ),
    };
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Fetch failures arrive as plain Error objects at this boundary.
  const name = error instanceof Error ? error.name : "";

  return {
    error: new AdapterError(
      name === "AbortError" || name === "TimeoutError" ? "TIMEOUT" : "UNAVAILABLE",
      "Freestyle API request did not complete",
    ),
  };
}

/** True only when Freestyle answered with a refusal that proves the request had no effect. */
export function refusedBeforeEffect(failure: NativeFailure): boolean {
  if (failure.status === undefined || background.test(failure.code ?? "")) return false;

  if (failure.status === 409) return !inFlight.has(failure.code ?? "");

  return definitive.has(failure.status);
}

/** Buffer a response body, failing once it passes the bound. */
async function bounded(response: Response, limit: number): Promise<Response> {
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };

  // A null-body status cannot carry even an empty buffer.
  if (!response.body || [101, 204, 205, 304].includes(response.status))
    return new Response(null, init);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) break;
      length += next.value.byteLength;

      if (length > limit)
        throw new FetchRefused("bound", "Freestyle API response exceeds the adapter bound");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Response(body, init);
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

/**
 * The `fetch` handed to the official SDK for one adapter call. It sends each request exactly
 * once (the SDK itself replays only bodyless reads), refuses redirects so the API key stays on
 * the Freestyle origin, ties every request to the call's signal and bounds every body.
 *
 * The SDK backgrounds slow requests and polls their result without a cancellation hook; once
 * the call is cancelled, a poll is answered locally with an API error so the SDK stops polling.
 */
export function callFetch(
  base: NativeFetch,
  signal: AbortSignal,
  limit = MAX_RESPONSE_BYTES,
): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);

    if (url.origin !== FREESTYLE_API)
      throw new FetchRefused("origin", "Freestyle SDK requested another origin");

    if (signal.aborted && url.pathname.startsWith("/v5/background-requests/"))
      return new Response(
        JSON.stringify({ code: CANCELLED, message: "The Beachside call was cancelled" }),
        { status: 499, headers: { "content-type": "application/json" } },
      );
    const signals = init?.signal ? [signal, init.signal] : [signal];

    const response = await base(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any(signals),
    });

    return bounded(response, limit);
  };

  // SAFETY: the wrapper has fetch's call signature; `typeof fetch` also carries Bun's static
  // `preconnect`, which the SDK never reads.
  return wrapped as typeof fetch;
}

/** A Freestyle SDK client whose every request belongs to one adapter call. */
export function createFreestyleClient(
  apiKey: string,
  base: NativeFetch,
  signal: AbortSignal,
  limit = MAX_RESPONSE_BYTES,
): Freestyle {
  return new Freestyle({ apiKey, baseUrl: FREESTYLE_API, fetch: callFetch(base, signal, limit) });
}
