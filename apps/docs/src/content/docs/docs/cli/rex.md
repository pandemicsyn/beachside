---
title: Remote workspace with Rex
description: Run a Rex server inside a sandbox and open it from Rex on your Mac over Tailscale.
---

[Rex](https://www.superlogical.com/rex/docs) is a terminal workspace with a client and a server. If you run the Rex server inside a sandbox, you get a remote workspace: your sessions, tabs and blocks live in the sandbox, and you open them from Rex on your Mac. Nothing listens on a public port. Rex's built-in Tailscale puts the server on your tailnet, and only your tailnet can reach it.

:::caution[Experimental]
Rex is in beta, and this recipe has only been tried on E2B and on plain Linux hosts. Daytona's lower tiers block the Rex download, because their sandboxes only reach an allowlist of hosts.
:::

## What you need

- Rex beta on your Mac.
- A Tailscale tailnet with MagicDNS and HTTPS certificates turned on.
- A provider whose sandboxes can reach the internet. The examples use E2B.

## Set up Tailscale once

**1. Add a tag for sandboxes.** In the [access controls](https://login.tailscale.com/admin/acls), let admins own `tag:beachside`, and let members of your tailnet reach it on port 443:

```json
{
  "tagOwners": {
    "tag:beachside": ["autogroup:admin"]
  },
  "grants": [{ "src": ["autogroup:member"], "dst": ["tag:beachside"], "ip": ["443"] }]
}
```

Merge this into your existing policy. Don't add any grant with `tag:beachside` as the source, so a sandbox can't reach the rest of your tailnet.

**2. Create an auth key.** Under [Settings → Keys](https://login.tailscale.com/admin/settings/keys), choose **Generate auth key** with these settings:

| Setting      | Value           | Why                                                                    |
| ------------ | --------------- | ---------------------------------------------------------------------- |
| Reusable     | On              | One key serves every sandbox, so you don't need a new one each time    |
| Ephemeral    | On              | Tailscale removes the sandbox from your tailnet once it goes offline   |
| Pre-approved | On              | Sandboxes join without manual approval                                 |
| Tags         | `tag:beachside` | Applies the access rules above and turns off key expiry for the device |
| Expiration   | Up to 90 days   | The key itself still expires, so rotate it                             |

Keep the key out of your shell history. For example, put it in an env file that only you can read and export it as `TAILSCALE_AUTH_KEY`.

## Start a Rex server in a sandbox

Create the sandbox and install Rex:

```sh
beachside create --name rex --network internet --ttl 2h
beachside exec rex -- sh -c 'curl -fsSL https://pkgs.superlogical.com/rex/install.sh | sh'
```

Send the key over stdin, so it never shows up in a command line or in the sandbox's env:

```sh
printf %s "$TAILSCALE_AUTH_KEY" | beachside exec rex --stdin -- \
  sh -c 'umask 077 && mkdir -p ~/.beachside && cat > ~/.beachside/ts.key'
```

Start the server:

```sh
beachside exec rex -- rex server start \
  --tailscale \
  --tailscale-hostname rex-sandbox \
  --tailscale-auth-key-file ~/.beachside/ts.key \
  --tailscale-allow-tailnet-members
```

The server keeps running after `exec` returns. It joins your tailnet as `rex-sandbox`, and the first HTTPS certificate takes up to a minute. To watch it start, run `beachside exec rex -- rex server logs`. It's ready when you see `tailnet https listener ready`.

## Open it from your Mac

In Rex, open the session picker, choose **Add Remote Host…** and enter:

```text
https://rex-sandbox.<your-tailnet>.ts.net
```

The Rex CLI works too:

```sh
rex -S https://rex-sandbox.<your-tailnet>.ts.net ls
```

## Clean up

```sh
beachside rm rex
```

Because the key is ephemeral, the device disappears from your tailnet shortly after the sandbox is gone.

## Troubleshooting

**Rex rejects the connection (403).** A tagged device has no owner, so Rex's default owner-only access admits nobody. Start the server with `--tailscale-allow-tailnet-members`, and rely on the `tag:beachside` grant to decide who gets in. The server logs this warning when the flag is missing: `this node is tagged … owner-only access admits nobody`.

**The server waits at "needs login" or ignores the key.** Rex keeps its Tailscale state in `~/.local/state/rex/tsnet`, whatever hostname you pass. If that state exists, from an earlier start or a sign-in by link, Rex uses it and logs `Ignoring authkey`. Move that directory away before the first start with a key, and don't snapshot a sandbox after Rex has joined your tailnet.

**The install script can't download Rex.** The sandbox has no internet access. Pass `--network internet`, or use a provider tier that allows it.

## Status on Rex tabs

When you run `beachside` inside Rex, each tab shows whether a command is working, done or failed. See [Status on terminal tabs](/docs/cli/#status-on-terminal-tabs).
