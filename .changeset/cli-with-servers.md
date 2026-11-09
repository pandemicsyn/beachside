---
"@beachside/cli": minor
---

`beachside create --with rex|herdr` installs a server in the new sandbox and puts it on your Tailscale tailnet, with the auth key from `TAILSCALE_AUTH_KEY` sent only over stdin.

- **Rex:** runs on Rex's own Tailscale, and `create` waits for its HTTPS address.
- **herdr:** gets a Tailscale SSH device to attach to with `herdr --remote`.
- **Connection details:** `create` and `inspect` print how to connect, the sandbox record keeps the add-ons, and `rm` logs each device out of the tailnet.
- **Network:** `--with` implies `--network internet`.

A create the provider rejects with no image set now keeps the provider's own message, rather than always saying an image is needed. Previously an E2B lifetime over its cap read as "needs an image".
