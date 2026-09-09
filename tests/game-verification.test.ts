import { describe, expect, test } from "bun:test";
import { verifyGame } from "../tools/verify-game.ts";
import type { Product } from "../src/shared/definitions.ts";

test("game verifier rejects unsafe map paths before reading assets", async () => {
  for (const name of ["../q3dm1", "/tmp/q3dm1", "q3dm1.bsp", "", "map;quit"]) {
    await expect(verifyGame({ dataPath: "/missing-game-verifier-fixture", product: "baseq3", deathmatchMap: name }))
      .rejects.toThrow("bare BSP map name");
  }
});

describe.skipIf(process.env["Q3_DATA"] === undefined)("controlled retail GameRuntime verification", () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product} executes deterministic FFA and capture scenarios`, async () => {
      const dataPath = process.env["Q3_DATA"];
      if (dataPath === undefined) throw new Error("Q3_DATA required for retail game verification");
      const report = await verifyGame({ dataPath, product });
      expect(report.scope).toBe("controlled-headless-retail-game-runtime");
      expect(report.results.map(result => result.mode)).toEqual(["ffa", "ctf"]);
      expect(report.excluded).toContain("execution of the queued next-map engine command");
      for (const result of report.results) {
        expect(result.mapSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(result.replaySha256).toMatch(/^[a-f0-9]{64}$/);
        expect(result.independentSeededReplay).toBe(true);
        expect(Object.values(result.gates).every(Boolean)).toBe(true);
        expect(result.gates["restartReadsSavedSession"]).toBe(true);
        expect(result.gates["weaponCommandsConsumeAmmo"]).toBe(true);
        expect(result.consoleCommands).toContain("vstr nextmap\n");
        expect(result.checkpoints[0]?.name).toBe("admitted");
        expect(result.checkpoints.at(-1)?.name).toBe("nextmap-requested");
      }
    }, 30000);
  }
});
