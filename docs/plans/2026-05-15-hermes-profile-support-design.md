# Hermes Profile Support — Design

**Date:** 2026-05-15
**Status:** Design (v2) — not yet implemented

**Revision history**
- v1 (cfc43f4): initial design from brainstorming session
- v2 (this commit): incorporates swarm-code-review findings — drops a wrong CLI-flag justification, fixes a session-cross-profile corruption foot-gun, switches `detectModel` to an options-object signature to preserve the public API, deletes `env.HERMES_HOME` deterministically when a profile is active, and tightens snippets so they paste cleanly

## Goal

Let each Paperclip employee map to a Hermes profile so the employee gets a
fully isolated Hermes identity: SOUL.md persona, memory, skills, sessions,
config, cron jobs, and gateway state — all scoped to that employee.

## Background — what a Hermes profile is

A Hermes profile is a self-contained `HERMES_HOME` directory. By **default**
profiles live at `~/.hermes/profiles/<name>/`, but the real source of truth is
the `HERMES_HOME` env var that the `-p` wrapper sets. Any code that hardcodes
the literal path will break for users who relocate `HERMES_HOME` — so the
adapter must compose with the existing `resolveHermesHome(config)` helper
everywhere it derives a profile path.

Each profile has its own:

- `config.yaml`, `.env`
- `SOUL.md` (durable persona — first slot in the system prompt)
- `skills/` (per-profile skill installs)
- sessions DB, memory store, state DB
- cron jobs, gateway PID, logs

Created via `hermes profile create <name>` (non-interactive scaffolding;
supports `--clone <other>`). Selected at runtime via `-p` / `--profile NAME`,
which works in **any position** in the argv (per Hermes docs:
`hermes chat -p coder -q "hello"` is valid).

Sources:
- https://hermes-agent.nousresearch.com/docs/user-guide/profiles
- https://github.com/nousresearch/hermes-agent/blob/main/website/docs/reference/profile-commands.md
- https://hermes-agent.nousresearch.com/docs/user-guide/features/personality

Out of scope (related but distinct concepts we're explicitly not addressing):

- **Personalities** — named system-prompt overlays under
  `agent.personalities` in config.yaml, switched via `/personality NAME`.
- **SOUL.md** editing through Paperclip UI — user edits in the profile dir.
- **Profile auto-creation** — `hermes setup` does support `--non-interactive`,
  so this is technically possible. Still YAGNI for v1: the user has to make
  meaningful choices (model, API keys) and the testEnvironment error already
  surfaces the exact `hermes profile create` command.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Explicit `adapterConfig.profile` field**, no auto-derivation from agent name/id | Simplest, least magic. User pre-creates the profile and controls the name. Mismatch between Paperclip agent and Hermes profile is impossible to mask. |
| 2 | **Full profile-awareness** (`detectModel`, `scanHermesSkills`, `testEnvironment`, `sessionCodec`) | A profile is a holistic identity — partial awareness would silently read the wrong config / skills / sessions and surface confusing UI. |
| 3 | **Profile owns model/provider defaults** | Profile users carefully tune `config.yaml`. A hardcoded `DEFAULT_MODEL` fallback would silently override that. Explicit `adapterConfig.model` still overrides. |
| 4 | **Fail loudly if profile missing** (no auto-create) | Auto-creation is technically possible (`hermes profile create` is non-interactive, `hermes setup --non-interactive` exists), but skipping the deliberate setup step risks half-broken profiles. Surface the missing profile and the exact remediation command instead. |

## Design

### Shared helper

A single helper, used by `execute.ts`, `detect-model.ts`, `skills.ts`, and
`test.ts`, so the literal `~/.hermes` path lives in exactly one place and
honors the existing `env.HOME` test-override:

```ts
// src/server/profile-paths.ts (new file)
import path from "node:path";
import os from "node:os";

/** Returns ~ (or the env.HOME override) — same shape as the existing
 *  resolveHermesHome in skills.ts. Keep behavior identical so tests that
 *  already exercise the override keep working. */
export function resolveHomeBase(config: Record<string, unknown>): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome =
    typeof env.HOME === "string" && env.HOME.trim() ? env.HOME : null;
  return configuredHome ? path.resolve(configuredHome) : os.homedir();
}

/** Returns the active Hermes state root.
 *  - With profile: <home>/.hermes/profiles/<name>
 *  - Without:      <home>/.hermes
 *  Named "StateRoot" because in the no-profile branch it's NOT a profile —
 *  it's the default Hermes state directory. */
export function resolveHermesStateRoot(
  config: Record<string, unknown>,
): string {
  const home = resolveHomeBase(config);
  const profile =
    typeof config.profile === "string" && config.profile.trim()
      ? config.profile.trim()
      : null;
  return profile
    ? path.join(home, ".hermes", "profiles", profile)
    : path.join(home, ".hermes");
}
```

`skills.ts`'s existing `resolveHermesHome` becomes a thin wrapper around
`resolveHomeBase` (or is deleted in favor of the shared one — implementer's
call as long as the `env.HOME` override keeps working).

### Schema change

| Field | Type | Default | Description |
|---|---|---|---|
| `profile` | `string` | _(none)_ | Name of a pre-existing Hermes profile (default location: `~/.hermes/profiles/<name>/`; honors `HERMES_HOME`). When set, the adapter passes `-p <name>` and reads profile-scoped config, skills, and sessions. |

### File-by-file changes

#### `src/server/execute.ts`

Three changes inside `execute()`:

**1. Profile-aware model fallback (REPLACE line 319):**

```ts
// BEFORE (line 319):
const model = cfgString(config.model) || DEFAULT_MODEL;

// AFTER:
const explicitModel = cfgString(config.model);
const profile = cfgString(config.profile);
// WHY: when a profile is set, its config.yaml owns model/provider defaults.
// Don't shadow them with DEFAULT_MODEL — let the profile decide via the
// existing `if (model)` guard at the args-push site below.
const model = explicitModel ?? (profile ? undefined : DEFAULT_MODEL);
```

**2. Add `-p` to args (REPLACE the `args` initialization at line 363):**

```ts
// BEFORE (line 363):
const args: string[] = ["chat", "-q", prompt];

// AFTER:
// `-p` works in any position per Hermes docs; we put it first by convention
// so it's adjacent to the binary in process listings and easy to grep.
const args: string[] = [];
if (profile) args.push("-p", profile);
args.push("chat", "-q", prompt);
```

The existing `if (model) args.push("-m", model)` at line 367 and
`if (resolvedProvider !== "auto") args.push("--provider", ...)` at line 372
already gate on truthiness — no change needed once `model` can be undefined
and `resolvedProvider` can be `"auto"` (which falls out naturally when
profile owns it and no override is set).

**3. Pass profile to `detectModel`** (REPLACE line 344):

```ts
// BEFORE:
detectedConfig = await detectModel();
// AFTER:
detectedConfig = await detectModel({ profile });
```

**4. Profile-aware `--resume` (REPLACE the resume block at lines 400-405):**

```ts
// BEFORE:
const prevSessionId = cfgString(
  (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
);
if (persistSession && prevSessionId) {
  args.push("--resume", prevSessionId);
}

// AFTER:
// WHY: a session ID lives inside one profile's sessions DB. If the user
// changed adapterConfig.profile since the last run, resuming a session ID
// from the OLD profile would either fail opaquely or silently start fresh
// while Paperclip thinks it resumed. Drop the resume in that case.
const sessionParams = (ctx.runtime?.sessionParams ?? {}) as Record<string, unknown>;
const prevSessionId = cfgString(sessionParams.sessionId);
const prevProfile = cfgString(sessionParams.profile) ?? null;
const profileMatches = (prevProfile ?? null) === (profile ?? null);
if (persistSession && prevSessionId && profileMatches) {
  args.push("--resume", prevSessionId);
} else if (persistSession && prevSessionId && !profileMatches) {
  await ctx.onLog(
    "stdout",
    `[hermes] Skipping --resume: session was created under profile "${prevProfile ?? "<default>"}", current profile is "${profile ?? "<default>"}".\n`,
  );
}
```

Then update the `executionResult.sessionParams` write at line 528 to persist
the profile alongside the sessionId:

```ts
// BEFORE:
executionResult.sessionParams = { sessionId: parsed.sessionId };
// AFTER:
executionResult.sessionParams = {
  sessionId: parsed.sessionId,
  profile: profile ?? null,
};
```

**5. Deterministic env handling (INSERT after line 426, before the `cwd` block):**

```ts
// WHY: if a user sets env.HERMES_HOME alongside profile, the spawned process
// inherits a pre-set HERMES_HOME *and* receives -p, and Hermes's internal
// precedence rules between the two are undocumented. Drop the env var when
// profile is active so `-p` is the single source of truth.
if (profile && env.HERMES_HOME) {
  delete env.HERMES_HOME;
}
```

#### `src/server/detect-model.ts`

Switch to options object to preserve the public API contract (this function
is publicly re-exported from `server/index.ts:7`):

```ts
// BEFORE:
export async function detectModel(
  configPath?: string,
): Promise<DetectedModel | null> { ... }

// AFTER:
export interface DetectModelOptions {
  /** Hermes profile name. When set, reads from
   *  ~/.hermes/profiles/<name>/config.yaml instead of ~/.hermes/config.yaml. */
  profile?: string;
  /** Override the resolved config path entirely (used by tests). */
  configPath?: string;
}

export async function detectModel(
  opts: DetectModelOptions = {},
): Promise<DetectedModel | null> {
  const { profile, configPath } = opts;
  const home = profile
    ? join(homedir(), ".hermes", "profiles", profile)
    : join(homedir(), ".hermes");
  const filePath = configPath ?? join(home, "config.yaml");
  // ...rest unchanged (still returns null on missing file)
}
```

The `homedir()` call here can be replaced with `resolveHomeBase(opts.config)`
**only if** we also pass `config` through — for v1 keep it as-is and accept
that the `env.HOME` override doesn't affect `detectModel`. (Test override is
accomplished via the `configPath` parameter.) Note this hedge in the
implementation PR.

`resolveProvider` is **unchanged** — its 4-step priority chain naturally
accommodates profile-driven defaults once `detectModel` reads the right
file.

**Caller updates required (do not miss):**
- `src/server/execute.ts:344` → `detectModel({ profile })` (covered above)
- `src/server/test.ts:194` → `detectModel({ profile: asString(config.profile) })`
- Any external caller of `detectModel(somePath)` would need to migrate to
  `detectModel({ configPath: somePath })`. The release notes for the
  adapter version that ships this change should call this out.

#### `src/server/skills.ts`

Replace the inline `resolveHermesHome` with a call to the new
`resolveHermesStateRoot`. Thread the active profile name into
`buildSkillEntry` so per-skill labels reflect the actual location.

```ts
import { resolveHermesStateRoot } from "./profile-paths.js";

// In buildHermesSkillSnapshot:
const stateRoot = resolveHermesStateRoot(config);
const hermesSkillsHome = path.join(stateRoot, "skills");
const profile = typeof config.profile === "string" && config.profile.trim()
  ? config.profile.trim()
  : null;

// Pass profile into the per-entry builder:
const hermesSkillEntries = await scanHermesSkills(hermesSkillsHome, profile);
```

Update `scanHermesSkills` and `buildSkillEntry` signatures to accept
`profile`, and update the labels:

```ts
async function buildSkillEntry(
  key: string,
  skillMdPath: string,
  categoryPath: string,
  profile: string | null,
): Promise<AdapterSkillEntry> {
  // ...
  return {
    key,
    runtimeName: key,
    desired: true,
    managed: false,
    state: "installed",
    origin: "user_installed",
    originLabel: profile
      ? `Hermes skill (profile: ${profile})`
      : "Hermes skill",
    locationLabel: profile
      ? `~/.hermes/profiles/${profile}/skills/${categoryPath}`
      : `~/.hermes/skills/${categoryPath}`,
    readOnly: true,
    sourcePath: skillMdPath,
    targetPath: null,
    detail: description,
  };
}
```

The shared-profile UI implication: agents on the same profile will see the
same skill list; the `originLabel` makes the scope visible.

#### `src/server/test.ts`

Add a new `checkProfile` that runs **between** the existing CLI-installed
check (step 1, lines 250-262) and the CLI-version check (step 2, line 265).
Rationale: if the profile is misconfigured we want that to surface as the
first user-actionable error, but only after we've confirmed the binary
exists (a missing binary masks every other failure).

Required imports added to `test.ts`:
```ts
import fs from "node:fs/promises";
import path from "node:path";
import { resolveHermesStateRoot } from "./profile-paths.js";
```

The check itself:

```ts
async function checkProfile(
  config: Record<string, unknown>,
): Promise<AdapterEnvironmentCheck | null> {
  const profile = asString(config.profile);
  if (!profile) return null;

  const profilePath = resolveHermesStateRoot(config);
  const stat = await fs.stat(profilePath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    // WHY: profile must pre-exist — Hermes won't auto-create it, and a
    // missing profile would silently fall back to defaults, masking config
    // drift. Surface the exact remediation command.
    return {
      level: "error",
      message: `Hermes profile "${profile}" not found at ${profilePath}`,
      hint: `Run: hermes profile create ${profile}`,
      code: "hermes_profile_not_found",
    };
  }

  const configYaml = path.join(profilePath, "config.yaml");
  const cfgStat = await fs.stat(configYaml).catch(() => null);
  if (!cfgStat) {
    // Reported as warn rather than error: the profile dir exists, so the
    // user clearly intended to use it. They likely just haven't run
    // `hermes -p <name> setup` yet.
    return {
      level: "warn",
      message: `Profile "${profile}" exists but has no config.yaml`,
      hint: `Run: hermes -p ${profile} setup`,
      code: "hermes_profile_invalid",
    };
  }

  return {
    level: "info",
    message: `Hermes profile: ${profile}`,
    code: "hermes_profile_configured",
  };
}
```

Slot into the sequence in `testEnvironment`:

```ts
// 1. CLI installed?  (existing, unchanged)
// 1b. Profile valid?  (NEW)
const profileCheck = await checkProfile(config);
if (profileCheck) {
  checks.push(profileCheck);
  // Profile errors are non-fatal to the rest of the checks — we still want
  // to surface CLI version, Python version, and API-key state to the user.
}
// 2. CLI version?  (existing)
// ...
```

Also update `checkProviderConsistency` to pass the profile:

```ts
detectedConfig = await detectModel({ profile: asString(config.profile) });
```

`checkModel` is **not** modified. (The earlier draft added an info-level
"profile decides" message; that was scope creep. The existing `checkModel`
already returns the right info message when no model is set — the profile
case requires no special branch.)

Three new check codes total: `hermes_profile_not_found`,
`hermes_profile_invalid`, `hermes_profile_configured`.

#### `src/server/index.ts`

Update `sessionCodec` to round-trip `profile` alongside `sessionId`:

```ts
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const profile = readNonEmptyString(record.profile);
    return profile ? { sessionId, profile } : { sessionId };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    const profile = readNonEmptyString(params.profile);
    return profile ? { sessionId, profile } : { sessionId };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};
```

This pairs with `execute.ts`'s `--resume` profile-match check above. Old
session params (without `profile`) deserialize fine and just behave as
"no previous profile" — backwards compatible.

#### `src/ui/build-config.ts`

Even though `CreateConfigValues` likely does not expose a `profile` form
field (mirroring the existing `provider` situation), `buildHermesConfig`
should pass through `v.profile` if `CreateConfigValues` ever adds it,
**and** the project should accept that `profile` is JSON-config-only for v1.
Concretely:

```ts
// In buildHermesConfig, before returning:
// Hermes profile (JSON-only for v1; CreateConfigValues does not currently
// expose a UI form field, so users must set this via the JSON config editor).
if ("profile" in v && typeof (v as { profile?: unknown }).profile === "string") {
  const p = ((v as { profile?: string }).profile ?? "").trim();
  if (p) ac.profile = p;
}
```

This makes the form non-destructive: a JSON-edited `profile` value won't be
stripped if a user re-opens the form (the existing `buildHermesConfig` only
emits keys it knows about, but the Paperclip server merges form output with
existing config, so any pass-through here is preserved).

Note in implementation: verify the merge behavior matches this assumption
when the `@paperclipai/adapter-utils` package is installed.

#### `src/index.ts` — `agentConfigurationDoc`

Insert at the top (above "Core Configuration"):

```markdown
## Profile (recommended)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| profile | string | (none) | Name of a pre-existing Hermes profile. Each profile is a self-contained Hermes identity: SOUL.md persona, memory, skills, sessions. Pre-create with: `hermes profile create <name>` then `hermes -p <name> setup`. |

When `profile` is set:
- `model` and `provider` default to the values in
  `~/.hermes/profiles/<name>/config.yaml`. Set them explicitly in
  `adapterConfig` only when overriding.
- The adapter passes `-p <name>` to every Hermes invocation.
- Sessions are profile-scoped — switching `profile` on an existing agent
  starts a fresh session.
```

And update the existing `model` row description to:

> Optional explicit model override. When `profile` is set, the profile's
> `config.yaml` decides if this is empty.

#### `README.md`

New "Profiles" section (after "Configuration Reference"), mirroring the
agentConfigurationDoc content but with a richer example showing
pre-creation + adapterConfig + the multi-agent shared-profile note.

## Behavior notes & edge cases

- **`-p` placement** — works in any position per Hermes docs; we put it
  first by convention for grep-ability.
- **`env.HERMES_HOME` interaction** — when `profile` is set, the adapter
  deletes `env.HERMES_HOME` from the spawned process env. `-p` becomes the
  sole source of truth. No warning; behavior is deterministic.
- **Cross-profile `--resume`** — if the persisted session was created under
  a different profile, the adapter logs a notice and starts a fresh
  session instead of resuming. Session params now carry `{ sessionId, profile }`.
- **Shared profile across employees** — multiple Paperclip agents pointing
  at the same profile share memory, skills, and SOUL.md persona. Sessions
  remain separate (each run gets its own `session_id`). Skill entries
  surface the profile name in `originLabel` so the scope is visible.
- **Worktree mode + profile** — orthogonal. `-w` is a chat flag; `-p` is
  global. They compose naturally.
- **Profile auto-creation** — out of scope (see Decision #4).

## Validation

No automated test suite exists in this repo. Verification plan:

1. `npm run typecheck` and `npm run build` clean.
2. Manual smoke against a local Paperclip + local Hermes install:
   - `hermes profile create test-employee` then `hermes -p test-employee setup`
   - Edit `~/.hermes/profiles/test-employee/SOUL.md` to a recognizable persona
   - Register adapter in Paperclip; create agent with `profile: "test-employee"`
   - Trigger heartbeat; confirm:
     - `-p test-employee` appears in spawn args (visible in `[hermes]` log line)
     - SOUL.md persona shows up in the response
     - `listSkills` returns skills from the profile's `skills/` dir
     - `listSkills` entries show `originLabel: "Hermes skill (profile: test-employee)"`
   - Set agent to a non-existent profile → `testEnvironment` returns the
     `hermes_profile_not_found` error.
   - Run a heartbeat, then change `profile`, then run another heartbeat →
     confirm log line: `Skipping --resume: session was created under profile "test-employee"...`.

## Implementation footprint

- **~150–180 lines of code change** across `execute.ts`, `detect-model.ts`,
  `skills.ts`, `test.ts`, `index.ts`, `build-config.ts`, plus a new
  `profile-paths.ts` helper.
- **~50 lines of docs** (`README.md` + `agentConfigurationDoc`).
- **No new dependencies.**
- **Backwards compatible** for runtime behavior: agents without `profile`
  set continue to work unchanged. The `detectModel` signature change is a
  public-API break documented above; affects only direct programmatic
  consumers of `detectModel(somePath)`.
