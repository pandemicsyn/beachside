---
title: Privacy
description: The SDK does not track usage. Learn about docs analytics consent and CLI telemetry.
---

**The Beachside SDK does not track your usage or send telemetry to Beachside.** Provider packages do not send product telemetry either. Of the installed Beachside tools, only the CLI collects basic usage telemetry.

## Documentation analytics

**The landing page (`/`) does not load PostHog or send analytics.** There is no analytics consent banner on the landing page.

The documentation (`/docs/*`) has a small consent bar. No analytics runs until you choose **Accept**. Ignoring the bar or choosing **Reject** keeps analytics off, including cookieless analytics. We remember your choice in local storage so you do not need to answer on every docs page.

Accepting allows PostHog to use first-party cookies and browser storage for pageviews, interaction analytics, and browser error reporting. Analytics may include page URLs, referrers, browser/device details, and persistent visitor and session identifiers.

You can change your choice through **Analytics preferences** in the docs footer. Withdrawing consent stops capture, clears this analytics instance's stored identifiers, and reloads the page. It does not erase data already sent while consent was granted. If browser storage is unavailable, your choice applies to the current page and we ask again on the next visit.

Docs cookies may remain in your browser when you return to the landing page, but no PostHog code runs there. Your docs choice is independent of CLI telemetry, which uses a separate PostHog project.

## CLI usage telemetry

CLI telemetry is enabled by default outside CI. It helps us understand which commands and providers people use, and where commands fail. Events go to a dedicated Beachside CLI PostHog project, separate from the website.

Each executed command reports its built-in command/subcommand, provider category, success/failure/interruption, fixed error category, duration bucket, CLI version, operating system, architecture, runtime major version, and whether it ran in CI or a terminal. Third-party adapters are reported as `custom`; provider information is included only when a single provider was used.

A random ID stored locally lets us recognize returning installations. It is not linked to website visitors or accounts. Person profiles and location enrichment are disabled, although PostHog receives the source IP as part of the network request.

We exclude arguments, shell commands, input/output, file paths, environment variables, credentials, profile/sandbox names and IDs, custom adapter names, raw error messages, and stack traces. Help, version, schema, completion, telemetry controls, and requests rejected before command execution send no events.

## Turn telemetry off

```sh
beachside telemetry disable                # persists across invocations
beachside telemetry status
BEACHSIDE_TELEMETRY=0 beachside providers   # disables for this invocation
```

`DO_NOT_TRACK=1` always disables collection. `BEACHSIDE_TELEMETRY=0` (or `false`) overrides saved preferences. To enable collection again, use `beachside telemetry enable` or `BEACHSIDE_TELEMETRY=1` (or `true`), unless Do Not Track is set. CI stays off unless explicitly enabled.

Preferences and the random installation ID live under `$XDG_CONFIG_HOME/beachside` (default `~/.config/beachside`). When disabled, no telemetry ID is created and no telemetry request is sent. An unreadable or invalid preference file disables collection.

A one-time notice appears on terminal stderr after the first eligible command. Telemetry delivery is best effort and does not change command results.
