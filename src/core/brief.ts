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
  // Only a bot has durable memory to keep. `truss run` has no bot, so asking
  // for memory.md there just drops a stray file in whatever repo you ran in.
  if (input.identity) {
    parts.push(
      [
        "Keep `.truss/memory.md` current as you work: plan, decisions made,",
        "what's left. Truss reads that file back into your durable memory when",
        "the run ends, and it is the only thing that survives to your next turn",
        "or to another backend picking this up.",
      ].join(" "),
    );
  }
  return parts.filter(Boolean).join("\n");
}
