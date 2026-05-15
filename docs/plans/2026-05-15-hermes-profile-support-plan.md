# Implementation Plan: Hermes Profile Support

**Date:** 2026-05-15
**Design doc:** [`2026-05-15-hermes-profile-support-design.md`](./2026-05-15-hermes-profile-support-design.md) (commit `4979f2e`)

## Context

Add `adapterConfig.profile?: string` to the Paperclip adapter so each
Paperclip employee can map to a self-contained Hermes profile (its own
SOUL.md persona, memory, skills, sessions, config). When set, the adapter
passes `-p <name>` to Hermes and reads profile-scoped state.

All design decisions are locked in the design doc. This plan focuses on
**execution shape**: task ordering, file boundaries, and gotchas surfaced
by the parallel scout pass.

## Dependencies

- Hermes Agent CLI installed locally for manual smoke verification.
- `@paperclipai/adapter-utils` — currently declared in `package.json` but
  not installed in `node_modules/`. Implementation can proceed against
  declared types; smoke verification requires a `npm install` first.
- No new npm dependencies needed.

## Pattern conventions to follow

Lifted from the existing codebase — implementer must mirror these:

- **`node:` prefix** is universal on built-in imports (`node:path`,
  `node:fs/promises`, `node:os`). Confirmed across all source files.
- **Per-file config helpers**: `execute.ts` defines `cfgString/cfgNumber/...`
  (`execute.ts:51-64`); `test.ts` and `skills.ts` each define a narrower
  `asString` (different return types — `undefined` vs `null`). **Do not
  try to unify** — use the file's local helper. The new `profile-paths.ts`
  uses its own inline shape-check.
- **WHY-comments**: 3–10 lines, lead with WHY, name the concrete
  consequence and external constraint. Reference: the `--yolo` block
  (`execute.ts:392-397`) and the provider priority chain
  (`execute.ts:329-338`).
- **Test-check codes**: `hermes_<noun>_<state>` (e.g. `hermes_cli_not_found`,
  `hermes_provider_mismatch`).
- **`testEnvironment` flow**: `push` to `checks[]`; only short-circuit on
  the CLI-not-found error. New checks slot in without affecting later checks.

## Gotchas the scouts surfaced (handle these explicitly)

1. **`execute.ts:440` log line** prints `model=${model}` — once `model` can
   be `undefined`, this leaks `undefined` to the log. Coerce to a display
   string (`model ?? "<profile default>"`).
2. **`execute.ts:498` writes `executionResult.model = model`** — same
   problem; would leak `undefined` to Paperclip UI. Either coerce to
   `null` (matches `costUsd` style) or to a display string.
3. **`execute.ts:407` appends `extraArgs` AFTER `--resume`** — if a user
   puts `-p other-profile` in `extraArgs`, last-one-wins per Hermes (which
   accepts `-p` in any position). Foot-gun, not a blocker. Document in
   the agentConfigurationDoc note for `extraArgs`.
4. **`detectModel` does NOT honor `env.HOME` override** — only `skills.ts`
   does today. The new `detectModel({ profile })` uses raw `homedir()`.
   Acceptable for v1 (tests can use `configPath` override). Note in T3.
5. **`buildPaperclipEnv(ctx.agent)` may set HERMES_HOME** indirectly — the
   `delete env.HERMES_HOME` at T5 must run AFTER all env composition.
   Verify when `@paperclipai/adapter-utils` is installed.
6. **Three `cfg/asString` helpers exist** with different return types. New
   code in each file uses that file's helper. Do not import across files.
7. **`sessionCodec` has zero in-repo callers** (consumed by Paperclip
   server). Round-trip is testable only via live smoke run.

## Naming refinement (vs. design)

The design proposes `resolveHomeBase` + `resolveHermesStateRoot`. Repo
architect flagged "StateRoot" as awkward (the function returns `~/.hermes`
in the no-profile branch — not a profile). Use **a single helper named
`resolveHermesHome(config)`** that returns the active Hermes directory
(profile-aware: `~/.hermes/profiles/<name>` or `~/.hermes`). This:

- Reuses the established name from `skills.ts:25` (only one in-repo caller
  to migrate)
- Eliminates the misleading-name disclaimer
- Subsumes both helpers from the design without losing the `env.HOME`
  override

## Tasks

### T1: Add `src/server/profile-paths.ts` helper

**What.** Create the new file. Export a single function:

```ts
import path from "node:path";
import os from "node:os";

/** Returns the active Hermes home directory.
 *  - With config.profile set: <home>/.hermes/profiles/<name>
 *  - Without:                  <home>/.hermes
 *  Honors a config.env.HOME override (test/sandbox use). */
export function resolveHermesHome(config: Record<string, unknown>): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const overrideHome =
    typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : null;
  const baseHome = overrideHome ? path.resolve(overrideHome) : os.homedir();

  const profile =
    typeof config.profile === "string" && config.profile.trim()
      ? config.profile.trim()
      : null;

  return profile
    ? path.join(baseHome, ".hermes", "profiles", profile)
    : path.join(baseHome, ".hermes");
}
```

**Where.** `src/server/profile-paths.ts` (new). Server-only — UI/CLI
should not depend on Node filesystem helpers (would force `node:os` into
their bundle).

**Watch out.** Name collides with the soon-to-be-deleted
`resolveHermesHome` in `skills.ts:25` — they exist in different modules,
but the file at T1 leaves `skills.ts`'s copy untouched. T2 deletes it.

**Tests.** `npm run typecheck` clean. No runtime assertion possible
without a test framework.

**Builds on.** Nothing — leaf module.

---

### T2: Migrate `skills.ts` to the shared helper, thread profile through

**What.**
1. Import `resolveHermesHome` from `./profile-paths.js`.
2. Delete the inline `resolveHermesHome` at `skills.ts:25-32`.
3. Update `buildHermesSkillSnapshot` (`skills.ts:129-131`):
   ```ts
   const profile =
     typeof config.profile === "string" && config.profile.trim()
       ? config.profile.trim()
       : null;
   const hermesSkillsHome = path.join(resolveHermesHome(config), "skills");
   ```
4. Add `profile: string | null` parameter to `scanHermesSkills`
   (`skills.ts:60`) and `buildSkillEntry` (`skills.ts:95`).
5. Update labels in `buildSkillEntry`:
   ```ts
   originLabel: profile ? `Hermes skill (profile: ${profile})` : "Hermes skill",
   locationLabel: profile
     ? `~/.hermes/profiles/${profile}/skills/${categoryPath}`
     : `~/.hermes/skills/${categoryPath}`,
   ```

**Where.** `src/server/skills.ts` only.

**Watch out.** The `locationLabel` is a display string and doesn't honor
`env.HOME` override — fine for UI display, but it lies if `HERMES_HOME` is
relocated. Acceptable for v1.

**Tests.** `typecheck` + `build`. Smoke at T8 confirms `originLabel`
includes the profile name in `listSkills` output.

**Builds on.** T1.

---

### T3: Change `detectModel` signature to options object

**What.** Convert `detectModel(configPath?: string)` to take an options
object. This is the **only public-API break** in the change set; isolating
it in its own task makes the API delta visible to reviewers.

```ts
export interface DetectModelOptions {
  /** Hermes profile name. When set, reads from
   *  ~/.hermes/profiles/<name>/config.yaml instead of the default. */
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
  // ...rest unchanged...
}
```

Update both internal callers in the same task so the build stays green.
**The literal call expressions are:**
- `src/server/execute.ts:344` → `detectModel({ profile: cfgString(config.profile) })`. **Do NOT write `detectModel({ profile })`** — the local `profile` variable does not exist in `execute()` yet; T4 introduces it. Inline the `cfgString(config.profile)` lookup at the call site for now; T4 will refactor to use the local variable.
- `src/server/test.ts:194` → `detectModel({ profile: asString(config.profile) })`.

**Where.** `src/server/detect-model.ts` (signature + body), plus the two
callers above.

**Watch out.**
- `detectModel` is publicly re-exported from `src/server/index.ts:7`.
  External callers using `detectModel(somePath)` will silently start
  treating the path as a profile name. Document in the version-bump task
  (T8).
- The `homedir()` call here does NOT compose with the `env.HOME` override.
  Known limitation, deferred per design (v1 hedge — tests can bypass via
  `configPath`). Listed under "Out of scope" below; do not add a TODO that
  implies a tracked follow-up.

**Tests.** `typecheck` confirms callers updated. `build` clean.

**Builds on.** Nothing (parallel-able with T1, but easier to land after T1
so reviewers see the helper in context).

---

### T4: `execute.ts` Part A — profile arg, model fallback, detectModel call, sessionParams

**What.** Five inline edits in `execute()`:

1. **REPLACE line 319** (model fallback):
   ```ts
   const explicitModel = cfgString(config.model);
   const profile = cfgString(config.profile);
   const model = explicitModel ?? (profile ? undefined : DEFAULT_MODEL);
   ```

2. **REPLACE the `args` initialization at line 363**:
   ```ts
   const args: string[] = [];
   if (profile) args.push("-p", profile);
   args.push("chat", "-q", prompt);
   ```
   No comment needed about position — `-p` works anywhere per Hermes docs;
   leading position is just convention.

3. **REPLACE line 440 log call** to handle `model: undefined`:
   ```ts
   `[hermes] Starting Hermes Agent (model=${model ?? `<profile:${profile}>`}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
   ```

4. **REPLACE line 498** in the `executionResult` build:
   ```ts
   const executionResult: AdapterExecutionResult = {
     exitCode: result.exitCode,
     signal: result.signal,
     timedOut: result.timedOut,
     provider: resolvedProvider,
     // `model` is undefined when a profile is set and no override is given
     // — Paperclip surfaces null as "profile-decided" in the UI.
     model: model ?? null,
   };
   ```
   `AdapterExecutionResult.model` is `string | null` per
   `@paperclipai/adapter-utils` types — the `null` is type-compatible.

5. **REPLACE line 528** to persist profile alongside sessionId:
   ```ts
   executionResult.sessionParams = {
     sessionId: parsed.sessionId,
     profile: profile ?? null,
   };
   ```

**Where.** `src/server/execute.ts` only. `detectModel({ profile })` change
already landed in T3.

**Watch out.**
- `extraArgs` at line 407 still appends after our `-p`. If a user puts
  `-p other` in extraArgs, last-one-wins. **Add a one-line WHY-comment
  immediately above the `if (extraArgs?.length)` block at line 407**:
  ```ts
  // WHY: extraArgs are appended last — a `-p other` here will override
  // adapterConfig.profile (last-one-wins per Hermes CLI semantics).
  ```
  Also documented in the `extraArgs` row of `agentConfigurationDoc` at T8.
- Profile passes via the `args` array, not via env var. Don't set
  `env.HERMES_HOME` here.

**Tests.** `typecheck` + `build`. Smoke at T8 confirms `-p test-employee`
appears in the `[hermes] Starting…` log line.

**Builds on.** T3.

---

### T5: `execute.ts` Part B — session-resume profile-match guard + env.HERMES_HOME deletion

**Highest-risk task.** Splits from T4 because reviewers should see the
session-mismatch logic and the env mutation in isolation — both are
silent-failure foot-guns if mis-implemented.

**What.**

1. **REPLACE the resume block at lines 400-405**:
   ```ts
   // WHY: a session ID lives inside one profile's sessions DB. Resuming a
   // session ID from the OLD profile would either fail opaquely or
   // silently start fresh while Paperclip thinks it resumed. Drop the
   // resume in that case and log a notice.
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

2. **INSERT new block after line 426** (after `userEnv` merge, before the
   `cwd` block):
   ```ts
   // WHY: if env.HERMES_HOME is set alongside profile, the spawned child
   // sees a pre-set HERMES_HOME *and* receives -p, and Hermes's internal
   // precedence between them is undocumented. Drop the env var when
   // profile is active so -p is the single source of truth.
   if (profile && env.HERMES_HOME) {
     delete env.HERMES_HOME;
   }
   ```

**Where.** `src/server/execute.ts` only.

**Watch out.**
- The `delete` must run AFTER `buildPaperclipEnv(ctx.agent)` and after
  the `userEnv` spread. Verify `buildPaperclipEnv` doesn't reintroduce
  `HERMES_HOME` via a different mechanism (only confirmable when
  `@paperclipai/adapter-utils` is installed).
- The `prevProfile ?? null` normalization is intentional — `cfgString`
  returns `undefined`, but we want strict null for the equality check.
- Don't conflate the two changes when committing — same file, two
  conceptual changes; commit as one task with a clear message that names
  both.

**Tests.** `typecheck` + `build`. Smoke at T8 confirms the
`Skipping --resume` log line fires when profile is changed.

**Builds on.** T4.

---

### T6: Add `checkProfile` to `test.ts`

**What.** New check function plus wiring:

1. **Add imports** at the top of `src/server/test.ts`:
   ```ts
   import fs from "node:fs/promises";
   import path from "node:path";
   import { resolveHermesHome } from "./profile-paths.js";
   ```

2. **Add `checkProfile`** (before `testEnvironment`):
   ```ts
   async function checkProfile(
     config: Record<string, unknown>,
   ): Promise<AdapterEnvironmentCheck | null> {
     const profile = asString(config.profile);
     if (!profile) return null;

     const profilePath = resolveHermesHome(config);
     const stat = await fs.stat(profilePath).catch(() => null);
     if (!stat || !stat.isDirectory()) {
       // WHY: profile must pre-exist — Hermes won't auto-create it, and a
       // missing profile would silently fall back to defaults, masking
       // config drift. Surface the exact remediation command.
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

3. **Wire into `testEnvironment`** between step 1 and step 2 (inside the
   sequence at `test.ts:243-282`):
   ```ts
   // 1. CLI installed?  (existing)
   // ... existing block lines 251-262 unchanged ...

   // 1b. Profile valid?  (NEW)
   const profileCheck = await checkProfile(config);
   if (profileCheck) checks.push(profileCheck);
   // No early return — later checks (Python, API keys) still useful even
   // if profile is broken.

   // 2. CLI version  (existing)
   // ...
   ```

4. The `checkProviderConsistency` `detectModel` call at `test.ts:194` was
   already updated in T3.

**Where.** `src/server/test.ts` only.

**Watch out.** `checkProfile` returns `error` level for missing dir — that
flips `testEnvironment`'s overall status to `"fail"` (per the
`hasErrors` derivation at `test.ts:285`). That's intentional. Don't
suppress.

**Tests.** `typecheck` + `build`. Smoke at T8: set agent to a non-existent
profile name, run `testEnvironment`, confirm `hermes_profile_not_found`
returned with the suggested hint.

**Builds on.** T1, T3.

---

### T7: Update `sessionCodec` and `buildHermesConfig` pass-through

**What.** Two small wiring changes in different files.

1. **`src/server/index.ts`** — extend `sessionCodec` (lines 26-48) to
   round-trip `profile`:
   ```ts
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
   getDisplayId: unchanged
   ```

2. **`src/ui/build-config.ts`** — add a pass-through block before the
   `return ac` in `buildHermesConfig` (lines 22-87):
   ```ts
   // Hermes profile (JSON-only for v1; CreateConfigValues does not
   // currently expose a UI form field, so users set this via the JSON
   // config editor).
   if ("profile" in v && typeof (v as { profile?: unknown }).profile === "string") {
     const p = ((v as { profile?: string }).profile ?? "").trim();
     if (p) ac.profile = p;
   }
   ```

**Where.** `src/server/index.ts`, `src/ui/build-config.ts`.

**Watch out.**
- The `sessionCodec` change is backwards-compat: old `{sessionId}`
  payloads deserialize fine. Verify by inspecting the type — old shapes
  must still satisfy the codec's signature.
- `buildHermesConfig` pass-through is type-narrowed from `unknown` because
  the type is `CreateConfigValues` and may not declare `profile`. The
  cast is intentional.
- Zero in-repo callers exercise `sessionCodec` — round-trip only verifies
  via live Paperclip smoke at T8.

**Tests.** `typecheck` + `build`. Smoke at T8 confirms session resume
preserves profile across heartbeats.

**Builds on.** Independent of T2/T4/T5/T6 (parallel-able after T1).

---

### T8: Docs, version bump, smoke checklist

**What.**

1. **`src/index.ts`** — update `agentConfigurationDoc` template
   (lines 29-84):
   - Insert "Profile (recommended)" section above "Core Configuration"
     per the design doc.
   - Tweak the `model` row description (line 44): _"Optional explicit
     model override. When `profile` is set, the profile's `config.yaml`
     decides if this is empty."_
   - Add a note to the `extraArgs` row about `-p` ordering: _"Note: any
     `-p` flag in extraArgs overrides the profile field (last-one-wins
     per Hermes)."_

2. **`README.md`** — new "Profiles" section after "Configuration
   Reference" (around line 103):
   - One-paragraph intro: each Paperclip employee can be backed by a
     Hermes profile.
   - Pre-creation snippet: `hermes profile create <name>` then
     `hermes -p <name> setup`, then customize SOUL.md.
   - Example `adapterConfig` with `profile`.
   - Sub-section "Sharing a profile across employees" — note that
     memory/skills/SOUL.md are shared; sessions are not.

3. **`package.json`** — bump version `0.3.0` → `0.4.0` (minor, since the
   `detectModel` API break is contained and behavior is otherwise additive).

4. **`sessionCodec` shape sanity check** — before the live smoke, run a
   one-liner to catch obvious shape regressions (the codec has zero
   in-repo callers, so types alone won't catch a wrong return shape):
   ```bash
   node --input-type=module -e "import('./dist/server/index.js').then(m => {
     const sc = m.sessionCodec;
     console.log(sc.serialize({ sessionId: 'abc' }));            // → {sessionId:'abc'}
     console.log(sc.serialize({ sessionId: 'abc', profile: 'x' })); // → {sessionId:'abc',profile:'x'}
     console.log(sc.deserialize({ sessionId: 'abc' }));          // → {sessionId:'abc'}
     console.log(sc.deserialize({ sessionId: 'abc', profile: 'x' })); // → {sessionId:'abc',profile:'x'}
   })"
   ```

5. **Smoke checklist** — add `docs/plans/2026-05-15-hermes-profile-support-smoke.md`
   (or include verbatim in the eventual PR body) with the validation
   steps from the design doc:
   - Install Hermes; create profile; customize SOUL.md
   - Register adapter; create agent with `profile: "test-employee"`
   - Trigger heartbeat; confirm `-p` in `[hermes]` log
   - Confirm SOUL.md persona shows in response
   - Confirm `listSkills` includes `originLabel: "Hermes skill (profile: test-employee)"`
   - Set agent to non-existent profile → confirm `hermes_profile_not_found`
   - Change profile mid-session → confirm `Skipping --resume` log line

**Where.** `src/index.ts`, `README.md`, `package.json`,
`docs/plans/2026-05-15-hermes-profile-support-smoke.md` (new).

**Watch out.** The `agentConfigurationDoc` is consumed by the Paperclip UI
to render a help panel. If consumers pin its content (length, hash), the
content change will be visible. Acceptable.

**Tests.** Read the README diff, render `agentConfigurationDoc` mentally
to make sure markdown is valid. Run the smoke checklist after merge.

**Builds on.** Everything (T1–T7).

---

## Task ordering & parallelism

```
T1 (profile-paths.ts)
 ├── T2 (skills.ts)              ─┐
 ├── T3 (detectModel sig)        ─┤
 │   ├── T4 (execute.ts part A)  ─┤  ─→  T8 (docs + version + smoke)
 │   │   └── T5 (execute.ts part B)
 │   └── T6 (test.ts checkProfile)
 └── T7 (sessionCodec + build-config) ─┘
```

T2, T3, T7 can land in parallel after T1. T4 must follow T3 (uses the new
signature). T5 follows T4 (same file). T6 follows T3 (uses the new
signature) and T1 (uses the helper). T8 is last.

If executing sequentially: **T1 → T3 → T2 → T6 → T4 → T5 → T7 → T8**.

## Testing Strategy

No automated tests exist. Per-task verification:

- **Per-task gate**: `npm run typecheck` clean. `npm run build` clean.
- **End-to-end smoke** (T8): run the manual checklist against a live
  Paperclip + Hermes install. Each item is a falsifiable observation.

If the project ever adopts a test framework (vitest is the natural fit
given the ESM + TypeScript setup), the highest-leverage targets would be:

1. `resolveHermesHome` — pure function, easy unit test for profile + no-profile + env.HOME-override branches
2. `sessionCodec` — pure round-trip; no I/O
3. `parseModelFromConfig` (already exists) — currently untested

Out of scope for this PR.

## Risks

- **`@paperclipai/adapter-utils` not installed locally** — the
  `runChildProcess` env contract and `buildPaperclipEnv` env contributions
  are inferred from usage, not verified against types. Implementer must
  run `npm install` before T5 to validate the `delete env.HERMES_HOME`
  block doesn't get clobbered by `buildPaperclipEnv`.
- **`AdapterExecutionResult.model` type** may not accept `null` — if
  TypeScript rejects the T4 change, fall back to `model: model || ""`
  (empty-string sentinel).
- **`detectModel` API break is silent for downstream consumers** — anyone
  importing `detectModel(somePath)` from the package's `./server` subpath
  will silently mis-route. T8 must include a CHANGELOG entry naming this
  break.
- **Sequence sensitivity of `delete env.HERMES_HOME`** (T5) — if
  `buildPaperclipEnv` sets HERMES_HOME, the delete order must be after.
  Any future change that re-orders env composition could silently break
  this.
- **`model: null` UI rendering ambiguity** (T4) — when a profile owns the
  default, `executionResult.model` is `null`. Paperclip's UI may render
  this as "no model" rather than "profile-decided". Cosmetic, but worth
  monitoring during smoke. Mitigation if it looks bad: switch to an
  explicit sentinel string like `\`(profile: ${profile})\`` in T4 step 4.
- **Smoke verification is manual** — no CI signal will catch a regression
  to the profile flow. Mitigation: T8 produces a checklist that lives
  next to the design doc; reviewers can re-run it.

## Out of scope (deferred)

- Profile auto-creation
- Personality (`/personality NAME`) plumbing
- SOUL.md editing through Paperclip UI
- Profile distribution / publishing
- Multiple profiles per agent
- Test framework introduction
- `detectModel` honoring `env.HOME` override (hedge accepted in T3)
