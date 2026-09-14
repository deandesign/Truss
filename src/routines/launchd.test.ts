import { describe, expect, it } from "vitest";
import { parseCron, renderPlist } from "./launchd.js";

describe("routines", () => {
  it("parses a simple weekday cron", () => {
    expect(parseCron("0 9 * * 1-5")).toEqual({
      minute: 0,
      hour: 9,
      weekday: undefined,
      weekdays: [1, 2, 3, 4, 5],
    });
  });

  it("renders a LaunchAgent that calls truss routines run", () => {
    const xml = renderPlist(
      {
        id: "morning",
        bot: "builder",
        prompt: "triage",
        cwd: "/Users/dean/proj",
        hour: 9,
        minute: 0,
        weekday: 1,
      },
      "/usr/bin/node",
      "/opt/truss/dist/cli.js",
    );
    expect(xml).toContain("com.truss.routine.morning");
    expect(xml).toContain("<string>routines</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toContain("<string>morning</string>");
    expect(xml).toContain("<key>Hour</key><integer>9</integer>");
    expect(xml).toContain("<key>Weekday</key><integer>1</integer>");
    expect(xml).toContain("/Users/dean/proj");
  });

  it("expands weekday ranges into calendar intervals", () => {
    const xml = renderPlist(
      {
        id: "morning",
        bot: "builder",
        prompt: "triage",
        cwd: "/tmp",
        hour: 9,
        minute: 0,
        weekdays: [1, 2, 3, 4, 5],
      },
      "/usr/bin/node",
      "/opt/truss/dist/cli.js",
    );
    expect(xml).toContain("<key>Weekday</key><integer>5</integer>");
    expect(xml.match(/StartCalendarInterval/g)).toHaveLength(1);
  });
});
