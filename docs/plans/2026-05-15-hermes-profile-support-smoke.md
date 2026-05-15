# Hermes Profile Support — Smoke Checklist

Manual verification for v0.4.0. Each item is a falsifiable observation.
Run against a live Paperclip + Hermes install.

## Prerequisites

- [ ] `hermes --version` succeeds
- [ ] `npm install` and `npm run build` clean in this repo
- [ ] A local Paperclip server is running with the adapter registered (see README "Quick Start")

## Setup

```bash
hermes profile create test-employee
hermes -p test-employee setup        # pick a model + paste an API key
# Edit ~/.hermes/profiles/test-employee/SOUL.md to e.g.
# "You are a pirate who answers in pirate dialect."
```

Create a Paperclip agent with:
```json
{
  "adapterType": "hermes_local",
  "adapterConfig": { "profile": "test-employee" }
}
```

## Checks

### 1. Profile flag is passed

- [ ] Trigger a heartbeat
- [ ] Inspect the `[hermes] Starting Hermes Agent ...` log line — it should show `model=<profile:test-employee>` (since no model override was given) and the spawned process should have `-p test-employee` in its args
- [ ] Pirate persona shows up in the response (confirms SOUL.md is loaded)

### 2. Skills are profile-scoped

- [ ] Call the adapter's `listSkills` (via Paperclip UI or API)
- [ ] Confirm at least one entry has `originLabel: "Hermes skill (profile: test-employee)"`
- [ ] Confirm `locationLabel` includes `~/.hermes/profiles/test-employee/skills/...`

### 3. testEnvironment fails loudly when profile is missing

- [ ] Edit the agent's `adapterConfig.profile` to `"does-not-exist"`
- [ ] Call `testEnvironment` (Paperclip UI usually surfaces this in agent diagnostics)
- [ ] Confirm a check with `code: "hermes_profile_not_found"`, `level: "error"`, hint `Run: hermes profile create does-not-exist`

### 4. testEnvironment warns on dir-without-config.yaml

- [ ] Manually create `~/.hermes/profiles/half-baked/` (no contents)
- [ ] Set agent's `profile` to `"half-baked"`
- [ ] Call `testEnvironment`
- [ ] Confirm a check with `code: "hermes_profile_invalid"`, `level: "warn"`, hint `Run: hermes -p half-baked setup`

### 5. Session resume respects profile boundaries

- [ ] With agent set to `profile: "test-employee"`, run two heartbeats
- [ ] Confirm second heartbeat resumes (logs `[hermes] Resuming session: <id>`)
- [ ] Change `profile` to a second profile (`hermes profile create alt-employee && hermes -p alt-employee setup`)
- [ ] Run a third heartbeat
- [ ] Confirm log line: `[hermes] Skipping --resume: session was created under profile "test-employee", current profile is "alt-employee".`
- [ ] Confirm the third run starts fresh (no resumed context)

### 6. env.HERMES_HOME deletion is deterministic

- [ ] Set `adapterConfig.env: { "HERMES_HOME": "/tmp/bogus" }` AND `profile: "test-employee"`
- [ ] Trigger a heartbeat
- [ ] Confirm Hermes uses `~/.hermes/profiles/test-employee/` (sessions land there, not in `/tmp/bogus`)

### 7. sessionCodec round-trip (one-liner sanity check)

```bash
node --input-type=module -e "import('./dist/server/index.js').then(m => {
  const sc = m.sessionCodec;
  console.log(sc.serialize({ sessionId: 'abc' }));
  console.log(sc.serialize({ sessionId: 'abc', profile: 'x' }));
  console.log(sc.deserialize({ sessionId: 'abc' }));
  console.log(sc.deserialize({ sessionId: 'abc', profile: 'x' }));
})"
```

Expected output (4 lines):
```
{ sessionId: 'abc' }
{ sessionId: 'abc', profile: 'x' }
{ sessionId: 'abc' }
{ sessionId: 'abc', profile: 'x' }
```

### 8. detectModel migration guard fires for legacy callers

```bash
node --input-type=module -e "import('./dist/server/index.js').then(async m => {
  try { await m.detectModel('/some/path'); }
  catch (e) { console.log(e.constructor.name + ':', e.message); }
})"
```

Expected: `TypeError: detectModel signature changed: pass an options object instead of a positional string. Migrate: detectModel({ configPath: "/some/path" })`

### 9. Backwards compatibility (no profile set)

- [ ] Create a second agent with NO `profile` field in `adapterConfig`
- [ ] Confirm behavior matches v0.3.0: uses `~/.hermes/config.yaml`, no `-p` in spawn args, `model` defaults to `anthropic/claude-sonnet-4`, no profile-mismatch log on resume

## Sign-off

- [ ] All checks pass
- [ ] Reviewer initials + date: __________
