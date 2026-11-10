import { AdapterError, type AdapterErrorCode, type Json } from "@beachside/adapter";
import type { Sandbox } from "disk";
import { z } from "zod";

import type { NativeFetch } from "./regions";

export { REGION_NAMES, REGIONS, type NativeFetch, type Region } from "./regions";

/** Largest control-plane response body the adapter accepts, before decoding. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** A refused or unreadable call, with the native status and code when Archil answered. */
export type NativeFailure = {
  /** HTTP status, or undefined when no response arrived. */
  status?: number;
  code?: string;
  error: AdapterError;
};

/**
 * A control-plane call that did not return success. It deliberately carries no transient
 * shape the official SDK would retry: SDK helpers only read through this client.
 */
export class ArchilCallError extends Error {
  readonly failure: NativeFailure;

  constructor(failure: NativeFailure) {
    super(failure.error.message);
    this.name = "ArchilCallError";
    this.failure = failure;
  }
}

const codes = new Map<number, AdapterErrorCode>([
  [400, "INVALID_ARGUMENT"],
  [401, "UNAUTHENTICATED"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [409, "CONFLICT"],
  [413, "CAPACITY"],
  [422, "INVALID_ARGUMENT"],
  [429, "RATE_LIMIT"],
  [503, "UNAVAILABLE"],
  [504, "TIMEOUT"],
]);

/** Plan and quota refusals that name a capability the account lacks. */
const planCodes = new Set([
  "sandbox_network_plan_required",
  "sandbox_ttl_limit_exceeded",
  "allowance_insufficient",
]);

/** 503 codes Archil documents as "retry": the request did nothing. */
const refused503 = new Set(["no_capacity", "runtime_retryable", "not_enabled"]);

/** HTTP statuses that prove Archil refused the request before any effect. */
const definitive = new Set([400, 401, 403, 404, 409, 413, 422, 429]);

const Envelope = z.object({
  success: z.boolean().optional(),
  data: z.json().optional(),
  error: z.string().max(4096).optional(),
  code: z.string().max(256).optional(),
  nextCursor: z.string().max(4096).optional(),
});

function clean(text: string, secrets: readonly string[]): string {
  let value = text;

  for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[redacted]");

  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/key-[A-Za-z0-9_-]+/g, "key-[redacted]")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, 300);
}

/** The official SDK's API error, read structurally: the pinned SDK's class is not re-exported. */
const SdkError = z.object({
  name: z.literal("ArchilApiError"),
  status: z.number().int(),
  code: z.string().max(256).optional(),
  message: z.string().max(4096),
});

const ErrorName = z.object({ name: z.string().max(128) });

/** True only when Archil answered with a refusal that proves the request had no effect. */
export function refusedBeforeEffect(failure: NativeFailure): boolean {
  if (failure.status === undefined) return false;

  if (failure.status === 503) return refused503.has(failure.code ?? "");

  return definitive.has(failure.status);
}

/** Normalize any throw at the native boundary into a redacted failure. */
export function nativeFailure(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Fetch, SDK and helper throws are normalized at this boundary.
  error: unknown,
  secrets: readonly string[],
): NativeFailure {
  if (error instanceof ArchilCallError) return error.failure;

  if (error instanceof AdapterError) return { error };

  // The official SDK's ArchilApiError carries the control plane's status and code.
  const sdk = SdkError.safeParse(error);

  if (sdk.success)
    return failureFor(sdk.data.status, sdk.data.code ?? "", sdk.data.message, secrets);

  const name = ErrorName.safeParse(error);

  return {
    error: new AdapterError(
      name.success && (name.data.name === "AbortError" || name.data.name === "TimeoutError")
        ? "TIMEOUT"
        : "UNAVAILABLE",
      "Archil request did not complete",
    ),
  };
}

function failureFor(
  status: number,
  nativeCode: string,
  message: string,
  secrets: readonly string[],
): NativeFailure {
  const code: AdapterErrorCode = planCodes.has(nativeCode)
    ? "UNSUPPORTED"
    : (codes.get(status) ?? (status >= 500 ? "UNAVAILABLE" : "INTERNAL"));

  const label = clean(nativeCode, secrets).slice(0, 128);
  const detail = clean(message, secrets);

  return {
    status,
    code: nativeCode || undefined,
    error: new AdapterError(
      code,
      `Archil API ${status}${label ? ` ${label}` : ""}${detail ? `: ${detail}` : ""}${
        nativeCode === "sandbox_network_plan_required"
          ? "; on the Free plan, use network archil-managed"
          : ""
      }`,
    ),
  };
}

/** Buffer a response body, failing once it passes the bound. */
async function bounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) break;
      length += next.value.byteLength;

      if (length > limit)
        throw new ArchilCallError({
          error: new AdapterError("CAPACITY", "Archil API response exceeds the adapter bound"),
        });
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

  return body;
}

export type CallInit = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

/** One control-plane origin, one API key, one attempt per call. */
export type Control = {
  readonly baseUrl: string;
  readonly secrets: readonly string[];
  /** Send one request and return the envelope's `data`; non-success throws ArchilCallError. */
  call(
    method: string,
    path: string,
    init: CallInit,
    signal: AbortSignal,
  ): Promise<Json | undefined>;
  /** As `call`, with the HTTP status, for answers whose meaning depends on it (201 vs 200). */
  callWithStatus(
    method: string,
    path: string,
    init: CallInit,
    signal: AbortSignal,
  ): Promise<{ status: number; data: Json | undefined }>;
  /** The `ApiClient` the official SDK's `Sandbox` uses, bound to one signal. */
  sdkClient(signal: AbortSignal): NativeClient;
};

type SdkResult = { data?: unknown; error?: unknown; response: Response };

type SdkInit = {
  params?: {
    path?: Record<string, string | number>;
    query?: Record<string, string | number | boolean | undefined>;
  };
  body?: unknown;
};

type SdkMethod = (path: string, init?: SdkInit) => Promise<SdkResult>;

/** Structural copy of the SDK's internal `ApiClient`; the SDK only ever calls these members. */
/** Any client value, before it is presented to the SDK under its own type. */
type OpaqueClient = object;

/** The SDK's own client type, which it does not export by name. */
export type NativeClient = ConstructorParameters<typeof Sandbox>[1];

export type SdkApiClient = {
  GET: SdkMethod;
  PUT: SdkMethod;
  POST: SdkMethod;
  DELETE: SdkMethod;
  PATCH: SdkMethod;
  raw(method: string, url: string): Promise<Response>;
};

function buildPath(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];

    if (value === undefined)
      throw new AdapterError("INTERNAL", `Missing Archil path parameter ${name}`);

    return encodeURIComponent(String(value));
  });
}

function buildQuery(query: CallInit["query"] = {}): string {
  const parts: string[] = [];

  for (const [name, value] of Object.entries(query))
    if (value !== undefined)
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);

  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * The adapter's control-plane client. The official SDK's own client pools connections through
 * `undici`, which fails under Bun, takes no `fetch`, and retries pause, stop, resume, delete
 * and timeout calls on 5xx or thrown errors. This one sends each request exactly once with the
 * caller's signal, refuses redirects so the API key stays on the Archil origin, and bounds
 * every body. SDK `Sandbox` objects built on `sdkClient` reuse it for process connections.
 */
export function createControl(options: {
  apiKey: string;
  baseUrl: string;
  fetch: NativeFetch;
  limit?: number;
}): Control {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const origin = new URL(baseUrl).origin;
  const secrets = [options.apiKey];
  const limit = options.limit ?? MAX_RESPONSE_BYTES;

  const send = async (
    method: string,
    path: string,
    init: CallInit,
    signal: AbortSignal,
  ): Promise<{ response: Response; body: Uint8Array }> => {
    const url = `${baseUrl}${path}${buildQuery(init.query)}`;

    if (new URL(url).origin !== origin)
      throw new ArchilCallError({
        error: new AdapterError("INTERNAL", "Archil request left the configured origin"),
      });

    const headers = new Headers({
      Authorization: `Bearer ${options.apiKey}`,
      Accept: "application/json",
      "User-Agent": "beachside-archil",
    });

    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;

    try {
      response = await options.fetch(url, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: "manual",
        signal,
      });
    } catch (error) {
      throw new ArchilCallError(nativeFailure(error, secrets));
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);

      throw new ArchilCallError({
        status: response.status,
        error: new AdapterError("UNAVAILABLE", "Archil API answered with a redirect"),
      });
    }

    try {
      return { response, body: await bounded(response, limit) };
    } catch (error) {
      throw error instanceof ArchilCallError
        ? error
        : new ArchilCallError(nativeFailure(error, secrets));
    }
  };

  const decode = (response: Response, body: Uint8Array) => {
    const text = new TextDecoder().decode(body);
    let parsed: unknown;

    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    const envelope = Envelope.safeParse(parsed);

    if (!response.ok || !envelope.success || envelope.data.success === false) {
      const message = envelope.success
        ? (envelope.data.error ?? `HTTP ${response.status}`)
        : text.slice(0, 300);

      return {
        ok: false as const,
        failure: failureFor(
          response.ok ? 502 : response.status,
          envelope.success ? (envelope.data.code ?? "") : "",
          message || `HTTP ${response.status}`,
          secrets,
        ),
      };
    }

    return { ok: true as const, data: envelope.data.data, envelope: parsed };
  };

  const callWithStatus: Control["callWithStatus"] = async (method, path, init, signal) => {
    const { response, body } = await send(method, path, init, signal);

    if (response.status === 204) return { status: 204, data: undefined };
    const result = decode(response, body);

    if (!result.ok) throw new ArchilCallError(result.failure);

    return { status: response.status, data: result.data };
  };

  const call: Control["call"] = async (method, path, init, signal) =>
    (await callWithStatus(method, path, init, signal)).data;

  const sdkClient = (signal: AbortSignal): NativeClient => {
    const method =
      (name: string): SdkMethod =>
      async (path, init = {}) => {
        let sent;

        try {
          sent = await send(
            name,
            buildPath(path, init.params?.path),
            { query: init.params?.query, body: init.body },
            signal,
          );
        } catch (error) {
          // The SDK retries any throw from a connection-token request; the adapter answers with
          // a definitive refusal so nothing replays behind its back.
          const failure = nativeFailure(error, secrets);

          return {
            error: { success: false, error: failure.error.message, code: "beachside_transport" },
            response: new Response(null, { status: 499 }),
          };
        }

        if (sent.response.status === 204) return { data: undefined, response: sent.response };
        const decoded = decode(sent.response, sent.body);

        return decoded.ok
          ? { data: decoded.envelope, response: sent.response }
          : {
              error: {
                success: false,
                error: decoded.failure.error.message,
                code: decoded.failure.code,
              },
              // 5xx would make the SDK retry; it only ever sees a non-transient status.
              response: new Response(null, {
                status: sent.response.status >= 500 ? 499 : sent.response.status,
              }),
            };
      };

    const client: SdkApiClient = {
      GET: method("GET"),
      PUT: method("PUT"),
      POST: method("POST"),
      DELETE: method("DELETE"),
      PATCH: method("PATCH"),
      async raw() {
        throw new AdapterError("UNSUPPORTED", "Archil object storage is not used by this adapter");
      },
    };

    // oxlint-disable-next-line anti-slop/no-known-value-widening -- The SDK's client type is reached only through this opaque step.
    const opaque: OpaqueClient = client;

    // SAFETY: `client` implements every member of the SDK's `ApiClient` with the same runtime
    // contract; the SDK's generic path-typed signatures cannot be named outside the SDK.
    return opaque as NativeClient;
  };

  return { baseUrl, secrets, call, callWithStatus, sdkClient };
}
