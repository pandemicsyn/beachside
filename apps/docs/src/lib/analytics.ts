import type { PostHog, PostHogConfig } from "posthog-js";
import project from "./analytics-project.json";

export const consentKey = "beachside-docs-analytics-consent-v1";

export type Consent = "accepted" | "rejected" | "pending";

// Public ingestion settings belong in the build; overrides support isolated tests.
const key = import.meta.env.PUBLIC_POSTHOG_KEY || project.key;

const host = import.meta.env.PUBLIC_POSTHOG_HOST || project.host;

const persistenceName = "beachside_docs";

export const analyticsConfigured = Boolean(key && host);

let client: PostHog | undefined;

let starting: Promise<void> | undefined;

let allowed = false;

export function readConsent(): Consent {
  try {
    const choice = localStorage.getItem(consentKey);

    return choice === "accepted" || choice === "rejected" ? choice : "pending";
  } catch {
    return "pending";
  }
}

export function saveConsent(choice: Exclude<Consent, "pending">): void {
  try {
    localStorage.setItem(consentKey, choice);
  } catch {
    // Consent still applies to this page; ask again next visit if storage is unavailable.
  }
}

export async function startAnalytics(): Promise<void> {
  if (!key || !host || !(location.pathname === "/docs" || location.pathname.startsWith("/docs/")))
    return;
  allowed = true;

  if (starting) return starting;
  starting = import("posthog-js")
    .then(({ default: posthog }) => {
      // A rejection while the library loads must win over the earlier acceptance.
      if (!allowed) {
        starting = undefined;

        return;
      }

      const config: Partial<PostHogConfig> = {
        api_host: host,
        ui_host: project.uiHost,
        // No cookieless fallback: pending and rejected visitors send nothing.
        persistence_name: persistenceName,
        cross_subdomain_cookie: false,
        opt_out_capturing_by_default: true,
        opt_out_persistence_by_default: true,
        request_batching: false,
        autocapture: true,
        capture_pageview: true,
        capture_pageleave: true,
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false,
        },
        disable_session_recording: true,
        enable_recording_console_log: false,
        disable_surveys: true,
        disable_conversations: true,
        disable_product_tours: true,
        before_send: (event) => (allowed ? event : null),
        loaded: (instance) => {
          if (allowed) instance.opt_in_capturing();
        },
      };

      client = posthog.init(key, config, persistenceName);
    })
    .catch(() => {
      starting = undefined;
    });

  return starting;
}

/** Stop capture and remove analytics persistence before reloading an opted-in page. */
export function stopAnalytics(): boolean {
  allowed = false;

  if (client) {
    client.opt_out_capturing();
    client.set_config({ disable_persistence: true, autocapture: false, capture_exceptions: false });
  }

  try {
    // The SDK's persistence toggle leaves its per-tab window ID behind.
    for (const storage of [localStorage, sessionStorage]) {
      for (const name of Object.keys(storage)) {
        if (name.startsWith(`ph_${persistenceName}`)) storage.removeItem(name);
      }
    }
  } catch {
    // Storage can be blocked; capture is already disabled above.
  }

  return Boolean(client);
}
