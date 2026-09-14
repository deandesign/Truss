import { probeVersion, which } from "../core/which.js";
import type { Availability } from "./types.js";

/**
 * Shared availability check. All three adapters answer this the same way, and
 * the only honest answer about auth is "unknown" — none of the CLIs report it
 * without a billable call, so the router discovers it from a run's outcome.
 */
export async function checkAvailability(
  binary: string,
): Promise<Availability> {
  const binaryPath = await which(binary);
  if (!binaryPath) {
    return {
      installed: false,
      usable: false,
      authed: "unknown",
      detail: `${binary} not on PATH`,
    };
  }
  const probe = await probeVersion(binary);
  return {
    installed: true,
    usable: probe.ok,
    authed: "unknown",
    binaryPath,
    detail: probe.ok
      ? probe.detail
      : `${binary} is installed but will not run: ${probe.detail}`,
  };
}
