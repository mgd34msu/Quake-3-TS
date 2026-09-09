import { describe, expect, test } from "bun:test";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import type { CvarSnapshot } from "../src/core/cvar.ts";
import { registerServerCvars } from "../src/server/config.ts";

type ExpectedRegistration = readonly [name: string, defaultValue: string, flags: number];

describe("server cvar registration", () => {
  test("registers the exact SV_Init server subset in source order", () => {
    const expected: readonly ExpectedRegistration[] = [
      ["dmflags", "0", 4],
      ["fraglimit", "20", 4],
      ["timelimit", "0", 4],
      ["g_gametype", "0", 36],
      ["sv_keywords", "", 4],
      ["protocol", "68", 68],
      ["mapname", "nomap", 68],
      ["sv_privateClients", "0", 4],
      ["sv_hostname", "noname", 5],
      ["sv_maxclients", "8", 36],
      ["sv_maxRate", "0", 5],
      ["sv_minPing", "0", 5],
      ["sv_maxPing", "0", 5],
      ["sv_floodProtect", "1", 5],
      ["sv_cheats", "1", 72],
      ["sv_serverid", "0", 72],
      ["sv_pure", "1", 8],
      ["sv_paks", "", 72],
      ["sv_pakNames", "", 72],
      ["sv_referencedPaks", "", 72],
      ["sv_referencedPakNames", "", 72],
      ["rconPassword", "", 256],
      ["sv_privatePassword", "", 256],
      ["sv_fps", "20", 256],
      ["sv_timeout", "200", 256],
      ["sv_zombietime", "2", 256],
      ["nextmap", "", 256],
      ["sv_allowDownload", "0", 4],
      ["sv_master1", "master.quake3arena.com", 0],
      ["sv_master2", "", 1],
      ["sv_master3", "", 1],
      ["sv_master4", "", 1],
      ["sv_master5", "", 1],
      ["sv_reconnectlimit", "3", 0],
      ["sv_showloss", "0", 0],
      ["sv_padPackets", "0", 0],
      ["sv_killserver", "0", 0],
      ["sv_mapChecksum", "", 64],
      ["sv_lanForceRate", "1", 1],
      ["sv_strictAuth", "1", 1],
    ];
    const actual: ExpectedRegistration[] = [];
    const registry = new CvarRegistry();
    const recorder: Pick<CvarRegistry, "register"> = {
      register(name: string, defaultValue: string, flags?: number): CvarSnapshot {
        actual.push([name, defaultValue, flags === undefined ? CvarFlag.None : flags]);
        return registry.register(name, defaultValue, flags);
      },
    };

    registerServerCvars(recorder);
    expect(actual).toEqual([...expected]);
    expect(registry.snapshots()).toHaveLength(40);
  });

  test("adopts existing user values, merges flags, and preserves real latch semantics", () => {
    const registry = new CvarRegistry();
    const userHostname = registry.set("sv_hostname", "Player Server");
    expect(userHostname.flags).toBe(CvarFlag.UserCreated);
    registry.set("g_gametype", "3");

    registerServerCvars(registry);
    expect(registry.get("sv_hostname")).toMatchObject({
      value: "Player Server",
      resetValue: "noname",
      flags: CvarFlag.ServerInfo | CvarFlag.Archive,
    });
    expect(registry.get("g_gametype")).toMatchObject({ value: "3", resetValue: "0", flags: CvarFlag.ServerInfo | CvarFlag.Latch });

    const changed = registry.set("g_gametype", "4");
    expect(changed.value).toBe("3");
    expect(changed.latchedValue).toBe("4");
    expect(registry.applyLatched("g_gametype")[0]?.value).toBe("4");
    expect(registry.get("sv_pure")).toMatchObject({ value: "1", resetValue: "1", flags: CvarFlag.SystemInfo });
  });
});
