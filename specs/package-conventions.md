# Public packages and adapter conventions

**Accepted user decision — October 11, 2026, renamed November 2026.** The core keeps the unscoped `beachside` name; every other official package lives in the project-owned `@beachside` npm scope, so new official integrations need no separate name reservation. Private workspaces use `@beachside-internal/*` names and are never published. Registry absence does not reserve a name or authorize publication. Third-party authors may use their own names/scopes, such as `@acme/beachside-adapter`. Package names are independent of stable provider IDs (`daytona`, `e2b`, `boxd`, `vercel`, `modal`).

## Names and imports

| Purpose | npm package | Import path |
| --- | --- | --- |
| Provider-neutral SDK | `beachside` | `beachside` |
| Official Daytona adapter | `@beachside/daytona` | `@beachside/daytona` |
| Official E2B adapter | `@beachside/e2b` | `@beachside/e2b` |
| Experimental Modal adapter | `@beachside/modal` | `@beachside/modal` |
| boxd adapter (experimental) | `@beachside/boxd` | `@beachside/boxd` |
| Boat adapter (experimental) | `@beachside/boat` | `@beachside/boat` |
| Runloop adapter (experimental) | `@beachside/runloop` | `@beachside/runloop` |
| Freestyle adapter (experimental) | `@beachside/freestyle` | `@beachside/freestyle` |
| Official Vercel adapter | `@beachside/vercel` | `@beachside/vercel` |
| Command line (`beachside` binary) | `@beachside/cli` | none; run `beachside` |
| Pi extension and SDK tools | `@beachside/pi` | Pi manifest and `createBeachsideTools` |
| Custom adapter authoring | `@beachside/adapter` | `@beachside/adapter` |
| Adapter conformance tests | included in `@beachside/adapter` | `@beachside/adapter/testing` |
| Future integrations | `@beachside/<provider>` | e.g. `@beachside/tensorlake` |

**Accepted user decision — October 11, 2026.** The core keeps the unscoped `beachside` name; every other official package lives in the project-owned `@beachside` npm scope, so new official integrations need no separate name reservation. This supersedes the earlier unscoped `beachside-<package>` names, whose placeholders are removed from npm. The occupied `beachside` package and `@beachside` scope are unrelated; private workspaces keep `@beachside/*` names and are never published. Registry absence does not reserve a name or authorize publication. Third-party authors may use their own names/scopes, such as `@acme/beachside-adapter`. Package names are independent of stable provider IDs (`daytona`, `e2b`, `boxd`, `vercel`, `modal`).

## Consumer experience

```sh
npm install beachside @beachside/daytona
```

```ts
import { Beachside } from "beachside";
import { daytonaAdapter } from "@beachside/daytona";

const beachside = await Beachside.connect({
  adapter: daytonaAdapter,
  credentials: { apiKey: process.env.DAYTONA_API_KEY! },
  config: { target: "us" },
});
```

**Accepted user decision — November 7, 2026.** The split form, `Beachside.connect({ adapter, credentials, config })`, is the canonical setup shown in docs, examples, skills and the landing page, because every adapter supports it, including third-party ones. Every first-party package exports:

- the definition as `<provider>Adapter` (`daytonaAdapter`, `e2bAdapter`, `boxdAdapter`, `boatAdapter`, `runloopAdapter`, `freestyleAdapter`, `modalAdapter`, `vercelAdapter`), and
- a factory named after the provider (`daytona`, `e2b`, `boxd`, `boat`, `runloop`, `freestyle`, `modal`, `vercel`) that takes credentials and config in one object and returns a `BoundAdapter` through `bindAdapter`, with no provider IO.

Factories are optional sugar; they are most useful when code picks a provider at run time, since every factory returns the same type. Third-party authors may ship a factory with `bindAdapter` from `@beachside/adapter`, but are not required to. `Beachside.connect` validates and verifies the binding and owns the session.

The unpublished `beachside/daytona` and `beachside/e2b` subpaths are removed without aliases. Update imports and install the selected adapter. Provider IDs, configuration defaults, resource identity, references, recovery and execution semantics remain unchanged.

## Support and implementation scope

Daytona and E2B remain first-class official integrations maintained in this monorepo. Separate installation does not imply experimental or community support. Implementation, deterministic fixture qualification, packed qualification and live qualification remain distinct statuses.

Modal remains separately installed and experimental, and is published in the lockstep release group. Its private version-sensitive transport, uncertain image-build recovery and unrun live scenarios remain documented limitations. It is not a 1.0 release gate.

boxd (#82) and Vercel (#93) are implemented and included in the initial release group; boxd retains its experimental support status. Vercel provides disposable immutable sessions, bounded binary execution and compute stop with retained named metadata. Its [provider README](../packages/providers/vercel/README.md) records REST stability and unrun live qualification; [boxd](../packages/providers/boxd/README.md) records its scoped live baseline. Islo and Tensorlake remain candidates for further research; [the roadmap](../ROADMAP.md) owns sequencing. The fake provider remains a deterministic development fixture.

## Dependency and schema ownership

`beachside` contains the provider-neutral consumer API and execution engine. It must not depend on provider packages or native provider libraries. Each adapter owns its native production dependencies; E2B's native `e2b` dependency belongs only to `@beachside/e2b`.

`@beachside/adapter` owns portable definitions, image inputs and the provider-neutral binding contract/helper. It must not depend on the SDK or native libraries. Adapters must not depend on the SDK at runtime. There is no catch-all public contracts package.

Private implementation workspaces may be bundled into adapter artifacts. Their unpublished names must not leak into runtime imports or declarations. Daytona bundles private SPI implementation and vendors required declarations; do not publish SPI to satisfy packaging.

## Implementation and release acceptance

The initial 0.1.0 fixed, lockstep public release group is `@beachside/adapter`, `beachside`, `@beachside/daytona`, `@beachside/e2b`, `@beachside/boxd`, `@beachside/boat`, `@beachside/runloop`, and `@beachside/vercel`; `@beachside/cli` joins the group from its first release, experimental `@beachside/modal` from 0.7.0 and experimental `@beachside/freestyle` from its first release. `@beachside/pi` joins from its first release. Separate installation does not require independent release infrastructure. Keep the existing release machinery and release the actual distributable graph.

Qualify real tarballs in isolated consumers: core alone, core plus each released provider, combined Daytona/E2B, and an independently authored adapter. Verify strict NodeNext declarations, Node/Bun execution, private-workspace isolation and npm/pnpm/Bun installation. Archive overrides may resolve transitive local packages without adding undeclared root dependencies.

Unpublished API removal does not weaken scope, binary fidelity, validation, abort/close or unknown/no-replay guarantees. Never automatically delete user data. Effect remains parked.
