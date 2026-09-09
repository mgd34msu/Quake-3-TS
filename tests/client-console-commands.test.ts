// Client console commands through the actual common command buffer and transports.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { printInfo } from "../src/core/info-string.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { ClientConsoleCommands } from "../src/engine/client-console-commands.ts";
import { registerClientCvars } from "../src/engine/client-cvars.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import type { ClientPacketAddress } from "../src/engine/client-state.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { UdpTransport } from "../src/platform/network.ts";
import { UnixIo } from "../src/platform/unix-io.ts";
import { UnixSystemClock } from "../src/platform/system-clock.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import { createProtocolClientSession } from "../tools/client-protocol-fixture.ts";
import { sourceZip } from "./pk3-source-fixture.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "q3-client-commands-"));
  cleanups.push(() => rmSync(root, { recursive: true }));
  const dataPath = join(root, "data"), homePath = join(root, "home");
  mkdirSync(join(dataPath, "baseq3"), { recursive: true });
  writeFileSync(join(dataPath, "baseq3", "default.cfg"), "set test_default 1\n");
  writeFileSync(join(dataPath, "baseq3", "productid.txt"), SOURCE_PRODUCT_ID);
  writeFileSync(join(dataPath, "baseq3", "commands.pk3"), sourceZip([
    { name: Buffer.from("owned.dat"), data: Uint8Array.of(42), method: 0, utf8: false },
  ]));
  const printed: string[] = [], loopback = new LoopbackTransport();
  const io = new UnixIo(text => { printed.push(text); }, new UnixSystemClock(), { signals: "none" });
  cleanups.push(() => io.close());
  let owner: ClientConsoleCommands | null = null, permitted = true;
  const guard = (): undefined => { if (!permitted) throw new Error("Client operation is no longer current"); };
  const common = await CommonConsole.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
    startup: new StartupCommands(""), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: text => { printed.push(text); }, assertCommandEntry: guard, assertOwnerEntry: guard,
    resolveCommand: () => ({ kind: "sync", handler: context => {
      if (owner === null) throw new Error("Client console owner not initialized");
      return owner.forwardCommand(context);
    } }),
  }, value => { cleanups.push(() => value.close()); });
  registerClientCvars(common.cvars);
  const session = createProtocolClientSession({ product: "baseq3", cvars: common.cvars,
    mode: { kind: "network", challenge: 1, qport: 27961 } });
  const cls = session.lifecycle.clientStatic, clc = session.lifecycle.clientConnection;
  let remote: ClientPacketAddress | null = { kind: "loopback" };
  const commands = new ClientConsoleCommands({ common, clientStatic: cls, io, loopback,
    readConnection: () => clc, readSession: () => session, readRemoteAddress: () => remote, assertCurrentOperation: guard });
  owner = commands;
  common.commands.register("cmd", context => commands.forwardToServer(context));
  common.commands.register("configstrings", context => commands.configstrings(context));
  common.commands.register("clientinfo", context => commands.clientinfo(context));
  common.commands.register("model", context => commands.setModel(context));
  common.commands.register("setenv", context => commands.setenv(context));
  common.commands.registerAsync("rcon", context => commands.rcon(context));
  common.commands.register("fs_openedList", context => commands.openedPakList(context));
  common.commands.register("fs_referencedList", context => commands.referencedPakList(context));
  printed.length = 0;
  return { common, session, cls, clc, io, loopback, printed,
    execute: async (text: string) => { common.commands.append(`${text}\n`); await common.commands.executeAsync(); },
    setRemote(value: ClientPacketAddress | null): void { remote = value; },
    permit(value: boolean): void { permitted = value; },
  };
}

test("CL_Init registers source-ordered Linux cvars without changing configured values", () => {
  const cvars = new CvarRegistry();
  registerClientCvars(cvars);
  expect(cvars.snapshots().map(value => value.name).reverse()).toEqual([
    "cl_noprint", "cl_motd", "cl_timeout", "cl_timeNudge", "cl_shownet", "cl_showSend", "cl_showTimeDelta", "cl_freezeDemo",
    "rconPassword", "activeAction", "timedemo", "cl_avidemo", "cl_forceavidemo", "rconAddress",
    "cl_yawspeed", "cl_pitchspeed", "cl_anglespeedkey", "cl_maxpackets", "cl_packetdup", "cl_run", "sensitivity", "cl_mouseAccel",
    "cl_freelook", "cl_showmouserate", "cl_allowDownload", "cl_conXOffset", "r_inGameVideo", "cl_serverStatusResendTime",
    "cg_autoswitch", "m_pitch", "m_yaw", "m_forward", "m_side", "m_filter", "cl_motdString", "cl_maxPing", "name", "rate",
    "snaps", "model", "headmodel", "team_model", "team_headmodel", "g_redTeam", "g_blueTeam", "color1", "color2", "handicap",
    "teamtask", "sex", "cl_anonymous", "password", "cg_predictItems", "cg_viewsize",
  ]);
  expect(cvars.get("m_filter")?.value).toBe("0");
  expect(cvars.get("r_inGameVideo")?.value).toBe("1");
  expect(cvars.get("name")?.flags).toBe(CvarFlag.Archive | CvarFlag.UserInfo);
  expect(cvars.get("g_redTeam")?.flags).toBe(CvarFlag.Archive | CvarFlag.ServerInfo);
  expect(cvars.get("password")?.flags).toBe(CvarFlag.UserInfo);
  expect(cvars.get("cl_motdString")?.flags).toBe(CvarFlag.ReadOnly);
  cvars.set("rate", "9000"); cvars.register("timedemo", "0", CvarFlag.Cheat);
  registerClientCvars(cvars);
  expect(cvars.get("rate")?.value).toBe("9000");
  expect(cvars.get("timedemo")?.flags).toBe(CvarFlag.Cheat);
});

test("unknown forwarding keeps raw quotes while cmd joins tokens and requires active play", async () => {
  const f = await fixture();
  f.cls.phase = "disconnected";
  await f.execute('-unknown 1\n+unknown 2\nsay "hello world"\ncmd say ignored');
  expect(f.printed).toEqual(['Unknown command "+unknown"\n', 'Unknown command "say"\n', "Not connected to a server.\n"]);
  expect(f.clc.reliable.sequence).toBe(0);
  f.cls.phase = "connected";
  await f.execute('say  "hello world"\nstatus\ncmd say ignored');
  expect(f.clc.reliable.pending().map(value => value.text)).toEqual(['say  "hello world"', "status"]);
  f.cls.phase = "active";
  await f.execute('cmd say "hello world"\ncmd');
  expect(f.clc.reliable.lookup(3)).toBe("say hello world");
  f.clc.demoPlaying = true;
  await f.execute("status\ncmd say ignored");
  expect(f.clc.reliable.sequence).toBe(3);
});

test("forwarding maps the real ring overflow to CommonError drop without another enqueue", async () => {
  const f = await fixture(); f.cls.phase = "active";
  for (let index = 0; index < 65; index++) f.clc.reliable.add(`existing ${index}`);
  try { await f.execute("cmd overflow"); throw new Error("Expected command overflow"); }
  catch (error) {
    expect(error).toBeInstanceOf(CommonError);
    if (!(error instanceof CommonError)) throw error;
    expect(error.code).toBe("drop"); expect(error.message).toBe("Client command overflow");
  }
  expect(f.clc.reliable.sequence).toBe(65);
});

test("model, clientinfo and actual pak reports preserve source output", async () => {
  const f = await fixture();
  await f.execute("model visor/red\nmodel\nclientinfo\nfs_openedList\nfs_referencedList");
  expect(f.common.cvars.get("model")?.value).toBe("visor/red");
  expect(f.common.cvars.get("headmodel")?.value).toBe("visor/red");
  expect(f.printed[0]).toBe("model is set to visor/red\n");
  expect(f.printed).toContain("state: 5\n");
  expect(f.printed).toContain("model               ");
  expect(f.printed).toContain("visor/red\n");
  expect(f.printed).toContain("Opened PK3 Names: commands\n");
  expect(f.printed).toContain("Referenced PK3 Names: \n");
  await f.common.files.current.read("owned.dat");
  await f.execute("fs_referencedList");
  expect(f.printed.at(-1)).toBe("Referenced PK3 Names: baseq3/commands\n");
  f.common.cvars.set("model", "x".repeat(300));
  await f.execute("model");
  expect(f.printed.at(-1)).toBe(`model is set to ${"x".repeat(255)}\n`);
});

test("shared Info_Print preserves individual writes, key padding, missing values and unsafe-buffer boundaries", () => {
  const output: string[] = [], print = (text: string): void => { output.push(text); };
  printInfo("\\short\\first\\abcdefghijklmnopqrstuv\\\\dangling", print);
  expect(output).toEqual(["short               ", "first\n", "abcdefghijklmnopqrstuv", "\n", "dangling            ", "MISSING VALUE\n"]);
  output.length = 0;
  printInfo(`key\\${"v".repeat(511)}`, print);
  expect(output).toEqual(["key                 ", `${"v".repeat(511)}\n`]);
  output.length = 0;
  expect(() => printInfo(`\\key\\${"v".repeat(512)}`, print)).toThrow("Info_Print would overflow its source value buffer");
  expect(output).toEqual(["key                 "]);
  output.length = 0;
  expect(() => printInfo(`\\${"k".repeat(512)}\\value`, print)).toThrow("Info_Print would overflow its source key buffer");
  expect(output).toEqual([]);
  printInfo("", print); printInfo("\\", print); expect(output).toEqual([]);
});

test("clientinfo retains preceding output when the shared formatter rejects an unsafe source field", async () => {
  const f = await fixture();
  f.common.cvars.register("formatter_probe", "v".repeat(512), CvarFlag.UserInfo);
  await expect(f.execute("clientinfo")).rejects.toThrow("Info_Print would overflow its source value buffer");
  expect(f.printed.slice(0, 4)).toEqual([
    "--------- Client Information ---------\n", "state: 5\n", "Server: \n", "User info settings:\n",
  ]);
  expect(f.printed.at(-1)).toBe("formatter_probe     ");
  expect(f.printed).not.toContain("--------------------------------------\n");
});

test("configstrings prints allocated empty entries from a parsed engine gamestate", async () => {
  const f = await fixture();
  await f.execute("configstrings");
  expect(f.printed).toEqual(["Not connected to a server.\n"]);
  await f.session.receiveServerMessage(1, encodeServerMessage(0, [{ kind: "gamestate", commandSequence: 0,
    clientNumber: 0, checksumFeed: 0, entries: [
      { kind: "configstring", index: 0, value: "\\mapname\\q3dm1" },
      { kind: "configstring", index: 1, value: "\\sv_serverid\\1\\sv_cheats\\1" },
      { kind: "configstring", index: 17, value: "" },
    ] }], { product: "baseq3", messageNumber: 1, reliableSequence: 0, serverCommandSequence: 0,
    parseEntitiesNumber: 0, baseline: () => null, history: () => null }));
  f.cls.phase = "active"; f.printed.length = 0;
  await f.execute("configstrings");
  expect(f.printed).toEqual(["   0: \\mapname\\q3dm1\n", "   1: \\sv_serverid\\1\\sv_cheats\\1\n", "  17: \n"]);
});

test("setenv writes a real named environment variable with the source trailing space", async () => {
  const f = await fixture(), name = "Q3_CLIENT_CONSOLE_TEST_VALUE", old = process.env[name];
  cleanups.push(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
  delete process.env[name];
  await f.execute(`setenv ${name}\nsetenv ${name} "hello world" second\nsetenv ${name}`);
  expect(process.env[name]).toBe("hello world second ");
  expect(f.printed).toEqual([`${name} undefined\n`, `${name}=hello world second \n`]);
  f.permit(false);
  await expect(f.execute(`setenv ${name} forbidden`)).rejects.toThrow("no longer current");
  expect(process.env[name]).toBe("hello world second ");
  f.permit(true);
});

test("rcon sends exact raw text and NUL through loopback, including an empty password", async () => {
  const f = await fixture();
  f.clc.serverAddress = { kind: "ipv4", host: [192, 0, 2, 1], port: 27960 };
  await f.execute('rcon say  "hello world"');
  const packet = f.loopback.poll("server");
  expect(packet?.payload).toEqual(Buffer.concat([Uint8Array.of(255, 255, 255, 255), Buffer.from('rcon  say  "hello world"\0')]));
  f.cls.phase = "disconnected";
  await f.execute("rcon status");
  expect(f.printed).toEqual(["You must either be connected,\nor set the 'rconAddress' cvar\nto issue rcon commands\n"]);
  f.common.cvars.set("rconAddress", "localhost");
  f.common.cvars.set("rconPassword", "synthetic");
  await f.execute("rcon status");
  expect(f.loopback.poll("server")?.payload).toEqual(Buffer.concat([Uint8Array.of(255, 255, 255, 255), Buffer.from("rcon synthetic status\0")]));
  f.common.cvars.set("rconPassword", "x".repeat(1024));
  await expect(f.execute("rcon status")).rejects.toThrow("source buffer");
  expect(f.loopback.poll("server")).toBeNull();
});

test("rcon resolves an actual local UDP endpoint and uses the admitted responder when connected", async () => {
  const f = await fixture();
  const receiver = await UdpTransport.bind({ host: [127, 0, 0, 1], port: 0 });
  cleanups.push(() => receiver.close());
  f.common.cvars.set("net_ip", "127.0.0.1"); f.common.cvars.set("net_port", "0");
  await f.io.initializeNetwork(f.common.cvars);
  f.cls.phase = "disconnected";
  f.common.cvars.set("rconAddress", `127.0.0.1:${receiver.address.port}`);
  await f.execute("rcon status");
  const read = async (): Promise<Uint8Array> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const event = receiver.poll();
      if (event?.kind === "packet") return event.payload;
      if (event?.kind === "error") throw event.error;
      await Bun.sleep(1);
    }
    throw new Error("Rcon datagram was not delivered");
  };
  expect(await read()).toEqual(Buffer.concat([Uint8Array.of(255, 255, 255, 255), Buffer.from("rcon  status\0")]));
  f.cls.phase = "active"; f.setRemote(receiver.address);
  f.common.cvars.set("rconAddress", "192.0.2.2");
  f.clc.serverAddress = { kind: "ipv4", host: [192, 0, 2, 3], port: 27960 };
  await f.execute("rcon serverinfo");
  expect(await read()).toEqual(Buffer.concat([Uint8Array.of(255, 255, 255, 255), Buffer.from("rcon  serverinfo\0")]));
});
