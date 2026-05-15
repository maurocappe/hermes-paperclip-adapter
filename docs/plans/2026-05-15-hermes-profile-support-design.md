# Hermes Profile Support — Design

**Date:** 2026-05-15
**Status:** Design — not yet implemented

## Goal

Let each Paperclip employee map to a Hermes profile so the employee gets a
fully isolated Hermes identity: SOUL.md persona, memory, skills, sessions,
config, cron jobs, and gateway state — all scoped to that employee.

## Background — what a Hermes profile is

A Hermes profile is a self-contained `HERMES_HOME` directory at
`~/.hermes/profiles/<name>/`. Each profile has its own:

- `config.yaml` (model, provider, base_url, api_mode)
- `SOUL.md` (durable persona — first slot in the system prompt)
- `skills/` (per-profile skill installs)
- sessions DB, memory store, state DB
- cron jobs and gateway PID

It is created via `hermes profile create <name>` and selected at runtime via
the global `-p` / `--profile NAME` flag, which is just a wrapper that sets
`HERMES_HOME` for that invocation.

Sources:
- https://hermes-agent.nousresearch.com/docs/user-guide/profiles
- https://github.com/nousresearch/hermes-agent/blob/main/website/docs/reference/profile-commands.md
- https://hermes-agent.nousresearch.com/docs/user-guide/features/personality

Hermes also has two related concepts that are explicitly **out of scope** for
this change:

- **Personalities** — named system-prompt overlays defined under
  `agent.personalities` in config.yaml, switched via `/personality NAME`.
  Lighter-weight than profiles. We may surface this later.
- **SOUL.md** — durable persona file. Edited by the user inside the profile
  directory; the adapter doesn't manage it.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Explicit `adapterConfig.profile` field**, no auto-derivation from agent name/id | Simplest, least magic. User pre-creates the profile and controls the name. Mismatch between Paperclip agent and Hermes profile is impossible to mask. |
| 2 | **Full profile-awareness** (`detectModel`, `scanHermesSkills`, `testEnvironment`) | A profile is a holistic identity — partial awareness would silently read the wrong config / skills and surface confusing UI. |
| 3 | **Profile owns model/provider defaults** | Profile users carefully tune `config.yaml`. A hardcoded `DEFAULT_MODEL` fallback would silently override that. Explicit `adapterConfig.model` still overrides — A/B testing is preserved. |
| 4 | **Fail loudly if profile missing** (no auto-create) | Auto-creating a profile with `hermes profile create` would skip `setup` (which is interactive and configures model/keys), leaving the user with a half-broken profile. Better to surface the missing profile and the exact command. |

## Design

### Schema change

Add one optional field to `adapterConfig`:

| Field | Type | Default | Description |
|---|---|---|---|
| `profile` | `string` | _(none)_ | Name of a pre-existing Hermes profile (`~/.hermes/profiles/<name>/`). When set, the adapter uses `-p <name>` and reads profile-scoped config & skills. |

### File-by-file changes

#### `src/server/execute.ts`

```ts
// In execute(), after reading config:
const explicitModel = cfgString(config.model);
const profile = cfgString(config.profile);

// WHY: when a profile is set, its config.yaml owns model/provider defaults.
// Don't shadow them with DEFAULT_MODEL — let the profile decide.
const model = explicitModel ?? (profile ? undefined : DEFAULT_MODEL);

// In args construction:
// WHY: -p / --profile is a Hermes GLOBAL flag — it must precede the
// `chat` subcommand, otherwise Hermes treats it as a chat flag (or errors).
const args: string[] = [];
if (profile) args.push("-p", profile);
args.push("chat", "-q", prompt);
if (useQuiet) args.push("-Q");
if (model) args.push("-m", model);
// ...rest unchanged...

// Pass profile to detectModel for provider resolution
if (!explicitProvider) {
  try {
    detectedConfig = await detectModel(profile);
  } catch { /* non-fatal */ }
}
```

The existing guards do most of the work:
- `if (model) args.push("-m", model)` at line 367 already conditional — no special-case needed.
- `if (resolvedProvider !== "auto") args.push("--provider", ...)` at line 372 already conditional — `resolveProvider` returning `"auto"` when profile owns it Just Works.

#### `src/server/detect-model.ts`

```ts
// WHY: when a profile is active, its own config.yaml owns the model defaults.
// Reading the root ~/.hermes/config.yaml would surface the wrong model in
// the UI dropdown and break provider auto-detection.
export async function detectModel(
  profile?: string,
  configPath?: string,
): Promise<DetectedModel | null> {
  const home = profile
    ? join(homedir(), ".hermes", "profiles", profile)
    : join(homedir(), ".hermes");
  const filePath = configPath ?? join(home, "config.yaml");
  // ...rest unchanged (returns null on missing file — preserved)
}
```

`resolveProvider` is **unchanged** — its 4-step priority chain (explicit →
detected → inferred → "auto") naturally accommodates profile-driven defaults
once `detectModel` reads the right file.

#### `src/server/skills.ts`

Compose with the existing `resolveHermesHome` helper (which honors
`config.env.HOME` for testing/sandboxing). Don't replace it.

```ts
function resolveHermesProfileRoot(config: Record<string, unknown>): string {
  const home = resolveHermesHome(config);          // keeps env.HOME override
  const profile = asString((config as Record<string, unknown>).profile);
  return profile
    ? path.join(home, ".hermes", "profiles", profile)
    : path.join(home, ".hermes");
}

// In buildHermesSkillSnapshot:
const hermesSkillsHome = path.join(resolveHermesProfileRoot(config), "skills");
```

Update `locationLabel` (currently hard-coded to `~/.hermes/skills/...` at
line 117) to reflect the actual path:

```ts
locationLabel: profile
  ? `~/.hermes/profiles/${profile}/skills/${categoryPath}`
  : `~/.hermes/skills/${categoryPath}`,
```

#### `src/server/test.ts`

New check, mirrors `checkCliInstalled`'s shape:

```ts
async function checkProfile(
  config: Record<string, unknown>,
): Promise<AdapterEnvironmentCheck | null> {
  const profile = asString(config.profile);
  if (!profile) return null;

  const profilePath = join(homedir(), ".hermes", "profiles", profile);
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

  const configYaml = join(profilePath, "config.yaml");
  const cfgStat = await fs.stat(configYaml).catch(() => null);
  if (!cfgStat) {
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

Also update `checkProviderConsistency` to pass the profile through:

```ts
detectedConfig = await detectModel(asString(config.profile));
```

And update `checkModel` to acknowledge the "profile decides" case:

```ts
if (!model && asString(config.profile)) {
  return {
    level: "info",
    message: "No model override — profile's config.yaml will decide",
    code: "hermes_profile_owns_model",
  };
}
```

Check codes follow the existing `hermes_<noun>_<state>` convention.

#### `src/index.ts` — `agentConfigurationDoc`

Add a new "Profile" section at the top of the markdown (above "Core
Configuration") that explains:
- What a profile is
- The pre-creation requirement (`hermes profile create <name>`)
- That `model` / `provider` are profile-owned by default and only need to be
  set in `adapterConfig` when overriding

Update the `model` row description to: _"Optional explicit model override.
When `profile` is set, the profile's `config.yaml` decides if this is empty."_

#### `src/ui/build-config.ts`

If `CreateConfigValues` exposes a `profile` form field in
`@paperclipai/adapter-utils` v2026.325.0, persist it. Otherwise: leave the
form as-is and document that `profile` must be set via the JSON config
editor (or wait for the form field to land upstream). Implementation will
verify this once the package is installed.

#### `README.md`

New "Profiles" section documenting:
- One-liner: "Each Paperclip employee can be backed by a Hermes profile."
- Pre-creation: `hermes profile create <name>` then customize
  `~/.hermes/profiles/<name>/SOUL.md`.
- Example `adapterConfig` with `profile` set.
- Note that multiple agents on the same profile share memory, skills, and
  SOUL.md — sessions stay separate.

## Behavior notes & edge cases

- **`-p` placement** — global flag, must precede `chat`. Args are
  `['-p', profile, 'chat', '-q', prompt, ...]`.
- **Shared profile** — multiple Paperclip agents pointing at the same profile
  share memory, skills, and SOUL.md persona. Sessions remain separate (each
  run gets its own `session_id`). Documented as intended.
- **`env.HERMES_HOME` conflict** — if a user sets both `profile` and
  `env.HERMES_HOME`, `-p` wins (Hermes will set `HERMES_HOME` to the profile
  path). No special handling — Hermes's behavior takes care of it. (We do
  *not* introduce a new warning here; YAGNI.)
- **Worktree mode + profile** — orthogonal. `-w` is a chat flag; `-p` is
  global. They compose naturally.
- **Profile auto-creation** — out of scope. `testEnvironment` fails loudly.

## Out of scope

- Auto-creation of profiles
- Personality (`/personality NAME`) plumbing
- SOUL.md editing through Paperclip UI
- Profile distribution / publishing
- Multiple profiles per agent

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
   - Set agent to a non-existent profile → `testEnvironment` returns the
     `hermes_profile_not_found` error with the suggested `hermes profile
     create` hint.

## Implementation footprint

- ~120 lines of code change across `execute.ts`, `detect-model.ts`,
  `skills.ts`, `test.ts`, `index.ts`, `build-config.ts`
- ~50 lines of docs (`README.md` + `agentConfigurationDoc`)
- No new dependencies
- Backwards compatible: agents without `profile` set continue to work
  unchanged
