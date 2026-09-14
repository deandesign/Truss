import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { skillsDir } from "../core/paths.js";

export interface Skill {
  id: string;
  title: string;
  body: string;
}

export function parseSkill(id: string, markdown: string): Skill {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const body = match ? match[2] : markdown;
  const head = match ? match[1] : "";
  const titleLine = head
    .split("\n")
    .find((l) => l.startsWith("title:"));
  return {
    id,
    title: titleLine ? titleLine.slice(6).trim() : id,
    body: body.trim(),
  };
}

export function listSkills(): Skill[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) =>
      parseSkill(f.replace(/\.md$/, ""), readFileSync(join(dir, f), "utf8")),
    );
}

export function loadSkill(id: string): Skill | undefined {
  const file = join(skillsDir(), `${id}.md`);
  if (!existsSync(file)) return undefined;
  return parseSkill(id, readFileSync(file, "utf8"));
}

export function saveSkill(skill: Skill): void {
  mkdirSync(skillsDir(), { recursive: true });
  writeFileSync(
    join(skillsDir(), `${skill.id}.md`),
    `---\ntitle: ${skill.title}\n---\n\n${skill.body.trim()}\n`,
  );
}

export function skillFromMessage(message: string): { skill?: Skill; rest: string } {
  const match = message.match(/^\/([a-z0-9-]+)\s*([\s\S]*)$/i);
  if (!match) return { rest: message };
  const skill = loadSkill(match[1]);
  return { skill, rest: match[2].trim() || message };
}

export const DEFAULT_SKILLS: Skill[] = [
  {
    id: "review-pr",
    title: "Review a pull request",
    body: `Read the diff. Report:
- what changed, in one paragraph
- risks
- missing tests
- a merge recommendation (yes / yes with nits / no)

Do not push or merge.`,
  },
  {
    id: "daily-triage",
    title: "Daily triage",
    body: `Look at git status, recent commits, and open failures if tests exist.
Write a short plan for the day into memory.md. Do not start large refactors.`,
  },
];
