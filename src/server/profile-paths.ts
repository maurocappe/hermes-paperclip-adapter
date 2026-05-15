import path from "node:path";
import os from "node:os";

/** Returns the trimmed profile name from a config blob, or null if absent.
 *  Centralized so every site using a profile name applies the same
 *  trimming + emptiness rule (avoids drift if validation tightens later). */
export function resolveProfileName(config: Record<string, unknown>): string | null {
  return typeof config.profile === "string" && config.profile.trim()
    ? config.profile.trim()
    : null;
}

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

  const profile = resolveProfileName(config);
  return profile
    ? path.join(baseHome, ".hermes", "profiles", profile)
    : path.join(baseHome, ".hermes");
}
