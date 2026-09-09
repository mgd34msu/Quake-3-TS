import { expect, test } from "bun:test";
import { ShaderRemapRegistry } from "../src/game/shader-remaps.ts";

function fixture() {
  const warnings: string[] = [];
  const registry = new ShaderRemapRegistry(message => { warnings.push(message); });
  return { registry, warnings };
}

test("shader remaps use QVM formatting and replace ASCII-case-insensitive matches in place", () => {
  const { registry, warnings } = fixture();
  registry.add("Textures/ONE", "first", 1.25);
  registry.add("textures/two", "second", -2.75);
  registry.add("textures/one", "replacement", 3.125);
  // Extracted functions running in the original QVM interpreter produced this byte string.
  expect(registry.buildShaderStateConfig()).toBe(
    "Textures/ONE=replacement:    3.12@textures/two=second:   -2.75@",
  );
  expect(warnings).toEqual([]);
});

test("shader remap state belongs to each registry instance", () => {
  const first = fixture().registry;
  const second = fixture().registry;
  first.add("old", "new", 1);
  expect(first.buildShaderStateConfig()).toBe("old=new:    1.00@");
  expect(second.buildShaderStateConfig()).toBe("");
});

test("shader remap matching folds only ASCII and honors C string terminators", () => {
  const { registry } = fixture();
  registry.add("TEXTURES/A\0ignored", "new/a\0ignored", 0);
  registry.add("textures/a", "new/b", 1);
  registry.add("\u00c0", "upper", 2);
  registry.add("\u00e0", "lower", 3);
  expect(registry.buildShaderStateConfig()).toBe(
    "TEXTURES/A=new/b:    1.00@\u00c0=upper:    2.00@\u00e0=lower:    3.00@",
  );
});

test("shader remaps preserve MAX_QPATH and per-entry Com_sprintf bounds", () => {
  const { registry, warnings } = fixture();
  const longest = "x".repeat(63);
  registry.add(longest, longest, 0);
  const state = registry.buildShaderStateConfig();
  expect(state).toBe(`${longest}=${longest}:    `);
  expect(state.length).toBe(132);
  expect(warnings).toEqual(["Com_sprintf: overflow of 137 in 133\n"]);
  expect(() => registry.add("x".repeat(64), "new", 0)).toThrow(RangeError);
  expect(() => registry.add("old", "x".repeat(64), 0)).toThrow(RangeError);
  expect(() => registry.add("old", "bad-\u0100", 0)).toThrow(RangeError);
});

test("shader remap entry warnings use the source 132-byte boundary and ordering", () => {
  const { registry, warnings } = fixture();
  registry.add("a".repeat(60), "b".repeat(61), 0);
  registry.add("c".repeat(61), "d".repeat(61), 0);
  registry.add("e".repeat(62), "f".repeat(61), 0);
  registry.buildShaderStateConfig();
  expect(warnings).toEqual([
    "Com_sprintf: overflow of 133 in 133\n",
    "Com_sprintf: overflow of 134 in 133\n",
  ]);
});

test("shader remaps cap distinct entries at 128 but still replace existing entries", () => {
  const { registry } = fixture();
  for (let index = 0; index < 128; index++) {
    registry.add(`old${index}`, `new${index}`, index);
  }
  registry.add("ignored", "ignored-new", 200);
  registry.add("OLD0", "updated", 300);
  const state = registry.buildShaderStateConfig();
  expect(state).toStartWith("old0=updated:  300.00@old1=new1:    1.00@");
  expect(state).not.toContain("ignored-new");
  expect(state.match(/@/g)?.length).toBe(128);
});

test("shader state Q_strcat truncates the 4096-byte config buffer without overflow", () => {
  const { registry } = fixture();
  for (let index = 0; index < 128; index++) {
    registry.add(`old-${index}-${"o".repeat(24)}`, `new-${index}-${"n".repeat(24)}`, index + 0.5);
  }
  const state = registry.buildShaderStateConfig();
  expect(state.length).toBe(4095);
  expect(state).toStartWith("old-0-oooooooooooooooooooooooo=new-0-nnnnnnnnnnnnnnnnnnnnnnnn:    0.50@");
  expect(state).toEndWith("old-56-oooooooooooooooooooo");
  expect(state.match(/@/g)?.length).toBe(56);
});

test("shader state warns for every oversized entry after the config buffer fills", () => {
  const { registry, warnings } = fixture();
  const expectedWarnings: string[] = [];
  for (let index = 0; index < 128; index++) {
    const prefix = index.toString().padStart(3, "0");
    const extraByte = index % 2;
    registry.add(`${prefix}${"o".repeat(58 + extraByte)}`, `${prefix}${"n".repeat(58)}`, 0);
    expectedWarnings.push(`Com_sprintf: overflow of ${133 + extraByte} in 133\n`);
  }
  expect(registry.buildShaderStateConfig().length).toBe(4095);
  expect(warnings).toEqual(expectedWarnings);
});

test("shader remaps reject float inputs whose source formatting is undefined", () => {
  const { registry } = fixture();
  expect(() => registry.add("old", "new", Number.NaN)).toThrow(RangeError);
  expect(() => registry.add("old", "new", Number.POSITIVE_INFINITY)).toThrow(RangeError);
  expect(() => registry.add("old", "new", 2_147_483_648)).toThrow(RangeError);
  expect(registry.buildShaderStateConfig()).toBe("");
});
