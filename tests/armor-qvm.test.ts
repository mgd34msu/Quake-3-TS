import { expect, test } from "bun:test";
import { uint32 } from "../src/core/numeric.ts";
import { checkArmor, DamageFlags } from "../src/game/combat.ts";
import { EntityPool } from "../src/game/entities.ts";
import { statSchema } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";

const products: readonly Product[] = ["baseq3", "missionpack"];

function armorFixture(product: Product) {
  const pool = new EntityPool({ print: () => {},
    product,
    maxClients: 1,
    mapStartTime: 0,
    time: () => 0,
    link: () => {},
    unlink: () => {},
  });
  const target = pool.at(0);
  const client = target.client;
  if (client === null) throw new Error("Armor fixture requires a client entity");
  return { target, client, armorSlot: statSchema(product).armor };
}

test("CheckArmor matches QVM results at known float32 boundaries", () => {
  const cases: readonly (readonly [number, number])[] = [
    [1, 1],
    [3, 2],
    [150, 100],
    [300, 199],
    [10_000, 6_601],
  ];
  for (const product of products) {
    const { target, client, armorSlot } = armorFixture(product);
    for (const [damage, expected] of cases) {
      client.ps.stats.set(armorSlot, 1_000_000);
      expect(checkArmor(target, damage, 0)).toBe(expected);
      expect(client.ps.stats.get(armorSlot)).toBe(1_000_000 - expected);
    }
  }
});

test("CheckArmor matches QVM digests for every damage from 1 through 10000", () => {
  // Unchanged g_combat.c compiled by pinned q3lcc and ran in the original QVM interpreter.
  const expected = [
    0xc07bd546, 0x42b02ee5, 0x2ed5fcfb, 0x7a0ca2c3, 0x2e0e2288,
    0x1e35d1a1, 0xa6307aa9, 0xece0d6fd, 0x05619efd, 0x7c7a751b,
  ];
  for (const product of products) {
    const { target, client, armorSlot } = armorFixture(product);
    const actual: number[] = [];
    for (let chunk = 0; chunk < 10; chunk++) {
      let hash = 0x811c9dc5;
      for (let damage = chunk * 1_000 + 1; damage <= chunk * 1_000 + 1_000; damage++) {
        client.ps.stats.set(armorSlot, 1_000_000);
        const save = checkArmor(target, damage, 0);
        hash = uint32(Math.imul(hash ^ damage, 0x01000193));
        hash = uint32(Math.imul(hash ^ save, 0x01000193));
      }
      actual.push(hash);
    }
    expect(actual).toEqual(expected);
  }
});

test("CheckArmor preserves source caps, bypasses, and negative-input behavior", () => {
  const { target, client, armorSlot } = armorFixture("baseq3");
  const run = (damage: number, armor: number, flags = 0): readonly [number, number] => {
    client.ps.stats.set(armorSlot, armor);
    const save = checkArmor(target, damage, flags);
    return [save, client.ps.stats.get(armorSlot)];
  };

  expect(run(150, 99)).toEqual([99, 0]);
  expect(run(150, 0)).toEqual([0, 0]);
  expect(run(150, -4)).toEqual([-4, 0]);
  expect(run(0, 17)).toEqual([0, 17]);
  expect(run(-1, 17)).toEqual([0, 17]);
  expect(run(-2, 17)).toEqual([-1, 18]);
  expect(run(-150, 17)).toEqual([-99, 116]);
  expect(run(150, 17, DamageFlags.NO_ARMOR)).toEqual([0, 17]);
  expect(run(3, 17, DamageFlags.NO_PROTECTION)).toEqual([2, 15]);

  target.client = null;
  expect(checkArmor(target, 150, 0)).toBe(0);
});
