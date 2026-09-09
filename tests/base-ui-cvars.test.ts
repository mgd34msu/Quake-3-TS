import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CvarFlag, CvarRegistry, CvarVmStringError } from "../src/core/cvar.ts";
import type { VmCvarRead } from "../src/core/cvar.ts";
import { BASE_UI_CVARS, BaseUiCvars } from "../src/ui/base/cvars.ts";
import { baseFixture } from "./base-ui-fixture.ts";

function words(mirror: VmCvarRead): readonly [string, number, number, number] {
  return [mirror.value, mirror.numericValue, mirror.integerValue, mirror.modificationCount];
}

test("base UI allocation retains zero cells without cvar registration or operation callbacks", () => {
  const prints: string[] = [], registry = new CvarRegistry(text => { prints.push(text); });
  registry.set("g_spSkill", "4");
  registry.register("cg_marks", "0", CvarFlag.Latch);
  registry.set("cg_marks", "1");
  const before = registry.snapshots(), flags = registry.modifiedFlags, output = [...prints];
  const ui = new BaseUiCvars(registry, () => { throw new Error("No operation during allocation"); });
  for (const [name] of BASE_UI_CVARS) {
    expect(words(ui.get(name))).toEqual(["", 0, 0, 0]);
    expect(ui.get(name)).toBe(ui.get(name));
  }
  expect(new Set(BASE_UI_CVARS.map(([name]) => ui.get(name))).size).toBe(47);
  expect(registry.snapshots()).toEqual(before);
  expect(registry.indexCount).toBe(2);
  expect(registry.modifiedFlags).toBe(flags);
  expect(prints).toEqual(output);
  expect(() => ui.get("missing")).toThrow("Unknown base UI VM cvar missing");
});

test("base UI register traverses the exact source table and preserves every cell on repeated registration", () => {
  // Independently extracted q3_ui/ui_main.c cvarTable name/default/flag records.
  expect(createHash("sha256").update(JSON.stringify(BASE_UI_CVARS)).digest("hex"))
    .toBe("e8beccf69dfddfd67aa618bec12a09cd16cc2e4abad6da1b3ba6810da63cb192");
  const registry = new CvarRegistry(), trace: string[] = [];
  const ui = new BaseUiCvars(registry, () => { trace.push("guard"); });
  const cells = BASE_UI_CVARS.map(([name]) => ui.get(name));
  const register = registry.register.bind(registry);
  registry.register = (name, value, flags) => { trace.push(name); return register(name, value, flags); };
  const order = BASE_UI_CVARS.flatMap(([name]) => ["guard", name]);
  for (let pass = 0; pass < 2; pass++) {
    trace.length = 0;
    ui.register();
    expect(trace).toEqual(order);
    expect(registry.indexCount).toBe(47);
    for (const [index, [name, value, flags]] of BASE_UI_CVARS.entries()) {
      expect(cells[index]).toBe(ui.get(name));
      expect(ui.get(name).value).toBe(value);
      expect(ui.get(name).modificationCount).toBe(1);
      expect(registry.get(name)?.flags).toBe(flags);
      expect(registry.get(name)?.resetValue).toBe(value);
    }
  }
});

test("base UI registration applies existing latch, user-created promotion and source defaults", () => {
  const prints: string[] = [], registry = new CvarRegistry(text => { prints.push(text); });
  registry.set("ui_ffa_fraglimit", "35");
  registry.register("g_spSkill", "1", CvarFlag.Latch | CvarFlag.ServerInfo);
  registry.set("g_spSkill", "4");
  const ui = new BaseUiCvars(registry, () => undefined);
  const cell = ui.get("g_spSkill");
  ui.register();
  expect(registry.get("ui_ffa_fraglimit")?.resetValue).toBe("20");
  expect(registry.get("ui_ffa_fraglimit")?.flags).toBe(CvarFlag.Archive);
  expect(ui.get("ui_ffa_fraglimit").value).toBe("35");
  expect(words(cell)).toEqual(["4", 4, 4, 3]);
  expect(registry.get("g_spSkill")?.resetValue).toBe("1");
  expect(registry.get("g_spSkill")?.flags).toBe(CvarFlag.Latch | CvarFlag.ServerInfo | CvarFlag.Archive);
  expect(registry.get("g_spSkill")?.latchedValue).toBeUndefined();
  registry.set("g_spSkill", "5");
  ui.update();
  expect(words(cell)).toEqual(["4", 4, 4, 4]);
  ui.register();
  expect(ui.get("g_spSkill")).toBe(cell);
  expect(words(cell)).toEqual(["5", 5, 5, 5]);
  registry.set("g_spScores1", "blocked");
  expect(registry.get("g_spScores1")?.value).toBe("");
  expect(prints.at(-1)).toBe("g_spScores1 is read only.\n");
  expect(registry.modifiedFlags & CvarFlag.Archive).toBe(CvarFlag.Archive);
});

test("partial first registration retains reached writes and retries the failed row on the same cells", () => {
  const registry = new CvarRegistry();
  registry.set("ui_ffa_timelimit", "x".repeat(256));
  const ui = new BaseUiCvars(registry, () => undefined);
  const first = ui.get("ui_ffa_fraglimit"), failed = ui.get("ui_ffa_timelimit"), later = ui.get("ui_tourney_fraglimit");
  expect(() => ui.register()).toThrow(CvarVmStringError);
  expect(words(first)).toEqual(["20", 20, 20, 1]);
  expect(words(failed)).toEqual(["", 0, 0, 1]);
  expect(words(later)).toEqual(["", 0, 0, 0]);
  expect(registry.indexCount).toBe(2);
  expect(registry.get("ui_ffa_timelimit")?.flags).toBe(CvarFlag.Archive);
  expect(registry.get("ui_ffa_timelimit")?.resetValue).toBe("0");
  expect(registry.get("ui_tourney_fraglimit")).toBeUndefined();
  expect(() => ui.register()).toThrow(CvarVmStringError);
  expect(words(later)).toEqual(["", 0, 0, 0]);
  registry.set("ui_ffa_timelimit", "8", true);
  ui.register();
  expect(ui.get("ui_ffa_fraglimit")).toBe(first);
  expect(ui.get("ui_ffa_timelimit")).toBe(failed);
  expect(ui.get("ui_tourney_fraglimit")).toBe(later);
  expect(words(failed)).toEqual(["8", 8, 8, 2]);
  expect(words(later)).toEqual(["0", 0, 0, 1]);
  expect(registry.indexCount).toBe(47);
});

test("update after partial registration reaches remaining handle-zero cells in source order", () => {
  const registry = new CvarRegistry(), ui = new BaseUiCvars(registry, () => undefined);
  expect(() => ui.update()).toThrow("Cvar_Update: handle out of range");
  registry.register("slot-zero", "42");
  registry.set("ui_ffa_timelimit", "x".repeat(256));
  expect(() => ui.register()).toThrow(CvarVmStringError);
  ui.update();
  expect(words(ui.get("ui_ffa_fraglimit"))).toEqual(["20", 20, 20, 1]);
  expect(words(ui.get("ui_ffa_timelimit"))).toEqual(["", 0, 0, 1]);
  for (const [name] of BASE_UI_CVARS.slice(2)) expect(words(ui.get(name))).toEqual(["42", 42, 42, 1]);
  registry.set("ui_ffa_timelimit", "6", true);
  ui.register();
  expect(words(ui.get("ui_tourney_fraglimit"))).toEqual(["0", 0, 0, 1]);
});

test("re-registration overflow stops before later rows and update resumes after published count", () => {
  const registry = new CvarRegistry(), ui = new BaseUiCvars(registry, () => undefined);
  ui.register();
  const first = ui.get("ui_ffa_fraglimit"), failed = ui.get("ui_ffa_timelimit"), later = ui.get("ui_tourney_fraglimit");
  registry.set("ui_ffa_fraglimit", "12");
  registry.set("ui_ffa_timelimit", "9".repeat(256));
  registry.set("ui_tourney_fraglimit", "33");
  expect(() => ui.register()).toThrow(CvarVmStringError);
  expect(words(first)).toEqual(["12", 12, 12, 2]);
  expect(words(failed)).toEqual(["0", 0, 0, 2]);
  expect(words(later)).toEqual(["0", 0, 0, 1]);
  ui.update();
  expect(words(failed)).toEqual(["0", 0, 0, 2]);
  expect(words(later)).toEqual(["33", 33, 33, 2]);
  expect(() => ui.register()).toThrow(CvarVmStringError);
  expect(ui.get("ui_ffa_timelimit")).toBe(failed);
});

test("operation failures stop register and update before each guarded row", () => {
  const registry = new CvarRegistry();
  let visited = 0, failAt = 2;
  const ui = new BaseUiCvars(registry, () => { if (++visited === failAt) throw new Error("retired operation"); });
  expect(visited).toBe(0);
  expect(() => ui.register()).toThrow("retired operation");
  expect(registry.indexCount).toBe(1);
  expect(words(ui.get("ui_ffa_timelimit"))).toEqual(["", 0, 0, 0]);
  failAt = -1; ui.register();
  registry.set("ui_ffa_fraglimit", "7");
  registry.set("ui_ffa_timelimit", "8");
  visited = 0; failAt = 2;
  expect(() => ui.update()).toThrow("retired operation");
  expect(words(ui.get("ui_ffa_fraglimit"))).toEqual(["7", 7, 7, 2]);
  expect(words(ui.get("ui_ffa_timelimit"))).toEqual(["0", 0, 0, 1]);
  failAt = -1; ui.update();
  expect(words(ui.get("ui_ffa_timelimit"))).toEqual(["8", 8, 8, 2]);
});

test("real base fixture explicitly registers stable cells and can repeat registration after a latch", async () => {
  const fixture = await baseFixture();
  try {
    const ui = fixture.state.services.cvars, cell = ui.get("g_spSkill");
    expect(words(cell)).toEqual(["2", 2, 2, 1]);
    fixture.cvars.set("g_spSkill", "4");
    ui.register();
    expect(ui.get("g_spSkill")).toBe(cell);
    expect(words(cell)).toEqual(["4", 4, 4, 3]);
    expect(fixture.cvars.get("g_spSkill")?.latchedValue).toBeUndefined();
  } finally { fixture.close(); }
});
