// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { describe, expect, test } from "bun:test";
import { EntityPool } from "../../src/game/entities.ts";
import { GameLevel } from "../../src/game/runtime.ts";
import { GameRankReports } from "../../src/game/rank-reports.ts";
import type { RankReportConsumer } from "../../src/game/rank-reports.ts";
import { GameType, Holdable, Powerup, Team, Weapon } from "../../src/shared/definitions.ts";
import type { Product } from "../../src/shared/definitions.ts";
import { ENTITYNUM_WORLD } from "../../src/shared/player-state.ts";

type IntReport = [number, number, number, number, number];
function fixture(product: Product = "baseq3") {
  const level = new GameLevel();
  const pool = new EntityPool({ product, maxClients: 4, mapStartTime: 0, time: () => level.time,
    print: () => undefined, link: () => undefined, unlink: () => undefined });
  const ints: IntReport[] = [], strings: [number, number, number, string][] = [];
  const consumer: RankReportConsumer = {
    reportInt: (self, other, key, value, accumulate) => { ints.push([self, other, key, value, accumulate]); },
    reportString: (self, other, key, value) => { strings.push([self, other, key, value]); },
  };
  const game = { level, pool, gameType: GameType.GT_FFA, product };
  return { level, pool, ints, strings, game, consumer, reports: new GameRankReports(game, consumer) };
}

describe("g_rankings.c report bodies", () => {
  test("shotgun pellets deduplicate consecutive hits, not damage, and hazards replace the dedup tuple", () => {
    const f = fixture();
    f.reports.damage(0, 1, 10, 1);
    expect(f.ints).toEqual([
      [0, -1, 1111020004, 1, 1], [0, -1, 1111020304, 1, 1],
      [0, -1, 1111020006, 10, 1], [0, -1, 1111020306, 10, 1],
      [1, -1, 1111020003, 1, 1], [1, -1, 1111020303, 1, 1],
      [1, -1, 1111020005, 10, 1], [1, -1, 1111020305, 10, 1],
    ]);
    f.ints.length = 0;
    f.reports.damage(0, 1, 7, 1);
    expect(f.ints).toEqual([
      [0, -1, 1111020006, 7, 1], [0, -1, 1111020306, 7, 1],
      [1, -1, 1111020005, 7, 1], [1, -1, 1111020305, 7, 1],
    ]);
    f.ints.length = 0;
    f.reports.damage(0, ENTITYNUM_WORLD, 20, 14);
    expect(f.ints).toEqual([]);
    f.reports.damage(0, 1, 7, 1);
    expect(f.ints).toHaveLength(8);
    f.ints.length = 0;
    f.level.warmupTime = -1;
    f.reports.damage(0, ENTITYNUM_WORLD, 20, 14);
    f.level.warmupTime = 0;
    f.reports.damage(0, 1, 7, 1);
    expect(f.ints).toHaveLength(4);
    f.ints.length = 0;
    new GameRankReports(f.game, f.consumer).damage(0, 1, 7, 1);
    expect(f.ints).toHaveLength(8);
    f.ints.length = 0;
    f.level.frameNum++;
    f.reports.damage(0, 1, 7, 1);
    expect(f.ints).toHaveLength(8);
  });

  test("friendly rocket splash preserves victim, attacker, and teammate report order", () => {
    const f = fixture();
    f.game.gameType = GameType.GT_TEAM;
    f.pool.clientAt(0).sess.sessionTeam = Team.TEAM_RED;
    f.pool.clientAt(1).sess.sessionTeam = Team.TEAM_RED;
    f.reports.damage(0, 1, 25, 7);
    expect(f.ints).toEqual([
      [0, -1, 1111020004, 1, 1], [0, -1, 1111020504, 1, 1],
      [0, -1, 1111020006, 25, 1], [0, -1, 1111020506, 25, 1],
      [0, -1, 1111020008, 25, 1], [0, -1, 1111020508, 25, 1],
      [1, -1, 1111020003, 1, 1], [1, -1, 1111020503, 1, 1],
      [1, -1, 1111020005, 25, 1], [1, -1, 1111020505, 25, 1],
      [1, -1, 1111020007, 25, 1], [1, -1, 1111020507, 25, 1],
      [0, -1, 1111100002, 1, 1], [1, -1, 1111100001, 1, 1],
      [0, -1, 1111100004, 25, 1], [1, -1, 1111100003, 25, 1],
      [0, -1, 1111100006, 25, 1], [1, -1, 1111100005, 25, 1],
    ]);
    f.ints.length = 0;
    f.reports.damage(0, 0, 25, 7);
    expect(f.ints).toHaveLength(6);
    expect(f.ints.every(row => row[0] === 0)).toBe(true);
    f.ints.length = 0;
    f.reports.damage(0, 245, 25, 7);
    expect(f.ints).toHaveLength(6);
  });

  test("gauntlet fires on every damage call and only for client attackers", () => {
    const f = fixture();
    f.reports.fireWeapon(1, Weapon.WP_GAUNTLET);
    expect(f.ints).toEqual([]);
    f.reports.damage(0, 1, 50, 2);
    expect(f.ints[0]).toEqual([1, -1, 1111020102, 1, 1]);
    f.ints.length = 0;
    f.reports.damage(0, 1, 50, 2);
    expect(f.ints).toHaveLength(5);
    expect(f.ints[0]).toEqual([1, -1, 1111020102, 1, 1]);
    f.ints.length = 0;
    f.reports.damage(0, 245, 50, 2);
    expect(f.ints).toHaveLength(4);
    expect(f.ints[0]).toEqual([0, -1, 1111020004, 1, 1]);
  });

  test("reached attacker reads and callback failure preserve earlier reports and dedup writes", () => {
    const f = fixture();
    const record = f.consumer.reportInt;
    f.consumer.reportInt = (self, other, key, value, accumulate) => {
      record(self, other, key, value, accumulate);
      if (key === 1111020306) f.pool.at(1).client = null;
    };
    f.reports.damage(0, 1, 10, 1);
    expect(f.ints).toHaveLength(4);
    f.pool.at(1).client = f.pool.clientAt(1);
    f.consumer.reportInt = () => { throw new Error("report failed"); };
    f.level.frameNum++;
    expect(() => f.reports.damage(0, 1, 10, 1)).toThrow("report failed");
    f.consumer.reportInt = record;
    f.ints.length = 0;
    f.reports.damage(0, 1, 10, 1);
    expect(f.ints).toHaveLength(4);
    f.ints.length = 0;
    expect(() => f.reports.damage(0, 1024, 10, 1)).toThrow("Game entity 1024 is unavailable");
    expect(f.ints).toHaveLength(4);
  });

  test("world deaths, self kills, and nonclient frags retain separate source categories", () => {
    const f = fixture();
    f.reports.playerDie(0, ENTITYNUM_WORLD, 16);
    f.reports.playerDie(0, 0, 7);
    f.reports.playerDie(0, 245, 18);
    expect(f.ints).toEqual([
      [0, -1, 1111080000, 1, 1], [0, -1, 1111080300, 1, 1],
      [0, -1, 1111020001, 1, 1], [0, -1, 1111020501, 1, 1],
      [245, 0, 1211020000, 1, 1], [245, 0, 1211021100, 1, 1],
    ]);
    const base = fixture(), mission = fixture("missionpack");
    base.reports.playerDie(0, 1, 23);
    mission.reports.playerDie(0, 1, 28);
    expect(base.ints).toEqual(mission.ints);
    expect(base.ints[1]).toEqual([1, 0, 1211021000, 1, 1]);
    mission.ints.length = 0;
    mission.reports.playerDie(0, 1, 23);
    expect(mission.ints[1]).toEqual([1, 0, 1211021100, 1, 1]);
  });

  test("explicit weapon clock truncates seconds and mutates before early returns and reporting", () => {
    const f = fixture(), clock = { weapon_change_time: 100 };
    f.level.time = 1099;
    f.reports.weaponTime(0, Weapon.WP_MACHINEGUN, clock);
    expect(f.ints).toEqual([]);
    expect(clock.weapon_change_time).toBe(1099);
    f.level.time = 3599;
    f.reports.weaponTime(0, Weapon.WP_MACHINEGUN, clock);
    expect(f.ints).toEqual([[0, -1, 1111020010, 2, 1], [0, -1, 1111020210, 2, 1]]);
    f.level.time = 100;
    f.reports.weaponTime(0, Weapon.WP_MACHINEGUN, clock);
    expect(clock.weapon_change_time).toBe(100);
    f.level.time = 2200;
    f.consumer.reportInt = () => { expect(clock.weapon_change_time).toBe(2200); throw new Error("clock report failed"); };
    expect(() => f.reports.weaponTime(0, Weapon.WP_MACHINEGUN, clock)).toThrow("clock report failed");
    f.level.warmupTime = -1;
    f.level.time = 9999;
    f.reports.weaponTime(1024, Weapon.WP_MACHINEGUN, clock);
    expect(clock.weapon_change_time).toBe(2200);
  });

  test("pickup and reward samples preserve general counts, quantities, flag exceptions and string trap", () => {
    const f = fixture("missionpack");
    f.reports.fireWeapon(2, Weapon.WP_PLASMAGUN);
    f.reports.pickupWeapon(2, Weapon.WP_GRAPPLING_HOOK);
    f.reports.pickupAmmo(2, Weapon.WP_LIGHTNING, 60);
    f.reports.pickupHealth(2, 100);
    f.reports.pickupArmor(2, 5);
    f.reports.pickupPowerup(2, Powerup.PW_REDFLAG);
    f.reports.pickupPowerup(2, Powerup.PW_NEUTRALFLAG);
    f.reports.pickupPowerup(2, Powerup.PW_HASTE);
    f.reports.pickupHoldable(2, Holdable.HI_MEDKIT);
    f.reports.useHoldable(2, Holdable.HI_TELEPORTER);
    f.reports.reward(2, 0x8000);
    f.reports.reward(2, 0x8);
    f.reports.capture(2);
    f.reports.userTeamName(2, "Blue ^4team");
    expect(f.ints.map(row => [row[2], row[3]])).toEqual([
      [1111020002, 1], [1111020602, 1], [1111020009, 1], [1111021009, 1],
      [1111030000, 1], [1111030001, 60], [1111030700, 1], [1111030701, 60],
      [1111040000, 1], [1111040001, 100], [1111040400, 1],
      [1111050000, 1], [1111050001, 5], [1111050100, 1],
      [1111110000, 1], [1111060000, 1], [1111060000, 1], [1111060300, 1],
      [1111070000, 1], [1111070101, 1], [1111090000, 1], [1111090100, 1], [1111110001, 1],
    ]);
    expect(f.ints.every(row => row[0] === 2 && row[1] === -1 && row[4] === 1)).toBe(true);
    expect(f.strings).toEqual([[2, -1, 1100100007, "Blue ^4team"]]);
    f.ints.length = 0;
    f.reports.fireWeapon(2, Weapon.WP_NAILGUN);
    f.reports.pickupWeapon(2, Weapon.WP_NAILGUN);
    f.reports.pickupAmmo(2, Weapon.WP_NAILGUN, -3);
    f.reports.pickupHoldable(2, Holdable.HI_KAMIKAZE);
    f.reports.useHoldable(2, Holdable.HI_KAMIKAZE);
    f.reports.reward(2, 0x8008);
    expect(f.ints).toEqual([[2, -1, 1111020002, 1, 1], [2, -1, 1111020009, 1, 1],
      [2, -1, 1111030000, 1, 1], [2, -1, 1111030001, -3, 1]]);
  });

  test("every report body returns during warmup before entity reads, clock writes or callbacks", () => {
    const f = fixture(), clock = { weapon_change_time: 77 };
    f.level.warmupTime = -1;
    f.reports.fireWeapon(1024, 2); f.reports.damage(1024, 1024, 5, 2);
    f.reports.playerDie(1024, 1024, 2); f.reports.weaponTime(1024, 2, clock);
    f.reports.pickupWeapon(1024, 2); f.reports.pickupAmmo(1024, 2, 5);
    f.reports.pickupHealth(1024, 5); f.reports.pickupArmor(1024, 5);
    f.reports.pickupPowerup(1024, 1); f.reports.pickupHoldable(1024, 1);
    f.reports.useHoldable(1024, 1); f.reports.reward(1024, 8);
    f.reports.capture(1024); f.reports.userTeamName(1024, "warmup");
    expect(f.ints).toEqual([]); expect(f.strings).toEqual([]);
    expect(clock.weapon_change_time).toBe(77);
  });
});
