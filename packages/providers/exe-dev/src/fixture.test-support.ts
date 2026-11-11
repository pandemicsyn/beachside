import { test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "@beachside/adapter";

/**
 * Deterministic exe.dev HTTPS API stand-in behind the official SDK's `fetch` option. The real
 * SDK builds every `POST /exec` command line and parses every response; this fixture only
 * answers. `ssh <vm> <command>` runs through the local `sh` with the VM's own `$HOME`, and
 * answers in the NDJSON frame format exe.dev documents (base64 stdout/stderr, then exit_code).
 */

type FixtureVm = {
  name: string;
  account: string;
  status: string;
  image: string;
  cpu: number;
  memoryGB: number;
  tags: string[];
  comment: string;
  createdAt: string;
  /** Status polls (`ls`) before a starting VM reports `running`. */
  polls: number;
  home: string;
  share: { port: number; status: "public" | "private" };
  placement: string;
};

export type Call = { command: string; words: string[]; token: string };

const accounts = new Map([
  ["exe1.fixture-main", "main@example.com"],
  ["exe1.fixture-alt", "alt@example.com"],
]);

/**
 * Split one exe.dev command line into words: bare words, `'single'` quotes and the SDK's
 * `'"'"'` escapes, concatenated as POSIX sh would.
 */
export function words(line: string): string[] {
  const out: string[] = [];
  let word: string | undefined;
  let at = 0;

  while (at < line.length) {
    const char = line[at] ?? "";

    if (char === " ") {
      if (word !== undefined) out.push(word);
      word = undefined;
      at++;
    } else if (char === "'" || char === '"') {
      const end = line.indexOf(char, at + 1);

      if (end < 0) throw new Error("unterminated quote");
      word = (word ?? "") + line.slice(at + 1, end);
      at = end + 1;
    } else {
      word = (word ?? "") + char;
      at++;
    }
  }

  if (word !== undefined) out.push(word);

  return out;
}

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status: number, message: string): Response {
  return json(status, { error: message });
}

/** Flags `--key=value` and `--key` (true) plus positionals, after the command path. */
function parse(rest: string[]) {
  const flags = new Map<string, string[]>();
  const args: string[] = [];
  let positional = false;

  for (const word of rest) {
    if (!positional && word === "--") positional = true;
    else if (!positional && word.startsWith("--")) {
      const [key = "", value = "true"] = word.slice(2).split(/=(.*)/s);
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else args.push(word);
  }

  const flag = (key: string) => flags.get(key)?.at(-1);

  return { flags, flag, args };
}

/**
 * Tests whose simulated guest commands need Linux tools (`setsid`, `fallocate`, GNU
 * coreutils), as an exe.dev VM has. They run on Linux, as in CI, and are skipped elsewhere.
 */
export const linuxGuest = test.skipIf(process.platform !== "linux");

export function exeDevFixture() {
  const vms = new Map<string, FixtureVm>();
  const calls: Call[] = [];
  const workdir = mkdtempSync(join(tmpdir(), "beachside-exe-dev-fixture-"));
  const effects = { create: 0, destroy: 0, release: 0, ssh: 0, pause: 0, resume: 0, copy: 0 };
  let loseNextCreate = false;
  let holdNextCreate = false;
  let releaseHeld: (() => void) | undefined;
  let held: Promise<void> | undefined;
  let bootPolls = 0;
  let createFault: Response | undefined;
  let commentFault: Response | undefined;
  let sshFault: Response | "lost" | undefined;
  /** Commands that must match before the fault applies; undefined matches the next one. */
  let sshFaultMatch: RegExp | undefined;

  /** The next `rm` answers `not_found`, as for a VM this token cannot see. */
  let hideNextRm = false;

  let commandOverride:
    | ((command: string) => { exit: number; stdout?: string } | undefined)
    | undefined;

  const row = (vm: FixtureVm) => ({
    vm_name: vm.name,
    ssh_dest: `${vm.name}.exe.xyz`,
    https_url: `https://${vm.name}.exe.xyz/`,
    status: vm.status,
    region: "lax",
    region_display: "Los Angeles",
    tags: vm.tags,
    comment: vm.comment,
    created_at: vm.createdAt,
  });

  const owned = (name: string | undefined, account: string) => {
    const vm = vms.get(name ?? "");

    return vm && vm.account === account ? vm : undefined;
  };

  const poll = (vm: FixtureVm) => {
    if (vm.status === "starting" && vm.polls-- <= 0) vm.status = "running";
  };

  const newVm = (name: string, account: string, from?: FixtureVm): FixtureVm => {
    const home = join(workdir, name);
    mkdirSync(home, { recursive: true });

    if (from) Bun.spawnSync(["cp", "-a", `${from.home}/.`, home]);

    return {
      name,
      account,
      status: "starting",
      image: from?.image ?? "exeuntu",
      cpu: from?.cpu ?? 2,
      memoryGB: from?.memoryGB ?? 8,
      tags: from ? [...from.tags] : [],
      comment: from?.comment ?? "",
      createdAt: new Date().toISOString(),
      polls: bootPolls,
      home,
      share: { port: 80, status: "private" },
      placement: from?.placement ?? "default",
    };
  };

  const ssh = async (vm: FixtureVm, command: string, signal?: AbortSignal | null) => {
    if (vm.status !== "running") return error(422, `VM ${vm.name} is not running`);
    effects.ssh++;
    const fault = sshFaultMatch && !sshFaultMatch.test(command) ? undefined : sshFault;

    if (fault) {
      sshFault = undefined;
      sshFaultMatch = undefined;
    }

    if (fault && fault !== "lost") return fault;
    const override = commandOverride?.(command);
    let exit: number;
    let stdout: Uint8Array;
    let stderr: Uint8Array = new Uint8Array();

    if (override) {
      exit = override.exit;
      stdout = new TextEncoder().encode(override.stdout ?? "");
    } else {
      const run = Bun.spawn(["sh", "-c", command], {
        cwd: vm.home,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: vm.home, LANG: "C.UTF-8" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      const kill = () => run.kill("SIGKILL");
      signal?.addEventListener("abort", kill, { once: true });

      const [out, err, code] = await Promise.all([
        // Bun 1.3 can resolve Response.bytes() of a spawn pipe without its data; arrayBuffer() is reliable.
        new Response(run.stdout).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
        new Response(run.stderr).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
        run.exited,
      ]);

      signal?.removeEventListener("abort", kill);

      exit = code;
      stdout = out;
      stderr = err;
    }

    if (fault === "lost") throw new TypeError("fetch failed");

    // exe.dev streams output in many small frames; the SDK refuses frames over 1 MiB.
    const split = (name: "stdout" | "stderr", bytes: Uint8Array) =>
      Array.from({ length: Math.ceil(bytes.length / 32_768) }, (_, i) => ({
        [name]: Buffer.from(bytes.subarray(i * 32_768, (i + 1) * 32_768)).toString("base64"),
      }));

    const frames = [...split("stdout", stdout), ...split("stderr", stderr), { exit_code: exit }];

    return new Response(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n", {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.origin !== "https://exe.dev" || url.pathname !== "/exec" || init?.redirect !== "error")
      throw new Error(`Fixture refused ${url.href} without redirect: error`);
    init.signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    // The SDK sends each command line as a string body.
    const line = String(init.body ?? "");
    const parts = words(line);
    calls.push({ command: line, words: parts, token });

    if (Buffer.byteLength(line) > 64 * 1024) return error(413, "request body too large");

    const account =
      accounts.get(token) ?? (token.startsWith("exe0.") ? "signed@example.com" : undefined);

    if (!account) return error(401, "invalid token");
    const [path = "", sub = ""] = parts;
    const two = ["share", "ssh-key"].includes(path) ? `${path} ${sub}` : path;
    const { flag, flags, args } = parse(parts.slice(two.includes(" ") ? 2 : 1));

    switch (two) {
      case "whoami":
        return json(200, { email: account, ssh_keys: [] });
      case "ls": {
        const pattern = args[0];

        const list = [...vms.values()].filter(
          (vm) => vm.account === account && (pattern === undefined || vm.name === pattern),
        );

        for (const vm of list) poll(vm);

        return json(200, { vms: list.map(row) });
      }

      case "new": {
        const fault = createFault;
        createFault = undefined;

        if (fault) return fault;
        const name = flag("name") ?? `vm${vms.size + 1}`;

        if (vms.has(name)) return error(422, `VM name ${name} is not available`);
        effects.create++;
        const vm = newVm(name, account);
        vm.image = flag("image") ?? "exeuntu";
        vm.cpu = Number(flag("cpu") ?? 2);
        vm.memoryGB = Number((flag("memory") ?? "8GB").replace(/GB$/, ""));
        vm.tags = flags.get("tag") ?? [];
        vm.comment = flag("comment") ?? "";

        if (/[<>&"']/.test(vm.comment))
          return error(422, "comment must not contain HTML metacharacters");
        vm.placement = flag("standalone") ? "standalone" : (flag("pool") ?? "default");
        vms.set(name, vm);

        if (holdNextCreate) {
          holdNextCreate = false;
          await held;
        }

        if (loseNextCreate) {
          loseNextCreate = false;
          throw new TypeError("fetch failed");
        }

        return json(200, row(vm));
      }

      case "rm": {
        const deleted: string[] = [];
        const notFound: string[] = [];

        for (const name of args) {
          const vm = owned(name, account);

          if (!vm || hideNextRm) notFound.push(name);
          else {
            effects.destroy++;
            vms.delete(name);
            rmSync(vm.home, { recursive: true, force: true });
            deleted.push(name);
          }
        }

        hideNextRm = false;

        return json(200, { deleted, failed: notFound, not_found: notFound, errors: {} });
      }

      case "cp": {
        const source = owned(args[0], account);

        if (!source) return error(404, "VM not found");
        const name = args[1] ?? `${source.name}-copy`;

        if (vms.has(name)) return error(422, `VM name ${name} is not available`);
        effects.copy++;
        const vm = newVm(name, account, source);

        if (flag("copy-tags") === "false") vm.tags = [];
        vms.set(name, vm);

        return json(200, {
          name,
          ssh: `${name}.exe.xyz`,
          https_url: `https://${name}.exe.xyz/`,
          state: vm.status,
          tags: vm.tags,
        });
      }

      case "pause": {
        const vm = owned(args[0], account);

        if (!vm) return error(404, "VM not found");

        if (vm.status !== "running") return error(422, "VM is not running");
        effects.pause++;
        vm.status = "paused";

        return json(200, { vm_name: vm.name, status: "paused" });
      }

      case "resume": {
        const vm = owned(args[0], account);

        if (!vm) return error(404, "VM not found");

        if (vm.status !== "paused") return error(422, "VM is not paused");
        effects.resume++;
        vm.status = "running";

        return json(200, { vm_name: vm.name, status: "running", cold_booted: "false" });
      }

      case "comment": {
        const vm = owned(args[0], account);

        if (!vm) return error(404, "VM not found");
        const fault = commentFault;
        commentFault = undefined;

        if (fault) return fault;

        if (/[<>&"']/.test(args[1] ?? ""))
          return error(422, "comment must not contain HTML metacharacters");
        vm.comment = args[1] ?? "";

        return json(200, { vm_name: vm.name, comment: vm.comment });
      }

      case "stat": {
        const vm = owned(args[0], account);

        if (!vm) return error(404, "VM not found");

        return json(200, {
          name: vm.name,
          status: vm.status,
          range: "24h",
          points: [
            {
              timestamp: new Date().toISOString(),
              vm_name: vm.name,
              cpu_cores: vm.cpu,
              mem_total_bytes: vm.memoryGB * 1024 ** 3,
            },
          ],
        });
      }

      case "share show": {
        const vm = owned(args[0], account);

        if (!vm) return error(404, "VM not found");

        return json(200, {
          vm_name: vm.name,
          status: vm.share.status,
          port: vm.share.port,
          url: `https://${vm.name}.exe.xyz/`,
          users: [],
          links: [],
          teams: [],
          team_access: false,
          team_ssh: false,
          team_shelley: false,
        });
      }

      case "share port": {
        const vm = owned(args[0], account);

        if (!vm) return error(404, "VM not found");
        vm.share.port = Number(args[1]);

        return json(200, { vm_name: vm.name, port: vm.share.port });
      }

      case "share set-public": {
        const vm = owned(args[0], account);

        if (!vm) return error(404, "VM not found");
        vm.share.status = "public";

        return json(200, { status: "updated", vm_name: vm.name, port: vm.share.port });
      }

      case "ssh": {
        const vm = owned(args[0], account);

        if (!vm) return error(404, "VM not found");

        return ssh(vm, args.slice(1).join(" "), init.signal);
      }

      default:
        return error(405, `unknown command ${path}`);
    }
  };

  return {
    fetch,
    vms,
    calls,
    effects,
    workdir,
    commands: (path: string) => calls.filter((call) => call.words[0] === path),
    setBootPolls(polls: number) {
      bootPolls = polls;
    },
    failNextComment(response: Response) {
      commentFault = response;
    },
    failNextCreate(response: Response) {
      createFault = response;
    },
    failNextSsh(response: Response | "lost", match?: RegExp) {
      sshFault = response;
      sshFaultMatch = match;
    },
    overrideCommands(
      handler: ((command: string) => { exit: number; stdout?: string } | undefined) | undefined,
    ) {
      commandOverride = handler;
    },
    hideNextRm() {
      hideNextRm = true;
    },
    loseNextCreateResponse() {
      loseNextCreate = true;
    },
    holdNextCreateResponse() {
      holdNextCreate = true;
      held = new Promise((resolve) => {
        releaseHeld = resolve;
      });
    },
    releaseHeldCreateResponse() {
      releaseHeld?.();
    },
    error,
    close() {
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}
