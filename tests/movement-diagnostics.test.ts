import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { MoveType, Weapon } from "../src/shared/definitions.ts";
import { MovementDiagnostics, movePlayer } from "../src/shared/movement.ts";
import type { MovementTrace, MovementTraceFunction } from "../src/shared/movement.ts";
import { createPlayerState, ENTITYNUM_NONE, ENTITYNUM_WORLD } from "../src/shared/player-state.ts";
import type { UserCommand } from "../src/shared/player-state.ts";
import { stepSlideMove } from "../src/shared/slide-move.ts";
import type { SlideMoveContext } from "../src/shared/slide-move.ts";

function clear(end: Vec3): MovementTrace {
  return { fraction: 1, end, solidity: "clear", contact: { kind: "none" }, surfaceFlags: 0, contents: 0, entityNum: ENTITYNUM_NONE };
}
function solid(end: Vec3): MovementTrace {
  return { fraction: 0, end, solidity: "all-solid", contact: { kind: "none" }, surfaceFlags: 0, contents: 1, entityNum: ENTITYNUM_WORLD };
}
function impact(end: Vec3, normal = vec3(0, 0, 1)): MovementTrace {
  return { fraction: 0, end, solidity: "clear", contact: { kind: "plane", plane: { normal, distance: 0 } },
    surfaceFlags: 0, contents: 1, entityNum: ENTITYNUM_WORLD };
}
function command(time: number): UserCommand {
  return { serverTime: time, angles: vec3(0, 0, 0), buttons: 0, weapon: Weapon.WP_NONE, forwardmove: 0, rightmove: 0, upmove: 0 };
}
function player() {
  const ps = createPlayerState("baseq3");
  ps.health = 100;
  ps.gravity = 800;
  ps.speed = 320;
  ps.viewheight = 26;
  ps.groundEntityNum = ENTITYNUM_NONE;
  return ps;
}

describe("source movement diagnostics", () => {
  test("counter advances for every substep and silent spectator, but not zero-time commands", () => {
    const output: string[] = [], diagnostics = new MovementDiagnostics(text => { output.push(text); });
    const ps = player();
    ps.pmType = MoveType.PM_SPECTATOR;
    const trace: MovementTraceFunction = (_start, end) => clear(end);
    movePlayer(ps, command(100), { trace, pointContents: () => 0, diagnostics: { state: diagnostics, level: 0 } });
    expect(diagnostics.count).toBe(2);
    expect(output).toEqual([]);
    movePlayer(ps, command(100), { trace, pointContents: () => 0, diagnostics: { state: diagnostics, level: 1 } });
    expect(diagnostics.count).toBe(2);
    ps.pmType = MoveType.PM_NORMAL;
    ps.groundEntityNum = ENTITYNUM_WORLD;
    movePlayer(ps, command(101), { trace, pointContents: () => 0, diagnostics: { state: diagnostics, level: -1 } });
    expect(output).toEqual(["3:lift\n"]);
    diagnostics.count = 0x7fffffff;
    ps.groundEntityNum = ENTITYNUM_WORLD;
    movePlayer(ps, command(102), { trace, pointContents: () => 0, diagnostics: { state: diagnostics, level: 1 } });
    expect(diagnostics.count).toBe(-0x80000000);
    expect(output[1]).toBe("-2147483648:lift\n");
    const separate = new MovementDiagnostics(() => undefined);
    expect(separate.count).toBe(0);
  });

  test("all-solid diagnostics precede jitter traces and failed step diagnostics", () => {
    const output: string[] = [], diagnostics = new MovementDiagnostics(text => { output.push(text); });
    const trace: MovementTraceFunction = (start) => { output.push("trace"); return solid(start); };
    movePlayer(player(), command(1), { trace, pointContents: () => 0, diagnostics: { state: diagnostics, level: 1 } });
    expect(output[0]).toBe("trace");
    expect(output[1]).toBe("1:allsolid\n");
    expect(output.filter(line => line !== "trace")).toEqual(["1:allsolid\n", "1:bend can't step\n", "1:allsolid\n"]);
  });

  test("ground contact emits Land, kickoff and steep at their reached source branches", () => {
    for (const kind of ["Land", "kickoff", "steep"]) {
      const output: string[] = [], diagnostics = new MovementDiagnostics(text => { output.push(text); });
      const ps = player();
      if (kind === "kickoff") ps.velocity = vec3(0, 0, 100);
      const trace: MovementTraceFunction = (start, end) => end.z === Math.fround(start.z - 0.25)
        ? impact(start, kind === "steep" ? vec3(1, 0, 0) : vec3(0, 0, 1)) : clear(end);
      movePlayer(ps, command(1), { trace, pointContents: () => 0, diagnostics: { state: diagnostics, level: 1 } });
      expect(output[0]).toBe(`1:${kind}\n`);
    }
  });

  test("step completion prints after its event, and binary32 delta does not invent a step", () => {
    for (const startZ of [0, -Math.pow(2, -25)]) {
      const ps = player(), output: string[] = [];
      ps.origin = vec3(0, 0, startZ);
      let calls = 0;
      const trace: MovementTraceFunction = (start, end) => {
        calls++;
        if (calls === 1) return solid(start);
        if (calls === 2) return impact(start);
        if (calls === 3) return clear(vec3(0, 0, startZ === 0 ? 4 : 2));
        if (calls === 4) return clear(end);
        return impact(start);
      };
      const context: SlideMoveContext = { state: ps, frameTime: 0.001,
        bounds: { min: vec3(-15, -15, -24), max: vec3(15, 15, 32) }, mask: 1,
        trace, groundNormal: null, impactSpeed: 0, touch: () => undefined,
        event: event => { output.push(`event ${event}`); }, debug: message => { output.push(message); } };
      stepSlideMove(context, false);
      expect(output).toEqual(startZ === 0 ? ["event 6", "stepped"] : ["stepped"]);
    }
  });
});
