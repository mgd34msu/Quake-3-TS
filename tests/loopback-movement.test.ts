import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Product } from "../src/shared/definitions.ts";
import { ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import { runMovementLoopback } from "../tools/verify-loopback.ts";

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const hasBase = await Bun.file(join(dataPath, "baseq3/pak0.pk3")).exists();
const hasMissionpack = hasBase && await Bun.file(join(dataPath, "missionpack/pak0.pk3")).exists();
const products: Product[] = ["baseq3", "missionpack"];

describe("static BSP movement through protocol-68 loopback", () => {
  test("rejects invalid replay boundaries before accessing retail data", async () => {
    for (const frames of [0, 124, 125.5, 10001, NaN, Infinity]) {
      await expect(runMovementLoopback({ dataPath: "/missing-retail-data", product: "baseq3", mapName: "q3dm1", frames })).rejects.toThrow("frames");
    }
    for (const mapName of ["", "../q3dm1", "maps/q3dm1", "q3dm1.bsp"]) {
      await expect(runMovementLoopback({ dataPath: "/missing-retail-data", product: "baseq3", mapName, frames: 125 })).rejects.toThrow("bare BSP");
    }
  });

  test("CLI rejects malformed options and fails nonzero", () => {
    for (const args of [["--frames", "124"], ["--product", "invalid"], ["--map"], ["--unknown", "value"]]) {
      const process = Bun.spawnSync(["bun", "tools/verify-loopback.ts", ...args], { stdout: "pipe", stderr: "pipe" });
      expect(process.exitCode).toBe(1);
      expect(process.stderr.length).toBeGreaterThan(0);
      expect(process.stdout.length).toBe(0);
    }
  });

  for (const product of products) {
    const available = product === "baseq3" ? hasBase : hasMissionpack;
    const mapName = product === "baseq3" ? "q3dm1" : "mpteam1";
    test.skipIf(!available)(`${product}: real fragmented gamestate, bidirectional loss recovery and owned snapshots`, async () => {
      const report = await runMovementLoopback({ dataPath, product, mapName, frames: 200 });
      expect(report.scope).toBe("static-bsp-movement-protocol-probe");
      expect(report.product).toBe(product);
      expect(report.mapName).toBe(mapName);
      expect(report.mapSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.gamestateBytes).toBeGreaterThanOrEqual(1300);
      expect(report.packets.fragments).toBe(5);
      expect(report.packets.clientDrops).toBe(1);
      expect(report.packets.serverDrops).toBe(1);
      expect(report.packets.clientPackets).toBe(201);
      expect(report.packets.serverPackets).toBe(205);
      expect(report.packets.clientBytes).toBeGreaterThan(4000);
      expect(report.packets.serverBytes).toBeGreaterThan(10000);
      expect(report.packets.deliveredMessages).toBe(400);
      expect(report.executedUserCommands).toBe(200);
      expect(report.ignoredBackupCommands).toBe(394);
      expect(report.clientCommandsExecuted).toBe(3);
      expect(report.serverCommandsReceived).toBe(2);
      expect(report.snapshotsCompared).toBe(199);
      expect(report.fullSnapshots).toBe(2);
      expect(report.deltaSnapshots).toBe(198);
      expect(report.ownershipChecks).toBeGreaterThan(790);
      for (const passed of Object.values(report.gates)) expect(passed).toBe(true);
      expect(report.sourceZeroNormalizations).toEqual([]);
      expect(report.sourceLocalFieldDifferences.map(difference => difference.field).sort()).toEqual(["entityEventSequence", "pmoveFramecount"]);
      expect(report.finalState.commandTime).toBe(1600);
      expect(report.finalState.health).toBe(125);
      expect(report.finalState.pmTime).toBe(0);
      expect(report.finalState.weaponTime).toBe(0);
      expect(report.finalState.groundEntityNum).toBe(ENTITYNUM_WORLD);
      expect(report.finalState.velocity.z).toBe(0);
      expect(report.finalState.eventSequence).toBeGreaterThan(0);
    }, 20000);

    test.skipIf(!available)(`${product}: minimum replay is deterministic across isolated endpoints`, async () => {
      const first = await runMovementLoopback({ dataPath, product, mapName, frames: 125 });
      const second = await runMovementLoopback({ dataPath, product, mapName, frames: 125 });
      expect(first).toEqual(second);
      expect(first.executedUserCommands).toBe(125);
      expect(first.snapshotsCompared).toBe(124);
      expect(first.finalState.commandTime).toBe(1000);
      expect(first.gates["clientInputRecovered"]).toBe(true);
      expect(first.gates["serverDeltaRecovered"]).toBe(true);
      expect(first.gates["fullSnapshotRecovery"]).toBe(true);
      expect(first.gates["independentCopies"]).toBe(true);
      first.finalState.origin.x = 99999;
      expect(second.finalState.origin.x).not.toBe(99999);
    }, 20000);
  }
});
