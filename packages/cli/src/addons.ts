import { NonzeroExitError, type ExecOutput, type SandboxHandle } from "beachside";
import { z } from "zod";
import { CliError, usage, type Output } from "./output";
import { shellQuote } from "./transfer";

/**
 * Servers `create --with` installs in a sandbox. Each one joins the user's tailnet with the
 * auth key in TAILSCALE_AUTH_KEY, which only ever reaches the sandbox over a command's stdin.
 */
export const addonNames = ["rex", "herdr"] as const;

export type AddonName = (typeof addonNames)[number];

export const AddonRecord = z.strictObject({
  name: z.enum(addonNames),
  /** The tailnet device name the add-on asked for. */
  hostname: z.string().min(1),
  /**
   * `setting-up` is saved before the add-on can join the tailnet and `failed` after a failed
   * setup, so `rm` still logs its device out.
   */
  state: z.enum(["setting-up", "ready", "failed"]),
  /** How to reach it once ready: Rex's https address, or the herdr command. */
  connect: z.string().min(1).optional(),
});

export type AddonRecord = z.infer<typeof AddonRecord>;

const keyVariable = "TAILSCALE_AUTH_KEY";

/** The requested add-ons, deduplicated and in a stable order. */
export function parseAddons(values: string[]): AddonName[] {
  const names = new Set<AddonName>();

  for (const value of values.flatMap((entry) => entry.split(","))) {
    const name = value.trim();
    const known = addonNames.find((candidate) => candidate === name);

    if (!known) throw usage(`Unknown --with ${name}`, `choose from ${addonNames.join(", ")}`);
    names.add(known);
  }

  return addonNames.filter((name) => names.has(name));
}

/** The auth key, checked before anything is created. Never echoed. */
export function tailnetKey(env: Record<string, string | undefined>): string {
  const key = env[keyVariable]?.trim();

  if (!key)
    throw usage(
      `--with needs ${keyVariable}: a reusable, ephemeral, pre-approved Tailscale auth key tagged tag:beachside`,
      "see https://beachside.run/docs/cli/rex/#set-up-tailscale-once",
    );

  return key;
}

/**
 * Tailnet names: `beachside-<sandbox>`. herdr's SSH device keeps the plain name; Rex, which runs
 * its own Tailscale, takes `-rex` when both are installed, so the two devices never clash.
 */
export function addonHostname(name: AddonName, sandbox: string, all: AddonName[]): string {
  const base = `beachside-${sandbox}`;

  return name === "rex" && all.includes("herdr") ? `${base}-rex` : base;
}

type Step = { what: string; script: string; stdin?: string; deadlineSeconds?: number };

/** What a setup script printed and how it ended. */
export type ShellResult = { exitCode: number | null; stdout: string; stderr: string };

/** Runs one shell script in the sandbox; `sandboxShell` builds it from a handle. */
export type Shell = (step: Step, signal: AbortSignal) => Promise<ShellResult>;

export function sandboxShell(box: SandboxHandle<true>): Shell {
  return async (step, signal) => {
    let result: ExecOutput;

    try {
      result = await box.exec(
        {
          command: { kind: "shell", script: step.script },
          stdin: step.stdin,
          deadlineSeconds: step.deadlineSeconds ?? 300,
        },
        { signal },
      );
    } catch (cause) {
      if (!(cause instanceof NonzeroExitError)) throw cause;
      result = cause.result;
    }

    return {
      exitCode: result.exitCode,
      stdout: result.stdoutText({ full: true }),
      stderr: result.stderrText({ full: true }),
    };
  };
}

/** Run one setup script; a nonzero exit becomes an error naming the step and its stderr tail. */
async function run(shell: Shell, step: Step, signal: AbortSignal): Promise<string> {
  const result = await shell(step, signal);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim().split("\n").slice(-5).join("\n");

    throw new Error(`${step.what} failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : ""}`);
  }

  return result.stdout;
}

/** `sudo -n` unless already root, for scripts that need it. */
const asRoot = `S=; [ "$(id -u)" = 0 ] || S="sudo -n"`;

/**
 * Tailscale treats a machine whose only IPv4 address is link-local as offline and never logs in
 * (E2B: e2b-dev/runtime#3780). Give such a machine one routable host address.
 */
const routableIpv4 = [
  asRoot,
  // E2B marks its link-local address scope global, so skip 169.254.0.0/16 explicitly.
  "if command -v ip >/dev/null && ! ip -4 -o addr show scope global | grep -v ' inet 169\\.254\\.' | grep -q .; then",
  "  $S ip addr add 192.0.0.8/32 dev eth0 noprefixroute 2>/dev/null || true",
  "fi",
].join("\n");

const needsInternet =
  "the sandbox needs internet access; pass --network internet or use a provider tier that allows it";

function download(url: string, what: string): string {
  return [
    `if ! command -v curl >/dev/null; then echo "curl is not installed" >&2; exit 3; fi`,
    `curl -fsSL ${shellQuote(url)} | sh >/dev/null || { echo "could not install ${what}: ${needsInternet}" >&2; exit 3; }`,
  ].join("\n");
}

const readyLine = "tailnet https listener ready";

async function setupRex(
  shell: Shell,
  hostname: string,
  key: string,
  signal: AbortSignal,
  out: Output,
): Promise<AddonRecord> {
  const host = shellQuote(hostname);

  out.note(`rex: installing in ${hostname}`);
  await run(
    shell,
    {
      what: "Installing Rex",
      script: `command -v rex >/dev/null || { ${download("https://pkgs.superlogical.com/rex/install.sh", "Rex")}\n}`,
    },
    signal,
  );

  // Old tsnet state, such as one baked into an image, makes Rex ignore the auth key and would
  // share another sandbox's identity. `create` refuses --snapshot with --with, so a restored
  // sandbox never reaches this.
  await run(
    shell,
    {
      what: "Starting the Rex server",
      script: `rm -rf "$HOME/.local/state/rex/tsnet"\nrex server start --tailscale-hostname ${host}`,
    },
    signal,
  );

  // A detached `rex server start` cannot read stdin, so the key goes to `tailscale on`.
  await run(
    shell,
    {
      what: "Joining the tailnet",
      script: `rex server tailscale on --hostname ${host} --auth-key-file - --allow-tailnet-members`,
      stdin: key,
    },
    signal,
  );

  out.note(`rex: waiting for its https certificate (up to a minute)`);
  const url = await rexAddress(shell, signal);

  // The first request waits on certificate issuance, longer than Rex's own handshake timeout.
  try {
    await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
  } catch {
    // This machine may not be on the tailnet; Rex still works from the user's Mac.
  }

  return { name: "rex", hostname, state: "ready", connect: url };
}

/** Poll Rex's log for the tailnet listener and return its https address. */
async function rexAddress(shell: Shell, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + 150_000;

  while (Date.now() < deadline) {
    const logs = await run(
      shell,
      { what: "Reading the Rex server log", script: "rex server logs 2>&1 | tail -n 200 || true" },
      signal,
    );

    const line = logs.split("\n").find((entry) => entry.includes(readyLine));
    const url = line?.match(/url=(https:\/\/\S+)/)?.[1];

    if (url) return url.replace(/[",]+$/, "");

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error(
    `Rex did not report "${readyLine}" within 150s; check the key and \`beachside exec <name> -- rex server logs\``,
  );
}

/** `tailscale status --json` text, reduced to this device's MagicDNS name. */
const TailscaleStatus = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text);
    } catch {
      ctx.addIssue({ code: "custom", message: "not JSON" });

      return z.NEVER;
    }
  })
  .pipe(z.object({ Self: z.object({ DNSName: z.string() }) }));

async function setupHerdr(
  shell: Shell,
  hostname: string,
  key: string,
  signal: AbortSignal,
  out: Output,
): Promise<AddonRecord> {
  const state = `"$HOME/.local/state/beachside/tailscale"`;
  const socket = `--socket=${state}/tailscaled.sock`;

  out.note(`herdr: putting ${hostname} on your tailnet with Tailscale SSH`);
  await run(
    shell,
    {
      what: "Installing Tailscale",
      script: [
        asRoot,
        `command -v tailscaled >/dev/null || { ${download("https://tailscale.com/install.sh", "Tailscale")}\n}`,
        // The install script may enable the system service; this sandbox runs its own userspace one.
        "$S systemctl disable --now tailscaled >/dev/null 2>&1 || true",
      ].join("\n"),
    },
    signal,
  );

  await run(
    shell,
    {
      what: "Starting tailscaled",
      script: [
        asRoot,
        `mkdir -p ${state}`,
        // --statedir is what `tailscale serve` and SSH need even with in-memory state.
        `$S setsid -f tailscaled --tun=userspace-networking --state=mem: --statedir=${state} ${socket} </dev/null >${state}/tailscaled.log 2>&1`,
        `for _ in $(seq 1 50); do [ -S ${state}/tailscaled.sock ] && exit 0; sleep 0.2; done`,
        `echo "tailscaled did not start; see ${state}/tailscaled.log" >&2; exit 1`,
      ].join("\n"),
    },
    signal,
  );

  await run(
    shell,
    {
      what: "Joining the tailnet",
      script: `${asRoot}\n$S tailscale ${socket} up --auth-key=file:/dev/stdin --ssh --timeout=120s --hostname=${shellQuote(hostname)}`,
      stdin: key,
    },
    signal,
  );

  const status = await run(
    shell,
    {
      what: "Reading the tailnet name",
      script: `${asRoot}\nid -un\n$S tailscale ${socket} status --json --peers=false`,
    },
    signal,
  );

  const [user = "root", ...json] = status.split("\n");
  const parsed = TailscaleStatus.safeParse(json.join("\n"));

  const dnsName = parsed.success ? parsed.data.Self.DNSName.replace(/\.$/, "") : hostname;

  return {
    name: "herdr",
    hostname,
    state: "ready",
    connect: `herdr --remote ssh://${user}@${dnsName}`,
  };
}

/** Saves the add-ons as they stand, so an interrupted create still leaves them on record. */
export type SaveAddons = (addons: AddonRecord[]) => Promise<void>;

/**
 * Install and start each add-on in order. Each one is saved as `setting-up` before it can join
 * the tailnet and again once it is ready, so `rm` can log its device out even if this process
 * dies partway. The sandbox is kept on failure, for inspection.
 */
export async function setupAddons(
  shell: Shell,
  sandbox: string,
  names: AddonName[],
  key: string,
  signal: AbortSignal,
  out: Output,
  save: SaveAddons,
): Promise<{ addons: AddonRecord[]; failure?: CliError }> {
  const addons: AddonRecord[] = [];

  try {
    await run(shell, { what: "Checking the network", script: routableIpv4 }, signal);

    for (const name of names) {
      const hostname = addonHostname(name, sandbox, names);

      addons.push({ name, hostname, state: "setting-up" });
      await save([...addons]);
      addons[addons.length - 1] =
        name === "rex"
          ? await setupRex(shell, hostname, key, signal, out)
          : await setupHerdr(shell, hostname, key, signal, out);
      await save([...addons]);
    }

    return { addons };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    const pending = names.filter(
      (name) => !addons.some((addon) => addon.name === name && addon.state === "ready"),
    );

    for (const [index, addon] of addons.entries())
      if (addon.state === "setting-up") addons[index] = { ...addon, state: "failed" };

    try {
      await save([...addons]);
    } catch {
      // The `setting-up` entry already on record still lets `rm` log the device out.
    }

    return {
      addons,
      failure: new CliError(
        "PARTIAL",
        `Created ${sandbox}, but setting up ${pending.join(", ")} failed: ${message}`,
        `inspect it with \`beachside exec ${sandbox} -- …\`, or remove it with \`beachside rm ${sandbox}\``,
        { sandbox },
        "partial",
      ),
    };
  }
}

/** The script that logs each add-on's device out of the tailnet. */
const logoutScripts: Record<AddonName, string> = {
  // `logout` directly: after `off`, Rex keeps the saved login and the device lingers offline.
  rex: "rex server tailscale logout",
  herdr: `${asRoot}\n$S tailscale --socket="$HOME/.local/state/beachside/tailscale/tailscaled.sock" logout`,
};

/**
 * Log each add-on's device out before its sandbox goes away, so it leaves the tailnet at once
 * instead of lingering offline and holding its name. Best effort.
 */
export async function teardownAddons(
  shell: Shell,
  addons: AddonRecord[],
  signal: AbortSignal,
): Promise<void> {
  for (const addon of addons) {
    try {
      await shell(
        {
          what: `Logging ${addon.name} out`,
          script: logoutScripts[addon.name],
          deadlineSeconds: 30,
        },
        signal,
      );
    } catch {
      // Ephemeral devices leave the tailnet on their own once the sandbox is gone.
    }
  }
}

/** One line per add-on for human output. */
export function addonLines(addons: AddonRecord[]): string[] {
  return addons.map((addon) => {
    const name = addon.name.padEnd(10);

    if (addon.state !== "ready")
      return `${name}setup ${addon.state === "failed" ? "failed" : "unfinished"} (${addon.hostname})`;

    return addon.name === "rex"
      ? `${name}${addon.connect}  (in Rex: Add Remote Host…)`
      : `${name}${addon.connect}`;
  });
}
