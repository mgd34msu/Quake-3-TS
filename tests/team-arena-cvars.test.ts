import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CvarFlag, CvarRegistry, CvarVmStringError } from "../src/core/cvar.ts";
import type { VmCvarRead } from "../src/core/cvar.ts";
import { TEAM_ARENA_UI_CVARS, TeamArenaUiCvars } from "../src/ui/team-arena/cvars.ts";

function current(): undefined { return undefined; }
function words(mirror: VmCvarRead): readonly [string, number, number, number] {
  return [mirror.value, mirror.numericValue, mirror.integerValue, mirror.modificationCount];
}

test("Team Arena registers exactly the original 110 symbol/name/default/flag entries in order", () => {
  // SHA-256 of independently extracted original ui_main.c:5703 table records.
  expect(createHash("sha256").update(JSON.stringify(TEAM_ARENA_UI_CVARS)).digest("hex"))
    .toBe("fb6e0b18fb6eab7e7c521b7cf6db1bcbbff8d5174db711cca3b8e864519b01b4");
  expect(TEAM_ARENA_UI_CVARS).toHaveLength(110);
  expect(new Set(TEAM_ARENA_UI_CVARS.map(entry => entry.symbol)).size).toBe(110);
  expect(Object.isFrozen(TEAM_ARENA_UI_CVARS)).toBe(true);
  const registry = new CvarRegistry();
  const registrations: string[] = [];
  const registerVm = registry.registerVm.bind(registry);
  registry.registerVm = (name, defaultValue, flags) => {
    registrations.push(name);
    return registerVm(name, defaultValue, flags);
  };
  const mirrors = new TeamArenaUiCvars(registry, current);
  expect(registrations).toEqual(TEAM_ARENA_UI_CVARS.map(entry => entry.name));
  expect(registry.indexCount).toBe(110);
  for (const entry of TEAM_ARENA_UI_CVARS) {
    expect(Object.isFrozen(entry)).toBe(true);
    expect(registry.get(entry.name)?.value).toBe(entry.defaultValue);
    expect(registry.get(entry.name)?.flags).toBe(entry.flags);
    expect(mirrors.get(entry.symbol).value).toBe(entry.defaultValue);
  }
  expect(registry.get("ui_serverFilterType")).toBeUndefined();
  expect(registry.get("debug_protocol")).toBeUndefined();
});

test("Team Arena VM symbols resolve distinct actual names and remain stale until source update", () => {
  const registry = new CvarRegistry();
  const mirrors = new TeamArenaUiCvars(registry, current);
  expect(registry.get("ui_arenasFile")).toBeUndefined();
  expect(registry.get("ui_hudFiles")).toBeUndefined();
  expect(mirrors.get("ui_gameType").value).toBe("3");
  expect(mirrors.get("ui_hudFiles").value).toBe("ui/hud.txt");
  registry.set("g_arenasFile", "scripts/custom.arena", true);
  registry.set("UI_GAMETYPE", "7", true);
  registry.set("cg_hudFiles", "ui/custom.txt", true);
  expect(mirrors.get("ui_arenasFile").value).toBe("");
  expect(mirrors.get("ui_gameType").value).toBe("3");
  expect(mirrors.get("ui_hudFiles").value).toBe("ui/hud.txt");
  mirrors.update();
  expect(mirrors.get("ui_arenasFile").value).toBe("scripts/custom.arena");
  expect(mirrors.get("ui_gameType").value).toBe("7");
  expect(mirrors.get("ui_hudFiles").value).toBe("ui/custom.txt");
  expect(mirrors.get("ui_bigFont").numericValue).toBe(Math.fround(.4));
});

test("Team Arena g_spSkill is archive-only while preexisting latch and custom flags are preserved", () => {
  const fresh = new CvarRegistry();
  const team = new TeamArenaUiCvars(fresh, current);
  fresh.set("g_spSkill", "4");
  expect(fresh.get("g_spSkill")?.latchedValue).toBeUndefined();
  expect(fresh.get("g_spSkill")?.value).toBe("4");
  expect(fresh.get("g_spSkill")?.flags).toBe(CvarFlag.Archive);
  expect(team.get("ui_spSkill").value).toBe("2");
  team.update();
  expect(team.get("ui_spSkill").value).toBe("4");

  const registry = new CvarRegistry();
  registry.register("g_spSkill", "1", CvarFlag.Latch | CvarFlag.ServerInfo);
  registry.set("g_spSkill", "4");
  const mirrors = new TeamArenaUiCvars(registry, current);
  expect(words(mirrors.get("ui_spSkill"))).toEqual(["4", 4, 4, 3]);
  expect(registry.get("g_spSkill")?.flags).toBe(CvarFlag.Latch | CvarFlag.ServerInfo | CvarFlag.Archive);
  expect(registry.modifiedFlags & CvarFlag.Archive).toBe(CvarFlag.Archive);
  registry.set("g_spSkill", "5");
  mirrors.update();
  expect(words(mirrors.get("ui_spSkill"))).toEqual(["4", 4, 4, 4]);
  expect(registry.get("g_spSkill")?.latchedValue).toBe("5");
  registry.set("g_spSkill", "3", true);
  expect(registry.get("g_spSkill")?.latchedValue).toBeUndefined();
  expect(mirrors.get("ui_spSkill").value).toBe("4");
  mirrors.update();
  expect(words(mirrors.get("ui_spSkill"))).toEqual(["3", 3, 3, 5]);
});

test("canonical read-only protection and forced sets retain actual flags", () => {
  const registry = new CvarRegistry();
  const mirrors = new TeamArenaUiCvars(registry, current);
  registry.set("g_spScores1", "ordinary");
  expect(registry.get("g_spScores1")?.value).toBe("");
  registry.set("g_spScores1", "forced", true);
  expect(mirrors.get("ui_spScores1").value).toBe("");
  mirrors.update();
  expect(mirrors.get("ui_spScores1").value).toBe("forced");
  expect(registry.get("g_spScores1")?.flags).toBe(CvarFlag.Archive | CvarFlag.ReadOnly);
  expect(registry.get("capturelimit")?.flags).toBe(CvarFlag.Archive | CvarFlag.ServerInfo | CvarFlag.NoRestart);
});

test("cvar_restart clears user-created empty-default slots without retargeting old UI mirrors", () => {
  const registry = new CvarRegistry();
  registry.set("server1", "first");
  registry.set("g_arenasFile", "original");
  const mirrors = new TeamArenaUiCvars(registry, current);
  const oldServer = mirrors.get("ui_server1");
  expect(registry.get("server1")?.flags).toBe(CvarFlag.UserCreated | CvarFlag.Archive);
  registry.set("capturelimit", "17", true);
  registry.set("g_arenasFile", "retained", true);
  registry.resetAll();
  mirrors.update();
  expect(registry.get("server1")).toBeUndefined();
  expect(oldServer.value).toBe("first");
  expect(mirrors.get("ui_realCaptureLimit").value).toBe("17");
  expect(mirrors.get("ui_arenasFile").value).toBe("retained");
  registry.set("server1", "replacement");
  mirrors.update();
  expect(mirrors.get("ui_server1")).toBe(oldServer);
  expect(oldServer.value).toBe("first");
  const replacement = new TeamArenaUiCvars(registry, current);
  expect(replacement.get("ui_server1").value).toBe("replacement");
  registry.set("server1", "next");
  mirrors.update();
  replacement.update();
  expect(oldServer.value).toBe("first");
  expect(replacement.get("ui_server1").value).toBe("next");
});

test("VM overflow publishes count before failure and preserves ordered partial refresh", () => {
  const registry = new CvarRegistry();
  const mirrors = new TeamArenaUiCvars(registry, current);
  const huge = "a".repeat(256);
  registry.set("ui_ffa_fraglimit", "21", true);
  registry.set("ui_ffa_timelimit", huge, true);
  registry.set("ui_tourney_fraglimit", "22", true);
  let caught: unknown;
  try { mirrors.update(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(CvarVmStringError);
  if (!(caught instanceof CvarVmStringError)) throw new Error("Expected canonical VM string overflow");
  expect(caught.length).toBe(256);
  expect(caught.message).toBe(`Cvar_Update: src ${huge} length 256 exceeds MAX_CVAR_VALUE_STRING`);
  expect(words(mirrors.get("ui_ffa_fraglimit"))).toEqual(["21", 21, 21, 2]);
  expect(words(mirrors.get("ui_ffa_timelimit"))).toEqual(["0", 0, 0, 2]);
  expect(words(mirrors.get("ui_tourney_fraglimit"))).toEqual(["0", 0, 0, 1]);
  expect(() => mirrors.update()).not.toThrow();
  expect(words(mirrors.get("ui_ffa_timelimit"))).toEqual(["0", 0, 0, 2]);
  expect(words(mirrors.get("ui_tourney_fraglimit"))).toEqual(["22", 22, 22, 2]);
  registry.set("ui_ffa_timelimit", "-7.25", true);
  mirrors.update();
  expect(words(mirrors.get("ui_ffa_timelimit"))).toEqual(["-7.25", -7.25, -7, 3]);
});

test("actual 255-byte and NUL boundaries pass through the canonical source byte conversion", () => {
  const registry = new CvarRegistry();
  const mirrors = new TeamArenaUiCvars(registry, current);
  const maximum = "\xff".repeat(255);
  registry.set("ui_teamName", `${maximum}\0ignored`, true);
  mirrors.update();
  expect(mirrors.get("ui_teamName").value).toBe(maximum);
  expect(mirrors.get("ui_teamName").value.length).toBe(255);
  registry.set("ui_teamName", "\xff".repeat(256), true);
  expect(() => mirrors.update()).toThrow(CvarVmStringError);
  expect(mirrors.get("ui_teamName").value).toBe(maximum);
  expect(() => registry.set("ui_teamName", "\u0100", true)).toThrow("byte");
});

test("registration overflow retains earlier actual cvars and promotion of the failing one", () => {
  const registry = new CvarRegistry();
  registry.set("ui_ffa_timelimit", "b".repeat(256));
  expect(() => new TeamArenaUiCvars(registry, current)).toThrow(CvarVmStringError);
  expect(registry.get("ui_ffa_fraglimit")?.value).toBe("20");
  expect(registry.get("ui_ffa_timelimit")?.flags).toBe(CvarFlag.Archive);
  expect(registry.get("ui_ffa_timelimit")?.resetValue).toBe("0");
  expect(registry.get("ui_tourney_fraglimit")).toBeUndefined();
  expect(registry.indexCount).toBe(2);
  registry.set("ui_ffa_timelimit", "3", true);
  const recovered = new TeamArenaUiCvars(registry, current);
  expect(recovered.get("ui_ffa_timelimit").value).toBe("3");
  expect(registry.indexCount).toBe(110);
});

test("MAX_CVARS registration failure keeps the exact accepted prefix", () => {
  const registry = new CvarRegistry();
  for (let i = 0; i < 1021; i++) registry.register(`fixture${i}`, "0");
  expect(() => new TeamArenaUiCvars(registry, current)).toThrow("MAX_CVARS");
  expect(registry.indexCount).toBe(1024);
  expect(registry.get("ui_ffa_fraglimit")?.value).toBe("20");
  expect(registry.get("ui_ffa_timelimit")?.value).toBe("0");
  expect(registry.get("ui_tourney_fraglimit")?.value).toBe("0");
  expect(registry.get("ui_tourney_timelimit")).toBeUndefined();
});

test("borrowed operation guard rejects at the consumed registration/update position without rollback", () => {
  const registry = new CvarRegistry();
  let calls = 0;
  expect(() => new TeamArenaUiCvars(registry, () => {
    if (++calls === 3) throw new Error("closed owner");
    return undefined;
  })).toThrow("closed owner");
  expect(registry.indexCount).toBe(2);
  expect(registry.get("ui_ffa_timelimit")?.value).toBe("0");
  expect(registry.get("ui_tourney_fraglimit")).toBeUndefined();

  let open = true;
  const mirrors = new TeamArenaUiCvars(registry, () => {
    if (!open) throw new Error("closed owner");
    return undefined;
  });
  registry.set("ui_ffa_fraglimit", "23");
  open = false;
  expect(() => mirrors.update()).toThrow("closed owner");
  expect(mirrors.get("ui_ffa_fraglimit").value).toBe("20");
  open = true;
  mirrors.update();
  expect(mirrors.get("ui_ffa_fraglimit").value).toBe("23");
});

test("source synchronous reentry uses the same mirrors and preserves update order", () => {
  const registry = new CvarRegistry();
  let nested: (() => undefined) | null = null;
  let calls = 0;
  const mirrors = new TeamArenaUiCvars(registry, () => {
    calls++;
    const callback = nested;
    nested = null;
    if (callback !== null) callback();
    return undefined;
  });
  registry.set("ui_ffa_fraglimit", "31");
  registry.set("ui_ffa_timelimit", "32");
  nested = () => {
    mirrors.update();
    registry.set("ui_ffa_fraglimit", "33");
    return undefined;
  };
  calls = 0;
  mirrors.update();
  expect(calls).toBe(220);
  expect(mirrors.get("ui_ffa_fraglimit").value).toBe("33");
  expect(mirrors.get("ui_ffa_timelimit").value).toBe("32");
});

test("Team Arena guarded integer writes mutate the same canonical borrowed mirror only", () => {
  const registry = new CvarRegistry();
  let open = true;
  const mirrors = new TeamArenaUiCvars(registry, () => {
    if (!open) throw new Error("closed Team UI operation");
    return undefined;
  });
  const borrowed = mirrors.get("ui_gameType");
  registry.clearModified("ui_gametype");
  const before = registry.get("ui_gametype");
  mirrors.writeInteger("ui_gameType", 5);
  expect(mirrors.get("ui_gameType")).toBe(borrowed);
  expect(words(borrowed)).toEqual(["3", 3, 5, 1]);
  expect(registry.get("ui_gametype")).toEqual(before);
  mirrors.update();
  expect(words(borrowed)).toEqual(["3", 3, 5, 1]);
  expect(() => mirrors.writeInteger("ui_gameType", .5)).toThrow(RangeError);
  expect(words(borrowed)).toEqual(["3", 3, 5, 1]);
  expect(registry.get("ui_gametype")).toEqual(before);
  expect(registry.modifiedFlags).toBe(0);
  open = false;
  expect(() => mirrors.writeInteger("ui_gameType", Number.NaN)).toThrow("closed Team UI operation");
  expect(words(borrowed)).toEqual(["3", 3, 5, 1]);
});

test("Team Arena integer overrides preserve exact prefix and count publication on update failure", () => {
  const registry = new CvarRegistry(), mirrors = new TeamArenaUiCvars(registry, current);
  mirrors.writeInteger("ui_ffa_fraglimit", 71);
  mirrors.writeInteger("ui_ffa_timelimit", 72);
  mirrors.writeInteger("ui_tourney_fraglimit", 73);
  registry.set("ui_ffa_fraglimit", "21", true);
  registry.set("ui_ffa_timelimit", "\xff".repeat(256), true);
  registry.set("ui_tourney_fraglimit", "22", true);
  expect(() => mirrors.update()).toThrow(CvarVmStringError);
  expect(words(mirrors.get("ui_ffa_fraglimit"))).toEqual(["21", 21, 21, 2]);
  expect(words(mirrors.get("ui_ffa_timelimit"))).toEqual(["0", 0, 72, 2]);
  expect(words(mirrors.get("ui_tourney_fraglimit"))).toEqual(["0", 0, 73, 1]);
  mirrors.update();
  expect(words(mirrors.get("ui_ffa_timelimit"))).toEqual(["0", 0, 72, 2]);
  expect(words(mirrors.get("ui_tourney_fraglimit"))).toEqual(["22", 22, 22, 2]);
  registry.set("ui_ffa_timelimit", "-7.25", true); mirrors.update();
  expect(words(mirrors.get("ui_ffa_timelimit"))).toEqual(["-7.25", -7.25, -7, 3]);
});

test("Team integer writes preserve native synchronous guard reentry without a second mirror", () => {
  const registry = new CvarRegistry();
  let callback: (() => undefined) | null = null;
  const mirrors = new TeamArenaUiCvars(registry, () => {
    const current = callback; callback = null;
    if (current !== null) current();
    return undefined;
  });
  const borrowed = mirrors.get("ui_gameType");
  callback = () => { mirrors.writeInteger("ui_gameType", 6); return undefined; };
  mirrors.writeInteger("ui_gameType", 7);
  expect(mirrors.get("ui_gameType")).toBe(borrowed);
  expect(words(borrowed)).toEqual(["3", 3, 7, 1]);
  expect(registry.get("ui_gametype")?.value).toBe("3");
});
