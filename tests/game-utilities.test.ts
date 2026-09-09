import { expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { EntityPool } from "../src/game/entities.ts";
import { ConnectionState } from "../src/game/state.ts";
import { Team } from "../src/shared/definitions.ts";
import { ConfigStringRegistry, findEntity, moveDirection, pickTarget, teamCommand, useTargets } from "../src/game/utilities.ts";

function fixture() {
  const pool = new EntityPool({ print: text => { warnings.push(text); }, product: "baseq3", maxClients: 4, mapStartTime: 0, time: () => 2500,
    link: () => {}, unlink: () => {} });
  const warnings: string[] = [], remaps: string[] = [];
  const context = { pool, time: 2500, randomInt: () => 31, warn: (message: string) => { warnings.push(message); },
    remapShader: (oldName: string, newName: string, time: number) => { remaps.push(`${oldName}:${newName}:${time}`); } };
  return { pool, warnings, remaps, context };
}

test("G_SetMovedir preserves the original QVM folded angle constant", () => {
  // Original G_SetMovedir/q_math.c in vm_game=1, weapon-run.sh VECTOR602 in
  // /tmp/quake3-game-angle-migration-HHP9ie; negative-zero bits also checked by the raw angle oracle.
  const result = moveDirection(vec3(0, 8.26171875, 0));
  expect([result.direction.x, result.direction.y, result.direction.z].map(float32ToBits))
    .toEqual([0x3f7d57de, 0x3e1324ca, 0x80000000]);
  expect(result.angles).toEqual(vec3(0, 0, 0));
});

test("configstring indices preserve source holes, case sensitivity, limits and byte-string semantics", () => {
  const strings = new Map<number, string>(), writes: number[] = [];
  const registry = new ConfigStringRegistry({ get: index => strings.get(index) ?? "",
    set: (index, value) => { strings.set(index, value); writes.push(index); } });
  expect(registry.modelIndex(null)).toBe(0);
  expect(registry.modelIndex("")).toBe(0);
  expect(registry.modelIndex("model.md3")).toBe(1);
  expect(registry.modelIndex("model.md3\0ignored")).toBe(1);
  expect(registry.modelIndex("MODEL.md3")).toBe(2);
  expect(registry.soundIndex("sound.wav")).toBe(1);
  expect(writes).toEqual([33, 34, 289]);
  strings.set(37, "beyond-gap");
  expect(registry.find("beyond-gap", 32, 256, false)).toBe(0);
  expect(registry.find("beyond-gap", 32, 256, true)).toBe(3);
  strings.set(501, "one"); strings.set(502, "two");
  expect(registry.find("missing", 500, 3, false)).toBe(0);
  expect(() => registry.find("missing", 500, 3, true)).toThrow("overflow");
  expect(() => registry.find("name", 1023, 2, true)).toThrow(RangeError);
  expect(() => registry.modelIndex("not-byte-\u0100")).toThrow(RangeError);
});

test("configstring lookup uses the source1023-byte temporary buffer, not the complete stored value", () => {
  const longName = "a".repeat(1024), strings = new Map([[101, longName]]);
  const registry = new ConfigStringRegistry({ get: index => strings.get(index) ?? "", set: (index, value) => { strings.set(index, value); } });
  expect(registry.find(longName, 100, 4, false)).toBe(0);
  expect(registry.find(longName.slice(0, 1023), 100, 4, false)).toBe(1);
  expect(registry.find(longName, 100, 4, true)).toBe(2);
});

test("entity search walks live slots, skips inactive records and folds only ASCII letters", () => {
  const { pool } = fixture();
  const inactive = pool.spawn(), first = pool.spawn(), second = pool.spawn(), high = pool.spawn();
  inactive.targetname = "target"; inactive.inuse = false;
  first.targetname = "Target"; second.targetname = "TARGET"; high.targetname = "\u00c0";
  expect(findEntity(pool, null, "targetname", "target")).toBe(first);
  expect(findEntity(pool, first, "targetname", "target")).toBe(second);
  expect(findEntity(pool, second, "targetname", "target")).toBeNull();
  expect(findEntity(pool, null, "targetname", "\u00e0")).toBeNull();
  expect(findEntity(pool, null, "targetname", null)).toBeNull();
});

test("target selection uses the first32 matches and integer remainder", () => {
  const { pool, context, warnings } = fixture();
  const matches = Array.from({ length: 35 }, () => { const entity = pool.spawn(); entity.targetname = "many"; return entity; });
  const lastEligible = matches[31];
  if (lastEligible === undefined) throw new Error("Target fixture must provide32 matches");
  expect(pickTarget(context, "MANY")).toBe(lastEligible);
  expect(pickTarget({ ...context, randomInt: () => 32767 }, "many")).toBe(lastEligible);
  expect(pickTarget(context, null)).toBeNull();
  expect(pickTarget(context, "absent")).toBeNull();
  expect(warnings).toEqual(["G_PickTarget called with NULL targetname\n", "G_PickTarget: target absent not found\n"]);
});

test("target dispatch remaps first, observes target mutation and stops when the source is freed", () => {
  const { pool, context, remaps, warnings } = fixture();
  const source = pool.spawn(), first = pool.spawn(), ignored = pool.spawn(), next = pool.spawn();
  source.target = "first"; source.targetShaderName = "old"; source.targetShaderNewName = "new";
  first.targetname = "first"; ignored.targetname = "first"; next.targetname = "second";
  const calls: number[] = [];
  first.use = (self, other, activator) => {
    expect(other).toBe(source); expect(activator).toBe(pool.at(0)); expect(remaps).toEqual(["old:new:2.5"]);
    calls.push(self.slot); source.target = "second";
  };
  ignored.use = self => { calls.push(self.slot); };
  next.use = self => { calls.push(self.slot); pool.free(source); };
  useTargets(context, source, pool.at(0));
  expect(calls).toEqual([first.slot, next.slot]);
  expect(warnings).toEqual(["entity was removed while using targets\n"]);
  useTargets(context, null, null);
});

test("target dispatch rounds shader time through the QVM float instructions", () => {
  const { pool, context } = fixture();
  const source = pool.spawn();
  source.targetShaderName = "old";
  source.targetShaderNewName = "new";
  const remapTimes: number[] = [];
  useTargets({ ...context, time: 5, remapShader: (_oldName, _newName, time) => { remapTimes.push(time); } }, source, null);
  // Unchanged g_utils.c emits CNSTF4 981668463, CVIF4 4, MULF4, ASGNF4.
  expect(remapTimes).toEqual([0.005000000353902578]);
});

test("target dispatch warns on self-use and sees appended source slots", () => {
  const { pool, context, warnings } = fixture();
  const source = pool.spawn(), first = pool.spawn();
  source.target = "target"; source.targetname = "target"; first.targetname = "target";
  const calls: number[] = [];
  source.use = () => { throw new Error("Self must not be used"); };
  first.use = self => { calls.push(self.slot); const appended = pool.spawn(); appended.targetname = "target"; appended.use = entity => { calls.push(entity.slot); }; };
  useTargets(context, source, null);
  expect(calls).toEqual([first.slot, first.slot + 1]);
  expect(warnings).toEqual(["WARNING: Entity used itself.\n"]);
});

test("native target dispatch continues through the reused source slot after a callback frees and respawns it", () => {
  const pool = new EntityPool({ print: text => { warnings.push(text); }, product: "baseq3", maxClients: 1, mapStartTime: 0, time: () => 1000,
    link: () => {}, unlink: () => {} });
  const source = pool.spawn(), first = pool.spawn(), second = pool.spawn();
  const calls: number[] = [], warnings: string[] = [];
  source.target = "first"; first.targetname = "first"; second.targetname = "second";
  first.parent = source; second.enemy = source;
  first.use = self => {
    calls.push(self.slot); pool.free(source);
    const reused = pool.spawn(); reused.target = "second";
  };
  second.use = (self, other) => {
    expect(other).toBe(source); expect(other).toBe(self.enemy); expect(first.parent).toBe(other);
    expect(other?.inuse).toBe(true); calls.push(self.slot);
  };
  useTargets({ pool, time: 1000, warn: message => { warnings.push(message); },
    remapShader: () => { throw new Error("Unexpected shader remap"); } }, source, null);
  // Native untouched G_UseTargets prints first1 second1 source_inuse1.
  expect(calls).toEqual([first.slot, second.slot]); expect(warnings).toEqual([]); expect(source.inuse).toBe(true);
});

test("team commands visit only fully connected members inside configured maxclients", () => {
  const { pool } = fixture();
  for (const client of pool.clients) { client.pers.connected = ConnectionState.CONNECTED; client.sess.sessionTeam = Team.TEAM_RED; }
  pool.clientAt(1).pers.connected = ConnectionState.CONNECTING;
  pool.clientAt(2).sess.sessionTeam = Team.TEAM_BLUE;
  const recipients: number[] = [];
  teamCommand(pool, Team.TEAM_RED, "print hi", (index, text) => { expect(text).toBe("print hi"); recipients.push(index); });
  expect(recipients).toEqual([0, 3]);
});

test("editor movedir sentinels clear angles and ordinary directions use AngleVectors", () => {
  expect(moveDirection(vec3(0, -1, 0))).toEqual({ direction: vec3(0, 0, 1), angles: vec3(0, 0, 0) });
  expect(moveDirection(vec3(0, -2, 0))).toEqual({ direction: vec3(0, 0, -1), angles: vec3(0, 0, 0) });
  const ordinary = moveDirection(vec3(0, 90, 0));
  expect(ordinary.direction.x).toBeCloseTo(0, 6); expect(ordinary.direction.y).toBe(1);
  expect(ordinary.angles).toEqual(vec3(0, 0, 0));
  expect(moveDirection(vec3(1, -1, 0)).direction.z).toBeLessThan(0);
});
