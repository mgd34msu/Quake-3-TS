import { expect, test } from "bun:test";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { parseBsp } from "../src/assets/bsp.ts";
import { LocalPlayer } from "../src/engine/local-player.ts";
import { ENTITYNUM_WORLD } from "../src/shared/player-state.ts";

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const retail = await Bun.file(`${dataPath}/baseq3/pak0.pk3`).exists();

test.skipIf(!retail)("source movement settles, jumps and lands on a retail BSP", async () => {
  const vfs = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product: "baseq3" });
  const map = parseBsp(await vfs.read("maps/q3dm1.bsp"));
  const player = new LocalPlayer(map, "baseq3");
  // Captured upstream ClientSpawn's -100..0 Pmove command against a flat floor.
  expect(player.state.commandTime).toBe(0);
  expect(player.state.pmoveFramecount).toBe(1);
  expect(player.state.origin.z).toBe(Math.fround(28.9932003));
  expect(player.state.velocity.z).toBe(-80);
  expect(player.state.pmTime).toBe(0);
  const yaw = Math.trunc(player.state.viewangles.y * 65536 / 360) & 65535;
  let time = 0;
  function advance(upmove = 0): void {
    time += 8;
    player.advance({ serverTime: time, angles: { x: 0, y: yaw, z: 0 }, buttons: 0, weapon: player.state.weapon, forwardmove: 0, rightmove: 0, upmove });
  }
  for (let index = 0; index < 125; index++) advance();
  expect(player.state.groundEntityNum).toBe(ENTITYNUM_WORLD);
  expect(player.state.velocity.z).toBe(0);
  const floor = player.state.origin.z;
  advance(127);
  expect(player.state.velocity.z).toBeGreaterThan(250);
  let highest = player.state.origin.z;
  for (let index = 0; index < 150; index++) { advance(); highest = Math.max(highest, player.state.origin.z); }
  expect(highest - floor).toBeGreaterThan(40);
  expect(player.state.groundEntityNum).toBe(ENTITYNUM_WORLD);
  expect(player.state.origin.z).toBeCloseTo(floor, 2);
  expect(player.state.eventSequence).toBeGreaterThan(0);
  expect(player.camera.origin.z - player.state.origin.z).toBe(26);
}, 20000);
