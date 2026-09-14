import type { Capabilities, Cost } from "../backends/types.js";
import type { RunManifest } from "./manifest.js";

export function formatCost(cost: Cost | undefined, capabilities?: Capabilities): string {
  if (!cost) {
    if (capabilities && !capabilities.reportsCost && !capabilities.reportsTokens) {
      return "cost unknown (backend does not report spend)";
    }
    return "cost unknown";
  }
  const bits: string[] = [];
  if (typeof cost.usd === "number") bits.push(`$${cost.usd.toFixed(4)} known`);
  if (cost.tokens?.input || cost.tokens?.output) {
    bits.push(
      `tokens in=${cost.tokens.input ?? "?"} out=${cost.tokens.output ?? "?"}`,
    );
  }
  if (bits.length === 0) return "cost unknown";
  if (typeof cost.usd !== "number") bits.push("usd unknown");
  return bits.join(", ");
}

export function formatReport(manifest: RunManifest): string {
  const lines = [
    `run ${manifest.id}  ${manifest.finalOutcome}`,
    `task: ${manifest.task.split("\n")[0]}`,
    "",
  ];
  let knownUsd = 0;
  let anyUsd = false;
  let anyUnknown = false;
  for (const step of manifest.steps) {
    const cost = formatCost(step.cost);
    if (typeof step.cost?.usd === "number") {
      knownUsd += step.cost.usd;
      anyUsd = true;
    } else {
      anyUnknown = true;
    }
    lines.push(
      `  ${step.backendId.padEnd(12)} ${step.outcome.padEnd(16)} ${step.durationMs}ms  ${cost}`,
    );
  }
  lines.push("");
  if (anyUsd && anyUnknown) {
    lines.push(`known spend: $${knownUsd.toFixed(4)}  (incomplete — some backends report no usd)`);
  } else if (anyUsd) {
    lines.push(`known spend: $${knownUsd.toFixed(4)}`);
  } else {
    lines.push("known spend: none reported");
  }
  return lines.join("\n");
}
