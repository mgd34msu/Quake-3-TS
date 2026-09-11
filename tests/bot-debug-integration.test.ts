// Source DEBUG profiles composed through the real server bot owner.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { registerSourceBotCvars, SourceBots } from "../src/engine/source-bots.ts";

const independentSelectors = ["com_botMemoryDebug", "com_botAasFileDebug", "com_botAlternativeRouteDebug",
  "com_botAasSampleDebug", "com_botReachDebug",
  "com_botWeaponDebug", "com_botDebugEval", "com_botAiMoveDebug", "com_botElevatorDebug", "com_botFuncBobDebug", "com_botGrappleDebug"];

test("SourceBots registers independent sampling and reach switches without constructor diagnostics", async () => {
  const homePath = mkdtempSync(join(tmpdir(), "q3-bot-aas-switches-"));
  const owners: CommonConsole[] = [], prints: string[] = [];
  const random = new LinuxNativeRandom(1);
  try {
    const common = await CommonConsole.open({
      roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "baseq3" },
      startup: new StartupCommands(""), random, build: { kind: "dedicated" },
      platformPrint: text => { prints.push(text); }, resolveCommand: () => undefined,
      assertCommandEntry: () => {}, assertOwnerEntry: () => {},
    }, owner => { owners.push(owner); });
    common.registerRuntimeCvars("bot-aas-switch-fixture", async () => {});
    registerSourceBotCvars(common.cvars);
    for (const profile of ["release", "sample", "reach", "debug"]) {
      if (profile !== "release") {
        common.cvars.set("com_botAasSampleDebug", profile === "sample" ? "1" : "0", true);
        common.cvars.set("com_botReachDebug", profile === "reach" ? "1" : "0", true);
      }
      prints.length = 0;
      const bots = new SourceBots(common, random, profile === "debug");
      try {
        expect(common.cvars.get("com_botAasSampleDebug")?.integerValue).toBe(profile === "sample" ? 1 : 0);
        expect(common.cvars.get("com_botReachDebug")?.integerValue).toBe(profile === "reach" ? 1 : 0);
        expect(common.cvars.get("com_botAasSampleDebug")?.flags).toBe(CvarFlag.Init);
        expect(common.cvars.get("com_botReachDebug")?.flags).toBe(CvarFlag.Init);
        expect(bots.library.debugBuild).toBe(profile === "debug");
        expect(prints).toEqual([]);
      } finally { bots.disposeResources(); }
    }
  } finally {
    for (const owner of owners) owner.close();
    rmSync(homePath, { recursive: true });
  }
});

for (const profile of ["release", "independent", "debug"]) {
  test(`SourceBots ${profile} profile uses actual common memory, retail readers and writable bot log`, async () => {
    const homePath = mkdtempSync(join(tmpdir(), "q3-bot-debug-"));
    const prints: string[] = [], random = new LinuxNativeRandom(1);
    const owners: CommonConsole[] = [];
    let bots: SourceBots | null = null;
    try {
      const selected = profile !== "release";
      const common = await CommonConsole.open({
        roots: { dataPath: process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a", homePath, cdPath: null, product: "baseq3" },
        startup: new StartupCommands(selected ? independentSelectors.map(name => `+set ${name} 1`).join(" ") : ""),
        random, build: { kind: "dedicated" }, platformPrint: text => { prints.push(text); },
        resolveCommand: () => undefined, assertCommandEntry: () => {}, assertOwnerEntry: () => {},
      }, owner => { owners.push(owner); });
      common.registerRuntimeCvars("bot-debug-fixture", async () => {});
      registerSourceBotCvars(common.cvars);
      common.cvars.set("bot_developer", "1", true);
      common.cvars.set("bot_debug", "1", true);
      bots = new SourceBots(common, random, profile === "debug");
      for (const name of independentSelectors) {
        expect(common.cvars.get(name)?.flags).toBe(CvarFlag.Init);
        expect(common.cvars.get(name)?.integerValue).toBe(selected ? 1 : 0);
      }
      expect(common.cvars.get("com_botMemoryManager")?.integerValue).toBe(0);
      const library = bots.library;
      expect(library.debugBuild).toBe(profile === "debug");
      library.variables.set("bot_developer", "1");
      library.variables.set("log", "1");
      library.variables.set("maxclients", "2");
      library.variables.set("maxentities", "16");
      expect(library.setup()).toBe(0);
      expect(prints.some(text => /setup chat AI \d+ msec/.test(text))).toBe(profile === "debug");
      writeFileSync(join(homePath, "baseq3", "debug-eval.c"), "#if 1 + 2\nselected\n#endif\n");
      const handle = library.sources.loadSourceHandle("debug-eval.c");
      expect(handle).toBeGreaterThan(0);
      expect(library.sources.readTokenHandle(handle)?.token.text).toBe("selected");
      expect(library.sources.freeSourceHandle(handle)).toBe(true);
      const allocation = library.memory.allocate(2048, "heap", false, { label: "integration", file: "bot-debug-integration.test.ts", line: 1 });
      prints.length = 0;
      library.memory.printMemoryLabels();
      library.log.flush();
      expect(prints.some(text => text.startsWith("total allocated memory: "))).toBe(selected);
      const log = readFileSync(join(homePath, "baseq3", "botlib.log"), "latin1");
      expect(log.includes("operator +, value1 = 1value2 = 2result value = 3eval: 1 + 2eval result: 3")).toBe(selected);
      expect(log.includes("Botlib memory log")).toBe(selected);
      expect(log.includes("bot-debug-integration.test.ts")).toBe(selected);
      expect(log.includes("weaponindex")).toBe(selected);
      library.memory.free(allocation);
      expect(library.shutdown()).toBe(0);
    } finally {
      bots?.disposeResources();
      for (const owner of owners) owner.close();
      rmSync(homePath, { recursive: true });
    }
  }, 60000);
}
