export interface BriefInput {
  task: string;
  identity?: string;
  memory?: string;
  skill?: string;
  transcript?: string;
  handoff?: {
    from: string;
    diffstat?: string;
    partial?: string;
  };
}

function section(title: string, body?: string): string {
  if (!body?.trim()) return "";
  return `## ${title}\n\n${body.trim()}\n`;
}

export function buildBrief(input: BriefInput): string {
  const parts = [
    section("Task", input.task),
    section("Bot", input.identity),
    section("Memory", input.memory),
    section("Skill", input.skill),
    section("Recent transcript", input.transcript),
  ];
  if (input.handoff) {
    parts.push(
      section(
        "Handoff",
        [
          `A previous backend (${input.handoff.from}) stopped after exhausting quota.`,
          "Continue. Do not redo completed work. Keep what is already correct.",
          input.handoff.diffstat
            ? `Working tree diffstat:\n${input.handoff.diffstat}`
            : "",
          input.handoff.partial
            ? `Partial result from the previous backend:\n${input.handoff.partial}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    );
  }
  parts.push(
    "Keep `memory.md` current as you work: plan, decisions made, what's left.",
  );
  return parts.filter(Boolean).join("\n");
}
