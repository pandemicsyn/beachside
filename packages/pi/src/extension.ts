import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  SessionManager,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { bashOperations, createBeachsideTools, findDescription } from "./tools";
import { Fork, Saved, SandboxSession, forkEntry, message, sessionEntry } from "./session";
import { pull, push } from "./workspace";

const localTools = {
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  find: createFindToolDefinition,
  grep: createGrepToolDefinition,
  ls: createLsToolDefinition,
  read: createReadToolDefinition,
  write: createWriteToolDefinition,
};

const skillsDir = fileURLToPath(new URL("./skills/", import.meta.url));

export default function beachside(pi: ExtensionAPI) {
  let session: SandboxSession | undefined;
  let exit = "destroy";
  let previousTools: string[] = [];

  pi.registerFlag("beachside", {
    type: "string",
    description: "Run Pi tools in this Beachside profile",
  });
  pi.registerFlag("beachside-sync", {
    type: "string",
    description: "Initialize the guest workspace with git, upload, or none",
  });
  pi.registerFlag("beachside-snapshot", {
    type: "string",
    description: "Restore a named Beachside CLI snapshot",
  });
  pi.registerFlag("beachside-exit", {
    type: "string",
    description: "On quit, destroy, suspend, or keep the sandbox",
    default: "destroy",
  });
  pi.registerFlag("beachside-eager", {
    type: "boolean",
    description: "Create or reopen the sandbox on session start",
  });

  function replace<P extends TSchema, D>(
    local: ToolDefinition<P, D>,
    factory: (tools: ReturnType<typeof createBeachsideTools>) => ToolDefinition<P, D>,
  ) {
    pi.registerTool({
      ...local,
      defaultActive: false,
      async execute(id, args, signal, update, ctx) {
        if (!session || session.off) return local.execute(id, args, signal, update, ctx);
        signal?.throwIfAborted();
        const { box, workdir } = await session.get();
        signal?.throwIfAborted();
        const remote = factory(createBeachsideTools(box, workdir, signal));

        return remote.execute(id, args, signal, update, ctx);
      },
    });
  }

  pi.on("session_start", async (event, ctx) => {
    const owner = ctx.sessionManager.getSessionId();

    const saved = ctx.sessionManager
      .getEntries()
      .findLast(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === sessionEntry &&
          Saved.safeParse(entry.data).data?.owner === owner,
      );

    const record = saved?.type === "custom" ? Saved.parse(saved.data) : undefined;
    let fork: Fork | undefined;

    if (event.reason === "fork" && event.previousSessionFile) {
      const previous = SessionManager.open(event.previousSessionFile);

      const handoff = previous
        .getEntries()
        .findLast(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === forkEntry &&
            Fork.safeParse(entry.data).data?.target === ctx.sessionManager.getSessionFile(),
        );

      if (handoff?.type === "custom") fork = Fork.parse(handoff.data);
    }

    const savedProfile = record?.profile ?? fork?.profile;
    const profile = String(pi.getFlag("beachside") || savedProfile || "");

    if (!profile) return;

    const active = new SandboxSession(
      pi,
      ctx,
      savedProfile ?? profile,
      record,
      fork,
      String(pi.getFlag("beachside-sync") || "") || undefined,
      String(pi.getFlag("beachside-snapshot") || "") || undefined,
    );

    session = active;

    if (active.off) return;
    previousTools = pi.getActiveTools();
    replace(localTools.bash(ctx.cwd), (tools) => tools.bash);
    replace(localTools.edit(ctx.cwd), (tools) => tools.edit);
    replace({ ...localTools.find(ctx.cwd), description: findDescription }, (tools) => tools.find);
    replace(localTools.grep(ctx.cwd), (tools) => tools.grep);
    replace(localTools.ls(ctx.cwd), (tools) => tools.ls);
    replace(localTools.read(ctx.cwd), (tools) => tools.read);
    replace(localTools.write(ctx.cwd), (tools) => tools.write);
    pi.setActiveTools(previousTools.filter((name) => name !== "powershell"));
    ctx.ui.setStatus("beachside", `${active.profile} · sandbox pending`);

    exit = String(pi.getFlag("beachside-exit") ?? "destroy");

    if (!["destroy", "suspend", "keep"].includes(exit)) {
      active.block("Expected --beachside-exit destroy, suspend, or keep");
      ctx.ui.notify("Expected --beachside-exit destroy, suspend, or keep", "error");

      return;
    }

    if (savedProfile && profile !== savedProfile) {
      active.block(
        `This session belongs to Beachside profile ${savedProfile}. Start a new Pi session to switch profiles.`,
      );

      return;
    }

    try {
      const caps = await active.capabilities();

      if (caps.preview) {
        pi.registerTool({
          name: "preview_url",
          label: "Preview URL",
          description: "Get the sandbox HTTPS URL for a configured port",
          parameters: Type.Object({ port: Type.Integer({ minimum: 1, maximum: 65535 }) }),
          async execute(_id, { port }, signal) {
            if (active.off) throw new Error("Beachside is off");
            const { box } = await active.get();
            const preview = await box.preview(port, { signal });

            const text =
              preview.access === "protected"
                ? `${preview.url} (requires authentication)`
                : preview.url;

            return { content: [{ type: "text", text }], details: undefined };
          },
        });
      }

      const capture = caps.snapshots.capture;

      if (
        capture.status === "supported" &&
        capture.value.profiles.some(
          (item) => item.id === capture.value.defaultProfileId && item.sourceAfter === "unchanged",
        )
      ) {
        pi.registerCommand("beachside-snapshot", {
          description: "Save the current sandbox as a named snapshot",
          async handler(args, command) {
            const snapshot = await active.capture(args.trim());
            command.ui.notify(`Saved snapshot ${args.trim()} (${snapshot.nativeId})`, "info");
          },
        });
      }

      if (pi.getFlag("beachside-eager")) await active.get();
    } catch (cause) {
      ctx.ui.notify(`Beachside: ${message(cause)}`, "error");
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!session || session.off) return;
    const options = event.systemPromptOptions;
    options.sections.cwd = await session.promptWorkdir();
    options.sections.beachside =
      "The file and shell tools use the remote Beachside filesystem. Paths are guest paths.";
    options.skills = options.skills
      .filter((skill) => skill.filePath.startsWith(skillsDir))
      .map((skill) => ({
        ...skill,
        filePath: `/tmp/beachside-pi-skills/${skill.name}/SKILL.md`,
        baseDir: `/tmp/beachside-pi-skills/${skill.name}`,
      }));
  });

  pi.on("user_bash", () => {
    const active = session;

    if (!active || active.off) return;

    return {
      operations: {
        async exec(command, cwd, options) {
          options.signal?.throwIfAborted();
          const { box, workdir } = await active.get();
          options.signal?.throwIfAborted();

          return bashOperations(box, workdir).exec(command, cwd, options);
        },
      },
    };
  });

  pi.on("tool_call", (event) => {
    if (session && !session.off && event.toolName === "powershell")
      return { block: true, reason: "Use the Beachside bash tool for guest commands." };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    try {
      await session?.shutdown(event.reason, exit, event.targetSessionFile);
    } catch (cause) {
      ctx.ui.notify(`Beachside cleanup: ${message(cause)}`, "error");
    }
  });

  const requireSession = () => {
    if (!session || session.off)
      throw new Error("Beachside is off. Start Pi with --beachside <profile>.");

    return session;
  };

  pi.registerCommand("beachside", {
    description: "Show the Beachside sandbox status",
    async handler(_args, ctx) {
      const text = session
        ? `${session.profile} · ${session.off ? "off" : (session.box?.id ?? "no active sandbox")}${session.workdir ? ` · ${session.workdir}` : ""}`
        : "Beachside is off";

      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("beachside-push", {
    description: "Copy the host workspace into the guest workdir",
    async handler(_args, ctx) {
      const { box, workdir } = await requireSession().get();
      await push(box, ctx.cwd, workdir, ctx.signal ?? new AbortController().signal);
      ctx.ui.notify(`Pushed workspace to ${workdir}`, "info");
    },
  });

  pi.registerCommand("beachside-pull", {
    description: "Copy the guest workdir to a new host directory",
    async handler(args, ctx) {
      if (!args.trim()) throw new Error("Usage: /beachside-pull <new-host-directory>");
      const destination = resolve(ctx.cwd, args.trim());
      const { box, workdir } = await requireSession().get();
      await pull(box, workdir, destination, ctx.signal ?? new AbortController().signal);
      ctx.ui.notify(`Pulled workspace to ${destination}`, "info");
    },
  });

  pi.registerCommand("beachside-off", {
    description: "Use local Pi tools for the rest of this session",
    async handler(_args, ctx) {
      if (session) {
        session.disable();
        pi.setActiveTools(previousTools);
      }

      ctx.ui.notify("Pi tools are local", "info");
    },
  });

  pi.registerCommand("beachside-destroy", {
    description: "Destroy this session's sandbox",
    async handler(_args, ctx) {
      if (!session) throw new Error("No Beachside session");
      await session.destroy();
      ctx.ui.notify("Beachside sandbox destroyed", "info");
    },
  });
}
