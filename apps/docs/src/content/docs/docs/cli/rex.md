---
title: Remote workspace with Rex
description: Run a Rex server inside a sandbox and open it from Rex on your Mac over Tailscale.
---

[Rex](https://www.superlogical.com/rex/docs) is a terminal workspace with a client and a server. If you run the Rex server inside a sandbox, you get a remote workspace: your sessions, tabs and blocks live in the sandbox, and you open them from Rex on your Mac. Nothing listens on a public port. Rex's built-in Tailscale puts the server on your tailnet, and only your tailnet can reach it.

:::caution[Experimental]
Rex is in beta. This recipe has been verified end to end on boxd, Freestyle, E2B (with the extra step below) and plain Linux hosts. Daytona's lower tiers block the Rex download, because their sandboxes only reach an allowlist of hosts.
:::

## What you need

- Rex beta on your Mac.
- A Tailscale tailnet with MagicDNS and HTTPS certificates turned on.
- A provider whose sandboxes can reach the internet, including Tailscale's control servers. boxd, Freestyle and E2B all work, and the examples use whichever profile is your default.

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

## Start it with one command

With the auth key in `TAILSCALE_AUTH_KEY`, one command does every step below:

```sh
beachside create --name rex --ttl 2h --with rex
```

It prints the `https://beachside-rex.<your-tailnet>.ts.net` address once Rex is ready, usually within a minute, and `beachside inspect rex` shows it again.

Behind the scenes, `--with rex` runs the same steps as the manual recipe below:

1. Creates the sandbox with `--network internet`, and refuses if `TAILSCALE_AUTH_KEY` is missing before creating anything.
2. Gives the sandbox a routable IPv4 address if it only has a link-local one, as on E2B.
3. Installs Rex with its official install script, unless `rex` is already there.
4. Clears any old Rex Tailscale state in `~/.local/state/rex/tsnet`, then runs `rex server start --tailscale-hostname beachside-<name>`.
5. Runs `rex server tailscale on --auth-key-file - --allow-tailnet-members` with the key on stdin. The key never touches the sandbox's disk, command line or env.
6. Waits up to 150 seconds for `tailnet https listener ready` in `rex server logs` and reads the address from it.
7. Makes one request to that address, so the first certificate is issued before you connect.
8. Records the address with the sandbox, for `inspect`.

`beachside rm` runs `rex server tailscale logout` before it destroys the sandbox. If a step fails, `create` exits 8 with the failed step's error and keeps the sandbox, so you can look inside with `beachside exec` or remove it.

To do it by hand, read on.

## Start a Rex server in a sandbox

Create the sandbox and install Rex:

```sh
beachside create --name rex --network internet --ttl 2h
beachside exec rex -- sh -c 'curl -fsSL https://pkgs.superlogical.com/rex/install.sh | sh'
```

boxd needs nothing more: its sandboxes have a private IPv4 address and passwordless sudo, so Rex installs and logs in as is. Set `BOXD_ORG` and `BOXD_NETWORK=internet` along with `BOXD_API_KEY` (see [configuration](/docs/cli/configuration/)).

Freestyle needs nothing more either. Its VMs block outbound traffic by default, so set `FREESTYLE_NETWORK=internet` along with `FREESTYLE_API_KEY`, or pass `--network internet` as above.

On E2B, give the sandbox a routable address first. E2B sandboxes only have a link-local IPv4 address, so Tailscale thinks the machine is offline and never logs in ([e2b-dev/runtime#3780](https://github.com/e2b-dev/runtime/issues/3780)):

```sh
beachside exec rex -- sudo ip addr add 192.0.0.8/32 dev eth0 noprefixroute
```

Start the server, then turn on Tailscale with the key sent over stdin. The key never touches the sandbox's disk, command line or env:

```sh
beachside exec rex -- rex server start --tailscale-hostname beachside-rex

printf %s "$TAILSCALE_AUTH_KEY" | beachside exec rex --stdin -- \
  rex server tailscale on \
  --hostname beachside-rex \
  --auth-key-file - \
  --allow-tailnet-members
```

It takes two steps because `rex server start` runs in the background and can't read the key from stdin. The server keeps running after `exec` returns, joins your tailnet as `beachside-rex`, and logs in within a few seconds. The first HTTPS certificate takes up to a minute. To watch it start, run `beachside exec rex -- rex server logs`. It's ready when you see `tailnet https listener ready`.

## Open it from your Mac

In Rex, open the session picker, choose **Add Remote Host…** and enter:

```text
https://beachside-rex.<your-tailnet>.ts.net
```

The Rex CLI works too:

```sh
rex -S https://beachside-rex.<your-tailnet>.ts.net ls
```

## Clean up

If you used `--with rex`, `beachside rm rex` does both steps. By hand, log Rex out of your tailnet first, then remove the sandbox:

```sh
beachside exec rex -- rex server tailscale logout
beachside rm rex
```

`logout` takes the device off your tailnet at once. Use it rather than `rex server tailscale off`, which keeps the login, so the device stays listed as offline until Tailscale's ephemeral cleanup removes it, and its name stays taken until then.

## Troubleshooting

**Rex rejects the connection (403).** A tagged device has no owner, so Rex's default owner-only access admits nobody. Start the server with `--tailscale-allow-tailnet-members`, and rely on the `tag:beachside` grant to decide who gets in. The server logs this warning when the flag is missing: `this node is tagged … owner-only access admits nobody`.

**The server waits at "needs login" or ignores the key.** Rex keeps its Tailscale state in `~/.local/state/rex/tsnet`, whatever hostname you pass. If that state exists, from an earlier start or a sign-in by link, Rex uses it and logs `Ignoring authkey`. Move that directory away before the first start with a key, and don't snapshot a sandbox after Rex has joined your tailnet.

**On E2B, the server waits at "needs login" with no error.** The sandbox only has a link-local address. Add `192.0.0.8/32` to `eth0` as shown above, before the first start.

**The first connection fails with "TLS handshake did not finish in time".** The certificate wasn't ready yet, and Rex's client gives up on the handshake after a few seconds. Wait for `tailnet https listener ready`, or warm the endpoint once with `curl -s -m 60 -o /dev/null https://beachside-rex.<your-tailnet>.ts.net`, then connect again.

**The install script can't download Rex.** The sandbox has no internet access. Pass `--network internet`, or use a provider tier that allows it.

## Status on Rex tabs

When you run `beachside` inside Rex, each tab shows whether a command is working, done or failed. See [Status on terminal tabs](/docs/cli/#status-on-terminal-tabs).
