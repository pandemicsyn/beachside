import { secret } from "beachside";
import type { Flags } from "./commands";
import { usage } from "./output";
import { secretSourceKind, targetFrom } from "./secrets";
import type { Session } from "./session";
import { listAll } from "./store";

/** `beachside secret ls`: named secrets with their mode, hosts and source kind, and who uses them. */
export async function secretCommand(session: Session, flags: Flags): Promise<number> {
  const [action, ...args] = flags.positionals;

  if (action !== "ls")
    throw usage(
      action ? `Unknown secret command ${action}` : "Expected a secret command",
      "use: ls",
    );

  if (args.length) throw usage("secret ls takes no arguments");
  const named = (await session.config()).value.secrets ?? {};
  const records = (await listAll(await session.store(), "sandbox")).map((entry) => entry.record);

  const rows = Object.entries(named).map(([name, config]) => {
    const { value, ...fields } = config;
    const target = targetFrom(fields, `secrets.${name}`);

    return {
      name,
      mode: target ? ("brokered" as const) : ("plain" as const),
      preset: config.for ?? null,
      hosts: target ? [...new Set(secret("probe", target).rules.map((rule) => rule.host))] : [],
      source: secretSourceKind(value),
      usedBy: records
        .filter((record) => record.secrets?.some((bound) => bound.named === name))
        .map((record) => record.name),
    };
  });

  // Secrets given inline with --secret show up on the sandboxes that hold them.
  const inline = records.flatMap((record) =>
    (record.secrets ?? []).flatMap((bound) =>
      bound.named ? [] : [{ sandbox: record.name, ...bound }],
    ),
  );

  session.ctx.out.success(
    { secrets: rows, inline },
    rows.length || inline.length
      ? [
          ...rows.map(
            (row) =>
              `${row.name.padEnd(16)} ${row.mode.padEnd(9)} ${(row.hosts.join(",") || "-").padEnd(36)} ${row.source.padEnd(12)} ${row.usedBy.join(",") || "-"}`,
          ),
          ...inline.map(
            (row) =>
              `${`${row.sandbox}:${row.env}`.padEnd(16)} ${row.mode.padEnd(9)} ${row.hosts.join(",") || "-"}`,
          ),
        ].join("\n")
      : "no named secrets; add a secrets block to beachside.json, or pass --secret to create",
  );

  return 0;
}
