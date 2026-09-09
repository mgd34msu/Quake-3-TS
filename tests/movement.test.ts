import { describe, expect, test } from "bun:test";
import { dot3, lerp3, vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import type { Bounds, Vec3 } from "../src/core/math.ts";
import { EntityEvent as E, MoveType, Powerup, Weapon, WeaponState, statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { itemList } from "../src/shared/items.ts";
import { MovementDiagnostics, movePlayer, updateViewAngles } from "../src/shared/movement.ts";
import type { MovementOptions, MovementTrace, MovementTraceFunction } from "../src/shared/movement.ts";
import { CommandButtons as B, createPlayerState, ENTITYNUM_NONE, ENTITYNUM_WORLD,
  MoveFlags as F, PlayerAnimation as A, PlayerStateSlots } from "../src/shared/player-state.ts";
import type { UserCommand } from "../src/shared/player-state.ts";
import { clipVelocity, slideMove, stepSlideMove } from "../src/shared/slide-move.ts";
import type { SlideMoveContext } from "../src/shared/slide-move.ts";

function clear(end: Vec3): MovementTrace {
  return { fraction: 1, end, solidity: "clear", contact: { kind: "none" },
    surfaceFlags: 0, contents: 0, entityNum: ENTITYNUM_NONE };
}

/** Analytic convex halfspaces, independent of production BSP and movement code. */
interface FixturePlane { readonly normal: Vec3; readonly distance: number }
function brushTrace(start: Vec3, end: Vec3, bounds: Bounds, planes: readonly FixturePlane[],
  entityNum: number, flags = 0): MovementTrace {
  let enter = -Infinity;
  let leave = Infinity;
  let entering: FixturePlane | null = null;
  let startOutside = false;
  let endOutside = false;
  for (const plane of planes) {
    const n = plane.normal;
    const corner = vec3(n.x < 0 ? bounds.max.x : bounds.min.x,
      n.y < 0 ? bounds.max.y : bounds.min.y, n.z < 0 ? bounds.max.z : bounds.min.z);
    const expanded = plane.distance - dot3(n, corner);
    const from = dot3(n, start) - expanded;
    const to = dot3(n, end) - expanded;
    if (from >= 0) startOutside = true;
    if (to >= 0) endOutside = true;
    if (from >= 0 && to >= 0) return clear(end);
    if (from < 0 && to < 0) continue;
    const fraction = from / (from - to);
    if (from >= to) {
      if (fraction > enter) { enter = fraction; entering = plane; }
    } else leave = Math.min(leave, fraction);
  }
  if (!startOutside) return { fraction: endOutside ? 1 : 0, end: endOutside ? end : start,
    solidity: endOutside ? "start-solid" : "all-solid", contact: { kind: "none" },
    surfaceFlags: flags, contents: 1, entityNum };
  if (enter < leave && enter >= 0 && enter < 1 && entering !== null) {
    return { fraction: enter, end: lerp3(start, end, enter), solidity: "clear",
      contact: { kind: "plane", plane: entering }, surfaceFlags: flags, contents: 1, entityNum };
  }
  return clear(end);
}

function floorTrace(flags = 0, normal = vec3(0, 0, 1)): MovementTraceFunction {
  return (start, end, bounds) => brushTrace(start, end, bounds, [{ normal, distance: 0 }], ENTITYNUM_WORLD, flags);
}
const flat: MovementOptions = { trace: floorTrace(), pointContents: () => 0 };
const empty: MovementOptions = { trace: (_start, end) => clear(end), pointContents: () => 0 };

function player(product: Product = "baseq3") {
  const ps = createPlayerState(product);
  ps.health = 100;
  ps.stats.set(statSchema(product).maxHealth, 100);
  ps.stats.set(statSchema(product).weapons, (1 << Weapon.WP_MACHINEGUN) | (1 << Weapon.WP_GAUNTLET));
  ps.ammo.set(Weapon.WP_MACHINEGUN, 100);
  ps.ammo.set(Weapon.WP_GAUNTLET, -1);
  ps.weapon = Weapon.WP_MACHINEGUN;
  ps.gravity = 800;
  ps.speed = 320;
  ps.viewheight = 26;
  ps.origin = vec3(0, 0, 24);
  ps.groundEntityNum = ENTITYNUM_WORLD;
  return ps;
}
function command(time: number, overrides: Partial<UserCommand> = {}): UserCommand {
  return { serverTime: time, angles: vec3(0, 0, 0), buttons: 0, weapon: Weapon.WP_MACHINEGUN,
    forwardmove: 0, rightmove: 0, upmove: 0, ...overrides };
}
function eventIds(events: readonly { readonly event: number }[]): number[] { return events.map(event => event.event); }

function qvmMovementRows(product: Product): string {
  const rows: string[] = [];
  function record(name: string, frame: number, ps: ReturnType<typeof player>): void {
    rows.push(`PMOVE ${name} ${frame} ${[ps.origin.x, ps.origin.y, ps.origin.z, ps.velocity.x, ps.velocity.y, ps.velocity.z]
      .map(value => float32ToBits(value) | 0).join(" ")} ${[ps.weaponTime, ps.eventSequence, ps.legsTimer, ps.torsoTimer, ps.pmFlags, ps.groundEntityNum,
        ps.events.get(0), ps.events.get(1), ps.eventParms.get(0), ps.eventParms.get(1)].join(" ")}`);
  }
  for (const mode of [MoveType.PM_NOCLIP, MoveType.PM_NORMAL]) {
    const ps = player(product); ps.pmType = mode;
    movePlayer(ps, command(20, { forwardmove: 127, angles: vec3(0, 1504, 0) }), flat);
    record(mode === MoveType.PM_NOCLIP ? "noclip47" : "ground47", 0, ps);
  }
  const ps = player(product);
  for (let frame = 1; frame <= 125; frame++) {
    movePlayer(ps, command(frame * 8, { forwardmove: 127, rightmove: frame > 40 && frame < 90 ? 127 : 0,
      upmove: frame >= 15 && frame <= 90 ? 127 : 0, buttons: B.ATTACK, angles: vec3(0, frame * 100, 0) }), { ...flat, fixedMsec: 8 });
    record("mixed", frame, ps);
  }
  return `${rows.join("\n")}\n`;
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product} original QVM movement has exact angle-regression and 125-frame replay bits and event rings`, () => {
    // Unchanged bg_pmove/bg_slidemove/bg_misc/q_math/q_shared/bg_lib, original q3lcc and vm_game=1.
    // /tmp/quake3-movement-events-XPPvtv/pmove-run.sh baseq3|missionpack.
    // Last four columns are events[0..1], eventParms[0..1], in physical ring slot order.
    // PM_AddEvent always writes parameter zero; this replay checks its ring writes and retention.
    const rows = qvmMovementRows(product);
    expect(rows.split("\n")[0]).toBe("PMOVE noclip47 0 1067590595 1044142095 1103101952 1115510752 1091773643 0 0 0 0 0 0 1022 0 0 0 0");
    expect(Bun.CryptoHasher.hash("sha256", rows, "hex")).toBe("39b4a48be7cab12d98d11aafd6ce4d77d6b507bd6f2276ebde494670757a66f9");
  });
  test.skipIf(Bun.env["Q3_PMOVE_ORACLE"] === undefined)(`${product} live original QVM movement matches every recorded frame`, () => {
    const script = Bun.env["Q3_PMOVE_ORACLE"]; if (script === undefined) throw new Error("Q3_PMOVE_ORACLE required");
    const result = Bun.spawnSync(["bash", script, product]);
    expect(result.exitCode).toBe(0);
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(output).toContain("PMOVE DONE");
    const rows = output.split(/\r?\n/).filter(row => /^PMOVE (noclip47|ground47|mixed) /.test(row));
    expect(rows).toHaveLength(127); expect(qvmMovementRows(product)).toBe(`${rows.join("\n")}\n`);
  });
}

describe("source player state and command timing", () => {
  test("zero initialization, product stat slots and bounded event ring", () => {
    const base = createPlayerState("baseq3");
    const mission = createPlayerState("missionpack");
    expect(base.gravity).toBe(0);
    base.health = 100;
    mission.health = 90;
    expect(base.stats.get(0)).toBe(100);
    expect(mission.stats.get(0)).toBe(90);
    const slots = new PlayerStateSlots(16);
    expect(() => slots.get(16)).toThrow(RangeError);
    expect(() => slots.set(-1, 3)).toThrow(RangeError);
    expect(() => slots.set(0.5, 3)).toThrow(RangeError);
    base.addEvent(E.EV_JUMP, 2);
    base.addEvent(E.EV_FIRE_WEAPON, 3);
    base.addEvent(E.EV_NOAMMO, 4);
    expect(base.eventSequence).toBe(3);
    expect(base.events.copy()).toEqual(new Int32Array([E.EV_NOAMMO, E.EV_FIRE_WEAPON]));
    expect(base.eventParms.copy()).toEqual(new Int32Array([4, 3]));
  });
  test("view short wrapping and pitch delta correction", () => {
    const ps = player();
    updateViewAngles(ps, command(1, { angles: vec3(20000, 65535, 32768) }));
    expect(ps.deltaAngles.x).toBe(-4000);
    expect(ps.viewangles.x).toBe(87.890625);
    expect(ps.viewangles.y).toBe(-360 / 65536);
    expect(ps.viewangles.z).toBe(-180);
    ps.pmType = MoveType.PM_INTERMISSION;
    updateViewAngles(ps, command(2));
    expect(ps.viewangles.x).toBe(87.890625);
  });
  test("view updates retain integer delta angles above binary32 precision for both products", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const ps = player(product);
      const deltas = { x: 16777217, y: 16777217, z: -16777217 };
      ps.deltaAngles = deltas;
      updateViewAngles(ps, command(1));
      expect(ps.deltaAngles).toBe(deltas);
      expect(ps.viewangles).toEqual(vec3(360 / 65536, 360 / 65536, -360 / 65536));

      for (const direction of [1, -1]) {
        ps.deltaAngles = { x: 0, y: deltas.y, z: deltas.z };
        const angles = { x: direction * 16797217, y: 0, z: 0 };
        updateViewAngles(ps, command(2, { angles }));
        expect(ps.deltaAngles).toEqual({ x: direction * -16781217, y: deltas.y, z: deltas.z });
        expect(ps.viewangles).toEqual(vec3(direction * 87.890625, 360 / 65536, -360 / 65536));
      }
      const boundaries: readonly (readonly [number, number, number, number])[] = [
        [2147483647, -19999, 2147467649, -87.890625],
        [-2147483648, 20000, -2147467648, 87.890625],
      ];
      for (const [pitch, delta, correction, view] of boundaries) {
        ps.deltaAngles = { x: delta, y: deltas.y, z: deltas.z };
        updateViewAngles(ps, command(3, { angles: { x: pitch, y: 0, z: 0 } }));
        expect(ps.deltaAngles).toEqual({ x: correction, y: deltas.y, z: deltas.z });
        expect(ps.viewangles).toEqual(vec3(view, 360 / 65536, -360 / 65536));
      }
    }
  });
  test("66 ms chopping is equivalent to separately replayed commands", () => {
    const whole = player();
    const split = player();
    movePlayer(whole, command(132, { forwardmove: 127 }), flat);
    movePlayer(split, command(66, { forwardmove: 127 }), flat);
    movePlayer(split, command(132, { forwardmove: 127 }), flat);
    expect(whole.origin).toEqual(split.origin);
    expect(whole.velocity).toEqual(split.velocity);
    expect(whole.pmoveFramecount).toBe(1);
    expect(split.pmoveFramecount).toBe(2);
  });
  test("backlog caps at 1000 ms, fixed step applies, and old commands are ignored", () => {
    const ps = player();
    ps.pmType = MoveType.PM_NOCLIP;
    const replay = player();
    replay.pmType = MoveType.PM_NOCLIP;
    replay.commandTime = 4000;
    movePlayer(ps, command(5000, { forwardmove: 127 }), { ...empty, fixedMsec: 10 });
    for (let time = 4010; time <= 5000; time += 10) movePlayer(replay, command(time, { forwardmove: 127 }), empty);
    expect(ps.origin).toEqual(replay.origin);
    expect(ps.commandTime).toBe(5000);
    const position = ps.origin;
    movePlayer(ps, command(4999), empty);
    expect(ps.origin).toEqual(position);
    expect(() => movePlayer(ps, command(5010), { ...empty, fixedMsec: 0 })).toThrow(RangeError);
    expect(() => movePlayer(ps, command(5010, { forwardmove: 128 }), empty)).toThrow(RangeError);
  });
  test("fixed intervals publish full command time while each simulation step caps at 200 ms", () => {
    // bg_pmove.c Pmove/PmoveSingle/PM_DropTimers: outer intervals advance time,
    // the 1000 ms backlog limit runs first, and only local msec reduces timers.
    const cases = [
      { fixed: 200, finalTime: 200, steps: 1, remaining: 1800 },
      { fixed: 201, finalTime: 201, steps: 1, remaining: 1800 },
      { fixed: 250, finalTime: 250, steps: 1, remaining: 1800 },
      { fixed: 250, finalTime: 600, steps: 3, remaining: 1500 },
      { fixed: 1001, finalTime: 2000, steps: 1, remaining: 1800 },
      { fixed: 1500, finalTime: 1500, steps: 1, remaining: 1800 },
      { fixed: 0x7fffffff, finalTime: 1500, steps: 1, remaining: 1800 },
    ];
    const products: readonly Product[] = ["baseq3", "missionpack"];
    for (const product of products) for (const row of cases) {
      const ps = player(product), diagnostics = new MovementDiagnostics(() => {});
      ps.pmType = MoveType.PM_NOCLIP;
      ps.pmTime = 2000; ps.legsTimer = 2000; ps.torsoTimer = 2000; ps.pmoveFramecount = 63;
      movePlayer(ps, command(row.finalTime), { ...empty, fixedMsec: row.fixed, diagnostics: { state: diagnostics, level: 0 } });
      expect(ps.commandTime).toBe(row.finalTime);
      expect(ps.pmTime).toBe(row.remaining);
      expect(ps.legsTimer).toBe(row.remaining);
      expect(ps.torsoTimer).toBe(row.remaining);
      expect(ps.pmoveFramecount).toBe(0);
      expect(diagnostics.count).toBe(row.steps);
    }
  });
  test("fixed intervals reject nonpositive, fractional and non-int32 values before movement", () => {
    for (const fixedMsec of [0, -1, 1.5, NaN, Infinity, 0x80000000]) {
      const ps = player();
      expect(() => movePlayer(ps, command(250), { ...empty, fixedMsec })).toThrow(RangeError);
      expect(ps.commandTime).toBe(0);
      expect(ps.pmoveFramecount).toBe(0);
    }
  });
  test("captured upstream C mixed-command replay: 125 frames at 8ms", () => {
    // Untouched bg_pmove.c/bg_slidemove.c/bg_misc.c/q_math.c, source commit
    // dbe4ddb10315479fc00086f08e25d968b4b43c49; cc -O0, analytic flat plane,
    // Sys_SnapVector=rintf. All source player state setup matches player().
    const ps = player();
    for (let frame = 1; frame <= 125; frame++) {
      movePlayer(ps, command(frame * 8, {
        forwardmove: 127, rightmove: frame > 40 && frame < 90 ? 127 : 0,
        upmove: frame >= 15 && frame <= 90 ? 127 : 0,
        buttons: B.ATTACK, angles: vec3(0, frame * 100, 0),
      }), { ...flat, fixedMsec: 8 });
    }
    expect(ps.origin.x).toBeCloseTo(260.250824, 3);
    expect(ps.origin.y).toBeCloseTo(45.3744507, 3);
    expect(ps.origin.z).toBe(24);
    expect(ps.velocity).toEqual(vec3(226, 255, 0));
    expect(ps.weaponTime).toBe(8);
    expect(ps.eventSequence).toBe(13);
    expect(ps.pmFlags).toBe(F.TIME_LAND);
    expect(ps.groundEntityNum).toBe(ENTITYNUM_WORLD);
  });
  test("captured source overbounce depends on ClientSpawn's initial 100ms command", () => {
    const epsilonFloor: MovementOptions = { ...flat, trace: (start, end, bounds) => {
      const from = Math.fround(start.z + bounds.min.z);
      const to = Math.fround(end.z + bounds.min.z);
      if (from > 0 && (to >= 0.125 || to >= from)) return clear(end);
      if (from <= 0) return { ...clear(to > 0 ? end : start), fraction: to > 0 ? 1 : 0,
        solidity: to > 0 ? "start-solid" : "all-solid", entityNum: ENTITYNUM_WORLD, contents: 1 };
      const fraction = Math.max(0, Math.fround((from - 0.125) / (from - to)));
      return { ...clear(lerp3(start, end, fraction)), fraction, contents: 1, entityNum: ENTITYNUM_WORLD,
        contact: { kind: "plane", plane: { normal: vec3(0, 0, 1), distance: 0 } } };
    } };
    const missingSpawnFrame = player();
    const completeSpawn = player();
    for (const ps of [missingSpawnFrame, completeSpawn]) {
      ps.origin = vec3(0, 0, 33);
      ps.pmFlags = F.RESPAWNED | F.TIME_KNOCKBACK;
      ps.pmTime = 100;
    }
    completeSpawn.commandTime = -100;
    movePlayer(completeSpawn, command(0), epsilonFloor);
    expect(completeSpawn.origin.z).toBe(Math.fround(28.9932003));
    expect(completeSpawn.velocity.z).toBe(-80);
    for (let frame = 1; frame <= 125; frame++) {
      movePlayer(missingSpawnFrame, command(frame * 8), epsilonFloor);
      movePlayer(completeSpawn, command(frame * 8), epsilonFloor);
    }
    // Untouched upstream pmove + analytic CM 0.125-epsilon floor oracle.
    expect(missingSpawnFrame.origin.z).toBe(Math.fround(31.2687855));
    expect(missingSpawnFrame.velocity.z).toBe(-48);
    expect(missingSpawnFrame.groundEntityNum).toBe(ENTITYNUM_NONE);
    expect(completeSpawn.origin.z).toBe(24.125);
    expect(completeSpawn.velocity.z).toBe(0);
    expect(completeSpawn.groundEntityNum).toBe(ENTITYNUM_WORLD);
  });
});

describe("ground, air and collision source movement", () => {
  test("command scaling rounds the QVM denominator before dividing for both products", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const ps = player(product);
      ps.pmType = MoveType.PM_NOCLIP;
      movePlayer(ps, command(20, { forwardmove: 1, rightmove: 3 }), empty);
      // PM_CmdScale's MULF4 stores 127 * sqrt(10) as 401.6092529296875 before DIVF4.
      expect(ps.velocity).toEqual(vec3(0.478076696395874, -1.434230089187622, 0));
      expect(ps.origin).toEqual(vec3(0.009561534970998764, -0.028684603050351143, 24));
    }
  });
  test("ground acceleration, diagonal scaling and friction", () => {
    const straight = player();
    const diagonal = player();
    movePlayer(straight, command(20, { forwardmove: 127 }), flat);
    movePlayer(diagonal, command(20, { forwardmove: 127, rightmove: 127 }), flat);
    expect(straight.velocity.x).toBe(64);
    expect(straight.origin.x).toBeCloseTo(1.28, 5);
    expect(diagonal.velocity).toEqual(vec3(45, -45, 0));
    straight.velocity = vec3(320, 0, 0);
    movePlayer(straight, command(40), flat);
    expect(straight.velocity.x).toBe(282);
    straight.velocity = vec3(50, 0, 0);
    movePlayer(straight, command(60), flat);
    expect(straight.velocity.x).toBe(38);
  });
  test("air acceleration is 1 and does not apply ground friction", () => {
    const ps = player();
    ps.origin = vec3(0, 0, 100);
    ps.groundEntityNum = ENTITYNUM_NONE;
    movePlayer(ps, command(20, { forwardmove: 127 }), empty);
    expect(ps.velocity).toEqual(vec3(6, 0, -16));
    expect(ps.origin.x).toBeCloseTo(0.128, 5);
    expect(ps.origin.z).toBeCloseTo(99.84, 4);
    ps.velocity = vec3(320, 0, 0);
    movePlayer(ps, command(40), empty);
    expect(ps.velocity.x).toBe(320);
  });
  test("jump launch and held jump latch survive landing", () => {
    const ps = player();
    const input = command(20, { upmove: 127 });
    const first = movePlayer(ps, input, flat);
    expect(ps.velocity.z).toBe(254);
    expect(ps.origin.z).toBeCloseTo(29.24, 4);
    expect(ps.groundEntityNum).toBe(ENTITYNUM_NONE);
    expect(eventIds(first.events)).toContain(E.EV_JUMP);
    expect(input.upmove).toBe(127);
    const held = movePlayer(ps, command(900, { upmove: 127 }), flat);
    expect(eventIds(held.events)).not.toContain(E.EV_JUMP);
    expect(ps.groundEntityNum).toBe(ENTITYNUM_WORLD);
    movePlayer(ps, command(920), flat);
    const next = movePlayer(ps, command(940, { upmove: 127 }), flat);
    expect(eventIds(next.events)).toContain(E.EV_JUMP);
  });
  test("slick surfaces use air acceleration and omit ground friction", () => {
    const ps = player();
    const slick = { ...flat, trace: floorTrace(2) };
    movePlayer(ps, command(20, { forwardmove: 127 }), slick);
    // PM_WalkMove preserves total speed after clipping the -16 gravity component.
    expect(ps.velocity.x).toBe(17);
    ps.velocity = vec3(320, 0, 0);
    movePlayer(ps, command(40), slick);
    expect(ps.velocity.x).toBe(320);
  });
  test("duck changes bounds and clamps maximum wish speed", () => {
    const ps = player();
    const result = movePlayer(ps, command(20, { forwardmove: 127, upmove: -127 }), flat);
    expect(result.bounds.max.z).toBe(16);
    expect(ps.viewheight).toBe(12);
    expect(ps.velocity.x).toBe(16);
    expect(ps.pmFlags & F.DUCKED).toBe(F.DUCKED);
    const ceiling: MovementOptions = { ...flat, trace: (start, end, bounds, entity, mask) => {
      if (bounds.max.z === 32) return { ...clear(start), fraction: 0, solidity: "all-solid", contents: 1 };
      return flat.trace(start, end, bounds, entity, mask);
    } };
    movePlayer(ps, command(40), ceiling);
    expect(ps.pmFlags & F.DUCKED).toBe(F.DUCKED);
    movePlayer(ps, command(60), flat);
    expect(ps.pmFlags & F.DUCKED).toBe(0);
  });
  test("walkable slope preserves speed and steep slope is airborne", () => {
    const ps = player();
    ps.origin = vec3(0, 0, 35.25001);
    const slope = { ...flat, trace: floorTrace(0, vec3(-0.6, 0, 0.8)) };
    movePlayer(ps, command(20, { forwardmove: 127 }), slope);
    expect(ps.groundEntityNum).toBe(ENTITYNUM_WORLD);
    expect(ps.velocity.x).toBe(51);
    expect(ps.velocity.z).toBe(38);
    expect(ps.origin.z).toBeGreaterThan(35.25);
    const steep = player();
    steep.origin = vec3(0, 0, 44);
    movePlayer(steep, command(20), { ...flat, trace: floorTrace(0, vec3(-0.8, 0, 0.6)) });
    expect(steep.groundEntityNum).toBe(ENTITYNUM_NONE);
  });
  test("the exact QVM 0.7 normal remains walkable for both products", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const ps = player(product);
      ps.gravity = 0;
      let traces = 0;
      movePlayer(ps, command(20), { ...empty, trace: start => {
        traces++;
        return { ...clear(start), fraction: 0, entityNum: ENTITYNUM_WORLD,
          contact: { kind: "plane", plane: { normal: vec3(Math.sqrt(0.51), 0, 0.7), distance: 0 } } };
      } });
      expect(ps.groundEntityNum).toBe(ENTITYNUM_WORLD);
      expect(traces).toBe(2);
    }
  });
  test("18-unit stepping clears a 16-unit riser and emits EV_STEP_16", () => {
    const floor = floorTrace();
    const riser: readonly FixturePlane[] = [
      { normal: vec3(-1, 0, 0), distance: -40 }, { normal: vec3(1, 0, 0), distance: 80 },
      { normal: vec3(0, 0, 1), distance: 16 },
    ];
    const stairs: MovementOptions = { ...flat, trace: (start, end, bounds, pass, mask) => {
      const a = floor(start, end, bounds, pass, mask);
      const b = brushTrace(start, end, bounds, riser, 7);
      return b.fraction < a.fraction ? b : a;
    } };
    const ps = player();
    ps.origin = vec3(24, 0, 24);
    ps.velocity = vec3(320, 0, 0);
    const result = movePlayer(ps, command(20, { forwardmove: 127 }), stairs);
    expect(ps.origin.x).toBeGreaterThan(25);
    expect(ps.origin.z).toBeCloseTo(40, 4);
    expect(eventIds(result.events)).toContain(E.EV_STEP_16);
    expect(result.contacts).toContain(7);
  });
  test("all-solid cancels vertical velocity without fabricating a plane", () => {
    const ps = player();
    ps.velocity = vec3(50, 10, -200);
    const ctx: SlideMoveContext = { state: ps, frameTime: 0.02, bounds: { min: vec3(-15, -15, -24), max: vec3(15, 15, 32) },
      mask: 1, groundNormal: null, impactSpeed: 0,
      trace: start => ({ ...clear(start), fraction: 0, solidity: "all-solid", contents: 1 }),
      touch: () => {}, event: () => {} };
    expect(slideMove(ctx, true)).toBe(true);
    expect(ps.velocity).toEqual(vec3(50, 10, 0));
    expect(clipVelocity(vec3(10, 0, -100), vec3(0, 0, 1))).toEqual(vec3(10, 0, 0.100006103515625));
  });
  test("the QVM 0.99 equality clips before publishing state to the next trace", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (const similarity of [0.99, 0.991]) {
        const ps = player(product);
        ps.origin = vec3(1, 0, 0);
        ps.velocity = vec3(-100, 0, 0);
        ps.gravity = 0;
        const normal = vec3(Math.sqrt(1 - similarity * similarity), 0, similarity);
        let traces = 0;
        const context: SlideMoveContext = { state: ps, frameTime: Math.fround(0.02),
          bounds: { min: vec3(0, 0, 0), max: vec3(0, 0, 0) }, mask: 1,
          groundNormal: vec3(0, 0, 1), impactSpeed: 0, touch: () => {}, event: () => {},
          trace: (start, end, bounds) => {
            if (++traces === 2) throw new Error("second trace aborted");
            return brushTrace(start, end, bounds, [{ normal, distance: 0 }], 8);
          } };
        expect(() => slideMove(context, true)).toThrow("second trace aborted");
        expect(ps.origin).toEqual(vec3(0, 0, 0));
        if (similarity === 0.99) expect(ps.velocity.z).toBeGreaterThan(13);
        else expect(ps.velocity.z).toBe(normal.z);
      }
    }
  });
  test("step eligibility includes the QVM 0.7 normal and retains the completed slide on trace failure", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const ps = player(product);
      ps.origin = vec3(0, 0, 0);
      ps.velocity = vec3(1, 0, 1);
      ps.gravity = 0;
      let traces = 0;
      let slideOrigin = ps.origin;
      const context: SlideMoveContext = { state: ps, frameTime: Math.fround(0.02),
        bounds: { min: vec3(0, 0, 0), max: vec3(0, 0, 0) }, mask: 1,
        groundNormal: null, impactSpeed: 0, touch: () => {}, event: () => {},
        trace: (start, end) => {
          traces++;
          if (traces === 2) { slideOrigin = end; return clear(end); }
          if (traces === 4) {
            expect(start).toEqual(vec3(0, 0, 0));
            expect(end).toEqual(vec3(0, 0, 18));
            throw new Error("raised trace aborted");
          }
          return { ...clear(start), fraction: 0, entityNum: 8,
            contact: { kind: "plane", plane: { normal: traces === 1 ? vec3(-1, 0, 0) :
              vec3(Math.sqrt(0.51), 0, 0.7), distance: 0 } } };
        } };
      expect(() => stepSlideMove(context, true)).toThrow("raised trace aborted");
      expect(traces).toBe(4);
      expect(ps.origin).toEqual(slideOrigin);
      expect(ps.origin.z).toBe(Math.fround(0.02));
      expect(ps.velocity.z).toBe(1);
    }
  });
  test("two-plane creases preserve tangential velocity and three planes stop inward motion", () => {
    const corner = (normals: readonly Vec3[]): MovementTraceFunction => (start, end, bounds) => {
      let result = clear(end);
      for (const normal of normals) {
        const trace = brushTrace(start, end, bounds, [{ normal, distance: 0 }], 8);
        if (trace.fraction < result.fraction) result = trace;
      }
      return result;
    };
    const ps = player();
    ps.origin = vec3(-1, -1, -1);
    ps.velocity = vec3(100, 100, 50);
    const contacts: number[] = [];
    const ctx: SlideMoveContext = { state: ps, frameTime: 0.02,
      bounds: { min: vec3(0, 0, 0), max: vec3(0, 0, 0) }, mask: 1, groundNormal: null, impactSpeed: 0,
      trace: corner([vec3(-1, 0, 0), vec3(0, -1, 0)]),
      touch: entity => { contacts.push(entity); }, event: () => {} };
    slideMove(ctx, false);
    expect(ps.origin.x).toBeLessThanOrEqual(0);
    expect(ps.origin.y).toBeLessThanOrEqual(0);
    expect(ps.velocity.z).toBe(50);
    expect(contacts).toContain(8);
    expect(ctx.impactSpeed).toBe(100);
    ps.origin = vec3(-1, -2, -1);
    ps.velocity = vec3(100, 200, 100);
    slideMove({ ...ctx, trace: corner([vec3(-1, 0, 0), vec3(0.6, -0.8, 0), vec3(0, 0, -1)]) }, false);
    expect(ps.velocity.x).toBe(0);
    expect(ps.velocity.y).toBe(0);
    expect(ps.velocity.z).toBeCloseTo(-0.1, 4);
  });
  test("active movement timer restores primal velocity after a slide collision", () => {
    const ps = player();
    ps.origin = vec3(-1, 0, 0);
    ps.velocity = vec3(100, 10, 0);
    ps.pmTime = 100;
    const ctx: SlideMoveContext = { state: ps, frameTime: 0.02,
      bounds: { min: vec3(0, 0, 0), max: vec3(0, 0, 0) }, mask: 1, groundNormal: null, impactSpeed: 0,
      trace: (start, end, bounds) => brushTrace(start, end, bounds, [{ normal: vec3(-1, 0, 0), distance: 0 }], 2),
      touch: () => {}, event: () => {} };
    slideMove(ctx, true);
    expect(ps.velocity).toEqual(vec3(100, 10, -16));
    expect(ps.origin.x).toBeLessThanOrEqual(0);
  });
});

describe("source footstep speed and event thresholds", () => {
  test("QVM horizontal speed preserves the bob cycle at the exact idle threshold", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (const x of [0, 0.001]) {
        const ps = player(product);
        ps.origin = vec3(0, 0, 24.5);
        ps.velocity = vec3(x, 4.999999523162842, 0);
        ps.groundEntityNum = ENTITYNUM_NONE;
        ps.bobCycle = 99;
        const result = movePlayer(ps, command(32), flat);
        expect(ps.groundEntityNum).toBe(ENTITYNUM_WORLD);
        expect(result.xyspeed).toBe(x === 0 ? 4.999999523162842 : 5);
        expect(ps.bobCycle).toBe(x === 0 ? 0 : 99);
        expect(result.events).toEqual([]);
      }
    }
  });
  test("footsteps cross at cycles 64 and 192 and preserve the byte wrap", () => {
    const boundaries: readonly (readonly [number, number, number, boolean])[] = [
      [63, 2, 63, false], [63, 3, 64, true],
      [191, 2, 191, false], [191, 3, 192, true],
      [255, 3, 0, false], [0, 200, 80, true],
    ];
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (const [old, msec, next, footstep] of boundaries) {
        const ps = player(product);
        ps.bobCycle = old;
        const result = movePlayer(ps, command(msec, { forwardmove: 10 }), { ...flat, fixedMsec: msec });
        expect(ps.bobCycle).toBe(next);
        expect(eventIds(result.events)).toEqual(footstep ? [E.EV_FOOTSTEP] : []);
      }
    }
  });
  test("surface, walking, crouching and water select source events at the bob boundary", () => {
    const cases = [
      { waterlevel: 0, flags: 0, noFootsteps: false, buttons: 0, upmove: 0, events: [E.EV_FOOTSTEP] },
      { waterlevel: 0, flags: 0x1000, noFootsteps: false, buttons: 0, upmove: 0, events: [E.EV_FOOTSTEP_METAL] },
      { waterlevel: 0, flags: 0x2000, noFootsteps: false, buttons: 0, upmove: 0, events: [0] },
      { waterlevel: 0, flags: 0, noFootsteps: true, buttons: 0, upmove: 0, events: [] },
      { waterlevel: 0, flags: 0, noFootsteps: false, buttons: B.WALKING, upmove: 0, events: [] },
      { waterlevel: 0, flags: 0, noFootsteps: false, buttons: 0, upmove: -1, events: [] },
      { waterlevel: 1, flags: 0x2000, noFootsteps: true, buttons: B.WALKING, upmove: 0, events: [E.EV_FOOTSPLASH] },
      { waterlevel: 2, flags: 0, noFootsteps: true, buttons: B.WALKING, upmove: 0, events: [E.EV_SWIM] },
      { waterlevel: 3, flags: 0, noFootsteps: false, buttons: 0, upmove: 0, events: [] },
    ];
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      for (const row of cases) {
        const ps = player(product);
        ps.bobCycle = 63;
        const result = movePlayer(ps, command(10, { forwardmove: 10, buttons: row.buttons, upmove: row.upmove }), {
          trace: floorTrace(row.flags), noFootsteps: row.noFootsteps,
          pointContents: point => row.waterlevel === 3 || (row.waterlevel === 2 && point.z < 40) ||
            (row.waterlevel === 1 && point.z < 10) ? 32 : 0,
        });
        expect(result.waterlevel).toBe(row.waterlevel);
        expect(ps.bobCycle).toBe(row.upmove < 0 ? 68 : row.buttons & B.WALKING ? 66 : 67);
        expect(eventIds(result.events)).toEqual(row.events);
      }
    }
  });
});

describe("movement modes, liquid events and timers", () => {
  test("pmove memset leaves bounds zero on noclip/frozen early exits, while CheckDuck sets active bounds", () => {
    for (const pmType of [MoveType.PM_NOCLIP, MoveType.PM_FREEZE, MoveType.PM_INTERMISSION, MoveType.PM_SPINTERMISSION]) {
      const ps = player();
      ps.pmType = pmType;
      const result = movePlayer(ps, command(20), empty);
      expect(result.bounds).toEqual({ min: vec3(0, 0, 0), max: vec3(0, 0, 0) });
    }
    for (const pmType of [MoveType.PM_NORMAL, MoveType.PM_SPECTATOR]) {
      const ps = player();
      ps.pmType = pmType;
      const result = movePlayer(ps, command(20), flat);
      expect(result.bounds).toEqual({ min: vec3(-15, -15, -24), max: vec3(15, 15, 32) });
    }
  });
  test("shallow-water walking preserves source float storage in the speed cap", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const ps = player(product);
      ps.speed = 322;
      const result = movePlayer(ps, command(100, { forwardmove: 127 }), {
        ...flat, fixedMsec: 100, pointContents: point => point.z < 10 ? 32 : 0,
      });
      // PM_WalkMove stores 1/3, then 1 - 0.5 * waterScale, as floats.
      // The resulting 268.33331298828125 speed advances 26.833332061767578 units.
      expect(result.waterlevel).toBe(1);
      expect(ps.origin.x).toBe(26.833332061767578);
    }
  });
  test("swimming sinks, applies water friction, and flight has no gravity", () => {
    const swimmer = player();
    swimmer.origin = vec3(0, 0, 100);
    const water = { ...empty, pointContents: () => 32 };
    const result = movePlayer(swimmer, command(20), water);
    expect(result.waterlevel).toBe(3);
    expect(swimmer.velocity.z).toBe(-5);
    const flyer = player();
    flyer.powerups.set(Powerup.PW_FLIGHT, 1000);
    movePlayer(flyer, command(20, { upmove: 127 }), empty);
    expect(flyer.velocity.z).toBe(51);
    expect(flyer.origin.z).toBeCloseTo(25.024, 4);
  });
  test("crossing a water boundary emits touch and under events", () => {
    const ps = player();
    ps.origin = vec3(-1, 0, 100);
    ps.velocity = vec3(200, 0, 0);
    const result = movePlayer(ps, command(20), { ...empty, pointContents: point => point.x >= 0 ? 32 : 0 });
    expect(result.waterlevel).toBe(3);
    expect(eventIds(result.events)).toEqual([E.EV_WATER_TOUCH, E.EV_WATER_UNDER]);
  });
  test("waterjump checks a waist-height ledge and applies the source's second gravity subtraction", () => {
    const ps = player();
    ps.origin = vec3(0, 0, 100);
    ps.groundEntityNum = ENTITYNUM_NONE;
    const waterLedge: MovementOptions = { ...empty,
      pointContents: point => point.x >= 30 && point.z <= 110 ? 1 : point.z < 110 ? 32 : 0 };
    movePlayer(ps, command(20, { forwardmove: 127 }), waterLedge);
    expect(ps.pmFlags & F.TIME_WATERJUMP).toBe(F.TIME_WATERJUMP);
    expect(ps.pmTime).toBe(2000);
    expect(ps.velocity).toEqual(vec3(200, 0, 318));
    expect(ps.origin.z).toBeCloseTo(106.84, 4);
    ps.velocity = vec3(200, 0, 1);
    movePlayer(ps, command(40), waterLedge);
    expect(ps.pmFlags & F.TIME_WATERJUMP).toBe(0);
    expect(ps.pmTime).toBe(0);
  });
  test("grapple pulls at 800 beyond 100 units and scales near its point", () => {
    const far = player();
    far.origin = vec3(0, 0, 100);
    far.pmFlags |= F.GRAPPLE_PULL;
    far.grapplePoint = vec3(216, 0, 100);
    movePlayer(far, command(20), empty);
    expect(far.velocity).toEqual(vec3(800, 0, -16));
    const near = player();
    near.origin = vec3(0, 0, 100);
    near.pmFlags |= F.GRAPPLE_PULL;
    near.grapplePoint = vec3(66, 0, 100);
    movePlayer(near, command(20), empty);
    expect(near.velocity).toEqual(vec3(500, 0, -16));
  });
  test("near grapple pull rounds the QVM scale before applying its direction", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const ps = player(product);
      ps.origin = vec3(0, 0, 100);
      ps.groundEntityNum = ENTITYNUM_NONE;
      ps.pmFlags |= F.GRAPPLE_PULL;
      ps.grapplePoint = vec3(17, 2, 103);
      movePlayer(ps, command(20), empty);
      // PM_GrappleMove rounds 10 * sqrt(14) to 37.41657638549805 before VectorScale.
      expect(ps.origin.x).toBe(0.20000003278255463);
      expect(ps.origin.y).toBe(0.40000006556510925);
      expect(ps.velocity).toEqual(vec3(10, 20, 14));
    }
  });
  test("spectators use 8 acceleration and 5 friction without snapping velocity", () => {
    const ps = player();
    ps.pmType = MoveType.PM_SPECTATOR;
    movePlayer(ps, command(20, { forwardmove: 127 }), empty);
    expect(ps.velocity.x).toBeCloseTo(51.2, 4);
    movePlayer(ps, command(40), empty);
    expect(ps.velocity.x).toBeCloseTo(46.08, 4);
    expect(ps.velocity.z).toBe(0);
  });
  test("dead friction and trace mask ignore bodies", () => {
    const ps = player();
    ps.health = 0;
    ps.pmType = MoveType.PM_DEAD;
    ps.velocity = vec3(100, 0, 0);
    let maskSeen = 0;
    const result = movePlayer(ps, command(20, { forwardmove: 127 }), { ...flat,
      trace: (start, end, bounds, entity, mask) => { maskSeen = mask; return flat.trace(start, end, bounds, entity, mask); } });
    expect(maskSeen & 0x2000000).toBe(0);
    expect(ps.velocity.x).toBe(68);
    expect(ps.weapon).toBe(Weapon.WP_NONE);
    expect(result.bounds.max.z).toBe(-8);
    expect(ps.viewheight).toBe(-16);
  });
  test("freeze preserves timers, noclip ignores collision and drops timers", () => {
    const ps = player();
    ps.pmType = MoveType.PM_FREEZE;
    ps.pmTime = 50;
    ps.torsoTimer = 100;
    movePlayer(ps, command(20, { forwardmove: 127 }), flat);
    expect(ps.origin.x).toBe(0);
    expect(ps.pmTime).toBe(50);
    expect(ps.torsoTimer).toBe(100);
    ps.pmType = MoveType.PM_NOCLIP;
    movePlayer(ps, command(40, { forwardmove: 127 }), { ...empty, trace: () => { throw new Error("noclip traced"); } });
    expect(ps.origin.x).toBeCloseTo(1.28, 5);
    expect(ps.pmTime).toBe(30);
    expect(ps.torsoTimer).toBe(80);
  });
  test("knockback timer expires before this frame's acceleration", () => {
    const ps = player();
    ps.pmFlags |= F.TIME_KNOCKBACK;
    ps.pmTime = 10;
    movePlayer(ps, command(20, { forwardmove: 127 }), flat);
    expect(ps.pmFlags & F.TIME_KNOCKBACK).toBe(0);
    expect(ps.pmTime).toBe(0);
    expect(ps.velocity.x).toBe(64);
  });
  test("landing keeps the QVM fall-event boundary for both products", () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const ps = player(product);
      ps.origin = vec3(0, 0, 134.16937255859375);
      ps.velocity = vec3(0, 0, -473);
      ps.groundEntityNum = ENTITYNUM_NONE;
      const result = movePlayer(ps, command(200), { ...flat, fixedMsec: 200 });
      // Source MULF4/SUBF4 and sqrt's float return produce impact 39.999996185302734.
      expect(ps.origin.z).toBe(24);
      expect(eventIds(result.events)).toEqual([E.EV_FALL_SHORT]);
      expect(ps.pmTime).toBe(250);

      const wrapped = player(product);
      wrapped.origin = vec3(0, 0, 1097.741943359375);
      wrapped.velocity = vec3(0, 0, -2147483.75);
      wrapped.gravity = -2147483648;
      wrapped.groundEntityNum = ENTITYNUM_NONE;
      const overflow = movePlayer(wrapped, command(1), flat);
      // CrashLand applies NEGI4 to integer gravity before CVIF4, retaining INT_MIN.
      expect(wrapped.origin.z).toBe(24);
      expect(wrapped.velocity.z).toBe(0);
      expect(eventIds(overflow.events)).toEqual([E.EV_FALL_FAR]);
      expect(wrapped.pmTime).toBe(250);
    }
  });
  test("landing computes source fall event and 250ms landing timer", () => {
    const ps = player();
    ps.origin = vec3(0, 0, 25);
    ps.velocity = vec3(0, 0, -800);
    ps.groundEntityNum = ENTITYNUM_NONE;
    const result = movePlayer(ps, command(20), flat);
    expect(eventIds(result.events)).toContain(E.EV_FALL_FAR);
    expect(ps.pmTime).toBe(250);
    expect(ps.legsTimer).toBe(130);
  });
});

describe("source weapon, animation and Team Arena state machine", () => {
  test("all source weapons have the original repeat delay", () => {
    const timings: readonly (readonly [Weapon, number])[] = [
      [Weapon.WP_GAUNTLET, 400], [Weapon.WP_MACHINEGUN, 100], [Weapon.WP_SHOTGUN, 1000],
      [Weapon.WP_GRENADE_LAUNCHER, 800], [Weapon.WP_ROCKET_LAUNCHER, 800],
      [Weapon.WP_LIGHTNING, 50], [Weapon.WP_RAILGUN, 1500], [Weapon.WP_PLASMAGUN, 100],
      [Weapon.WP_BFG, 200], [Weapon.WP_GRAPPLING_HOOK, 400], [Weapon.WP_NAILGUN, 1000],
      [Weapon.WP_PROX_LAUNCHER, 800], [Weapon.WP_CHAINGUN, 30],
    ];
    for (const [weapon, milliseconds] of timings) {
      const ps = player(weapon >= Weapon.WP_NAILGUN ? "missionpack" : "baseq3");
      ps.weapon = weapon;
      ps.ammo.set(weapon, 1);
      ps.stats.set(statSchema(ps.product).weapons, 1 << weapon);
      const result = movePlayer(ps, command(10, { weapon, buttons: B.ATTACK }), { ...flat, gauntletHit: true });
      expect(ps.weaponTime).toBe(milliseconds);
      expect(ps.ammo.get(weapon)).toBe(0);
      expect(eventIds(result.events)).toEqual([E.EV_FIRE_WEAPON]);
    }
  });
  test("machinegun fires every 100ms, consumes ammo and accumulates all substep events", () => {
    const ps = player();
    const result = movePlayer(ps, command(210, { buttons: B.ATTACK }), { ...flat, fixedMsec: 10 });
    expect(eventIds(result.events)).toEqual([E.EV_FIRE_WEAPON, E.EV_FIRE_WEAPON, E.EV_FIRE_WEAPON]);
    expect(ps.ammo.get(Weapon.WP_MACHINEGUN)).toBe(97);
    expect(ps.weaponTime).toBe(100);
    expect(ps.weaponState).toBe(WeaponState.WEAPON_FIRING);
    expect(ps.eFlags & 0x100).toBe(0x100);
  });
  test("empty weapon waits 500ms and infinite gauntlet requires a hit", () => {
    const ps = player();
    ps.ammo.set(ps.weapon, 0);
    const result = movePlayer(ps, command(10, { buttons: B.ATTACK }), flat);
    expect(eventIds(result.events)).toEqual([E.EV_NOAMMO]);
    expect(ps.weaponTime).toBe(500);
    ps.weapon = Weapon.WP_GAUNTLET;
    ps.weaponTime = 0;
    const miss = movePlayer(ps, command(20, { buttons: B.ATTACK, weapon: Weapon.WP_GAUNTLET }), flat);
    expect(miss.events).toHaveLength(0);
    const hit = movePlayer(ps, command(30, { buttons: B.ATTACK, weapon: Weapon.WP_GAUNTLET }), { ...flat, gauntletHit: true });
    expect(eventIds(hit.events)).toEqual([E.EV_FIRE_WEAPON]);
    expect(ps.ammo.get(Weapon.WP_GAUNTLET)).toBe(-1);
    expect(ps.weaponTime).toBe(400);
  });
  test("weapon switch drops 200ms, raises 250ms, then accepts firing", () => {
    const ps = player();
    const options = { ...flat, fixedMsec: 10, gauntletHit: true };
    movePlayer(ps, command(10, { weapon: Weapon.WP_GAUNTLET }), options);
    expect(ps.weaponState).toBe(WeaponState.WEAPON_DROPPING);
    expect(ps.weaponTime).toBe(200);
    movePlayer(ps, command(210, { weapon: Weapon.WP_GAUNTLET }), options);
    expect(ps.weaponState).toBe(WeaponState.WEAPON_RAISING);
    expect(ps.weapon).toBe(Weapon.WP_GAUNTLET);
    expect(ps.weaponTime).toBe(250);
    movePlayer(ps, command(460, { weapon: Weapon.WP_GAUNTLET, buttons: B.ATTACK }), options);
    expect(ps.weaponState).toBe(WeaponState.WEAPON_READY);
    const fire = movePlayer(ps, command(470, { weapon: Weapon.WP_GAUNTLET, buttons: B.ATTACK }), options);
    expect(eventIds(fire.events)).toContain(E.EV_FIRE_WEAPON);
  });
  test("talk suppresses actions and respawn suppresses attack until release", () => {
    const ps = player();
    ps.pmFlags |= F.RESPAWNED;
    expect(movePlayer(ps, command(20, { buttons: B.ATTACK }), flat).events).toHaveLength(0);
    movePlayer(ps, command(40), flat);
    expect(ps.pmFlags & F.RESPAWNED).toBe(0);
    const result = movePlayer(ps, command(200, { forwardmove: 127, buttons: B.TALK | B.ATTACK }), flat);
    expect(result.events).toHaveLength(0);
    expect(ps.origin.x).toBe(0);
    expect(ps.eFlags & 0x1000).toBe(0x1000);
  });
  test("medkit is held at max+25 and use events latch until release", () => {
    const ps = player();
    const medkit = itemList(ps.product).findIndex(item => item.className === "holdable_medkit");
    ps.stats.set(statSchema(ps.product).holdableItem, medkit);
    ps.health = 125;
    expect(movePlayer(ps, command(10, { buttons: B.USE_HOLDABLE }), flat).events).toHaveLength(0);
    expect(ps.stats.get(statSchema(ps.product).holdableItem)).toBe(medkit);
    ps.health = 124;
    const use = movePlayer(ps, command(20, { buttons: B.USE_HOLDABLE }), flat);
    expect(eventIds(use.events)).toEqual([E.EV_USE_ITEM2]);
    expect(ps.stats.get(statSchema(ps.product).holdableItem)).toBe(0);
    expect(movePlayer(ps, command(30, { buttons: B.USE_HOLDABLE }), flat).events).toHaveLength(0);
  });
  test("missionpack scout beats haste and chaingun truncates 30/1.5 to 20ms", () => {
    const ps = player("missionpack");
    ps.weapon = Weapon.WP_CHAINGUN;
    ps.ammo.set(ps.weapon, 20);
    ps.stats.set(statSchema(ps.product).weapons, 1 << ps.weapon);
    const schema = statSchema("missionpack");
    if (schema.product !== "missionpack") throw new Error("Wrong test schema");
    ps.stats.set(schema.persistentPowerup, itemList(ps.product).findIndex(item => item.className === "item_scout"));
    ps.powerups.set(Powerup.PW_HASTE, 1000);
    movePlayer(ps, command(10, { weapon: ps.weapon, buttons: B.ATTACK }), flat);
    expect(ps.weaponTime).toBe(20);
  });
  test("missionpack invulnerability expands sphere and immobilizes the player", () => {
    const ps = player("missionpack");
    ps.origin = vec3(0, 0, 100);
    ps.velocity = vec3(400, 0, -100);
    ps.powerups.set(Powerup.PW_INVULNERABILITY, 1000);
    ps.pmFlags |= F.INVULEXPAND;
    const result = movePlayer(ps, command(20, { forwardmove: 127 }), empty);
    expect(result.bounds).toEqual({ min: vec3(-42, -42, -42), max: vec3(42, 42, 42) });
    expect(ps.velocity).toEqual(vec3(0, 0, 0));
    expect(ps.origin).toEqual(vec3(0, 0, 100));
  });
  test("gesture uses 2294ms while missionpack commands use 600ms", () => {
    const ps = player();
    const result = movePlayer(ps, command(10, { buttons: B.GESTURE }), flat);
    expect(ps.torsoTimer).toBe(2294);
    expect(ps.torsoAnim & ~128).toBe(A.TORSO_GESTURE);
    expect(eventIds(result.events)).toContain(E.EV_TAUNT);
    const mission = player("missionpack");
    movePlayer(mission, command(10, { buttons: B.GETFLAG }), flat);
    expect(mission.torsoTimer).toBe(600);
    expect(mission.torsoAnim & ~128).toBe(A.TORSO_GETFLAG);
  });
});
