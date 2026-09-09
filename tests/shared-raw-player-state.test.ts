import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import { EntityEvent, EntityType, MoveType, WeaponState } from "../src/shared/definitions.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { touchJumpPad } from "../src/shared/jump-pad.ts";
import { movePlayer, updateViewAngles } from "../src/shared/movement.ts";
import type { MovementOptions } from "../src/shared/movement.ts";
import { CommandButtons, ENTITYNUM_NONE, PlayerStateRecord } from "../src/shared/player-state.ts";
import type { SourcePlayerState, UserCommand } from "../src/shared/player-state.ts";
import { playerStateToEntityState, playerStateToEntityStateExtraPolate } from "../src/shared/snapshot-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";

function player(pmType = 0, weapon = 0, weaponState = 0): SourcePlayerState {
  const ps = new PlayerStateRecord<number, number, number>("baseq3", pmType, weapon, weaponState);
  ps.health = 100;
  ps.gravity = 800;
  ps.speed = 320;
  ps.groundEntityNum = ENTITYNUM_NONE;
  return ps;
}

function command(weapon = 0, buttons = 0): UserCommand {
  return { serverTime: 1, angles: vec3(0, 0, 0), buttons, weapon, forwardmove: 0, rightmove: 0, upmove: 0 };
}

const options: MovementOptions = {
  trace: (_start, end) => ({ fraction: 1, end, solidity: "clear", contact: { kind: "none" },
    surfaceFlags: 0, contents: 0, entityNum: ENTITYNUM_NONE }),
  pointContents: () => 0,
};

describe("raw player-state source consumers", () => {
  test("both entity conversions copy raw weapon and only compare the source invisible modes", () => {
    for (const mode of [-1, MoveType.PM_SPECTATOR, MoveType.PM_INTERMISSION, MoveType.PM_SPINTERMISSION, 255]) {
      const ps = player(mode, 255, 99), entity = new EntityState();
      ps.addEvent(EntityEvent.EV_JUMP, 17);
      playerStateToEntityState(ps, entity, false);
      expect(entity.eType).toBe(mode === MoveType.PM_SPECTATOR || mode === MoveType.PM_INTERMISSION
        ? EntityType.ET_INVISIBLE : EntityType.ET_PLAYER);
      expect(entity.weapon).toBe(255);
      expect(ps.weaponState).toBe(99);
      expect(entity.eventParm).toBe(17);
      playerStateToEntityStateExtraPolate(ps, entity, 42, true);
      expect(entity.pos.type).toBe(TrajectoryType.TR_LINEAR_STOP);
      expect(entity.pos.time).toBe(42);
      expect(entity.pos.duration).toBe(50);
      expect(entity.weapon).toBe(255);
    }
  });

  test("unknown movement modes follow source comparisons instead of an enum rejection", () => {
    const belowDead = player(-1), aboveDead = player(255);
    const cmd = { ...command(), forwardmove: 127 };
    movePlayer(belowDead, cmd, options);
    movePlayer(aboveDead, cmd, options);
    expect(belowDead.pmType).toBe(-1);
    expect(belowDead.origin.x).toBeGreaterThan(0);
    expect(aboveDead.pmType).toBe(255);
    expect(aboveDead.origin.x).toBe(0);
    expect(aboveDead.origin.z).toBeLessThan(0);
    expect(aboveDead.commandTime).toBe(1);
  });

  test("source early-return modes preserve unknown weapons and weapon states", () => {
    for (const mode of [MoveType.PM_FREEZE, MoveType.PM_SPECTATOR, MoveType.PM_NOCLIP,
      MoveType.PM_INTERMISSION, MoveType.PM_SPINTERMISSION]) {
      const ps = player(mode, 255, 99);
      movePlayer(ps, command(255), options);
      expect(ps.weapon).toBe(255);
      expect(ps.weaponState).toBe(99);
      expect(ps.commandTime).toBe(1);
    }
  });

  test("unknown weapon states retain timer suppression and reach the ordinary ready branch", () => {
    const delayed = player(0, 255, 99);
    delayed.weaponTime = 200;
    movePlayer(delayed, command(255), options);
    expect(delayed.weaponTime).toBe(199);
    expect(delayed.weaponState).toBe(99);
    const ready = player(0, 255, 99);
    movePlayer(ready, command(255), options);
    expect(ready.weapon).toBe(255);
    expect(ready.weaponState).toBe(WeaponState.WEAPON_READY);
  });

  test("an unnamed but bounded ammo slot fires with the source default cadence", () => {
    const ps = player(0, 15, 99);
    ps.ammo.set(15, 5);
    const result = movePlayer(ps, command(15, CommandButtons.ATTACK), options);
    expect(ps.weapon).toBe(15);
    expect(ps.weaponState).toBe(WeaponState.WEAPON_FIRING);
    expect(ps.ammo.get(15)).toBe(4);
    expect(ps.weaponTime).toBe(400);
    expect(result.events.map(event => event.event)).toContain(EntityEvent.EV_FIRE_WEAPON);
  });

  test("undefined ammo storage is rejected only when source short-circuiting reaches the access", () => {
    const frozen = player(MoveType.PM_FREEZE, 255, 99);
    expect(() => movePlayer(frozen, command(255, CommandButtons.ATTACK), options))
      .toThrow("Player state slot 255 outside 16");
    const intermission = player(MoveType.PM_INTERMISSION, 255, 99);
    movePlayer(intermission, command(255, CommandButtons.ATTACK), options);
    expect(intermission.commandTime).toBe(1);
    expect(intermission.weaponState).toBe(99);
  });

  test("view angles and jump pads apply their exact mode comparisons to raw values", () => {
    const ps = player(255, 255, 99), pad = new EntityState();
    updateViewAngles(ps, { ...command(255), angles: vec3(0, 16384, 0) });
    expect(ps.viewangles.y).toBe(90);
    pad.number = 7;
    pad.origin2 = vec3(0, 0, 500);
    touchJumpPad(ps, pad);
    expect(ps.jumppadEnt).toBe(0);
    expect(ps.velocity).toEqual(vec3(0, 0, 0));
    ps.pmType = MoveType.PM_NORMAL;
    touchJumpPad(ps, pad);
    expect(ps.jumppadEnt).toBe(7);
    expect(ps.velocity).toEqual(vec3(0, 0, 500));
  });
});
