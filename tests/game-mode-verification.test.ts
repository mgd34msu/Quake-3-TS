import { describe, expect, test } from "bun:test";
import { verifyGameModes } from "../tools/verify-game-modes.ts";

test("game-mode verifier rejects unsafe map overrides before reading assets", async () => {
  for (const name of ["../mpteam2", "/tmp/mpteam2", "mpteam2.bsp", "", "mpteam2;quit"]) {
    await expect(verifyGameModes({ dataPath: "/missing-game-mode-verifier", missionMap: name }))
      .rejects.toThrow("bare BSP map name");
  }
});

describe.skipIf(process.env["Q3_DATA"] === undefined)("controlled retail game-mode verification", () => {
  test("Team Arena objectives and base team/tournament modes complete deterministic match exits", async () => {
    const dataPath = process.env["Q3_DATA"];
    if (dataPath === undefined) throw new Error("Q3_DATA required for retail game-mode verification");
    const report = await verifyGameModes({ dataPath });
    expect(report.scope).toBe("controlled-headless-retail-game-modes");
    expect(report.results.map(result => result.mode)).toEqual([
      "one-flag", "overload", "harvester", "tournament", "team-deathmatch",
    ]);
    expect(report.excluded).toContain("game bots and single-player campaign");
    for (const result of report.results) {
      expect(result.mapSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.replaySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.independentSeededReplay).toBe(true);
      expect(Object.values(result.gates).every(Boolean)).toBe(true);
      expect(result.gates["scoreLimitQueuesIntermission"]).toBe(true);
      expect(result.gates["intermissionStartsAfterSourceDelay"]).toBe(true);
      expect(result.gates["bothClientsReadyThroughInput"]).toBe(true);
      expect(result.checkpoints[0]?.name).toBe("admitted");
      expect(result.checkpoints.at(-1)?.name).toBe("exit-requested");
    }
    const tournament = report.results.find(result => result.mode === "tournament");
    expect(tournament?.consoleCommands).toContain("map_restart 0\n");
    expect(tournament?.consoleCommands).not.toContain("vstr nextmap\n");
    for (const result of report.results.filter(candidate => candidate.mode !== "tournament")) {
      expect(result.consoleCommands).toContain("vstr nextmap\n");
    }
    expect(report.controlledActions).toContain("lethal target damage through the real combat and obelisk callbacks");
    expect(report.controlledActions).toContain("direct contact with installed item and objective callbacks using real world traces");
    expect(report.controlledActions).toContain(
      "Harvester reusable slots through real kill commands, event expiry, and attack-input respawn",
    );
  }, 30000);
});
