import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareClientPaks } from "../src/assets/client-download.ts";
import { Pk3Archive } from "../src/assets/pk3.ts";
import { CommonError } from "../src/core/common-error.ts";
import { infoValueForKey } from "../src/core/info-string.ts";
import { LinuxNativeRandom } from "../src/core/native-random.ts";
import { ClientDownloads } from "../src/engine/client-download.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { CommonConsole } from "../src/engine/common-console.ts";
import { StartupCommands } from "../src/engine/startup-commands.ts";
import { ClientMessageReader, decodeClientMessage } from "../src/protocol/client-message.ts";
import { LoopbackTransport } from "../src/protocol/loopback.ts";
import { Netchannel, xorClientMessage, xorServerMessage } from "../src/protocol/netchan.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { Download, ServerOperation } from "../src/protocol/server-message.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { sourceZip } from "./pk3-source-fixture.ts";
import { SOURCE_PRODUCT_ID } from "./product-id-fixture.ts";

async function fixture(allow = true, onDownloadPrint: (text: string) => void = () => undefined) {
  const root = mkdtempSync(join(tmpdir(), "q3-client-downloads-"));
  const dataPath = join(root, "data"), homePath = join(root, "home");
  mkdirSync(join(dataPath, "baseq3"), { recursive: true });
  mkdirSync(join(homePath, "baseq3"), { recursive: true });
  writeFileSync(join(dataPath, "baseq3/default.cfg"), "set download_fixture 1\n");
  const startupPath = join(dataPath, "baseq3/pak0.pk3");
  writeFileSync(startupPath, sourceZip([{ name: new TextEncoder().encode("productid.txt"),
    data: new TextEncoder().encode(SOURCE_PRODUCT_ID), method: 0, utf8: false }]));
  using startupArchive = await Pk3Archive.open(startupPath);
  const startupChecksum = startupArchive.checksum | 0;
  const printed: string[] = [];
  const common = await CommonConsole.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
    startup: new StartupCommands(""), random: new LinuxNativeRandom(1), build: { kind: "dedicated" },
    platformPrint: text => { printed.push(text); }, resolveCommand: () => undefined,
    assertCommandEntry: () => undefined, assertOwnerEntry: () => undefined }, () => undefined);
  const { files, cvars } = common;
  cvars.register("cl_allowDownload", allow ? "1" : "0");
  const lifecycle = new ProtocolClientLifecycle(cvars), connection = lifecycle.clientConnection;
  const loopback = new LoopbackTransport(), peer = new Netchannel("server", 27961), challenge = 71;
  const session = new EngineClientSession({ product: "baseq3", cvars, lifecycle,
    mode: { kind: "network", challenge, qport: 27961 } });
  const packetCommands: (readonly string[])[] = [];
  const events: string[] = [];
  let ready = 0, serverAcknowledgement = 0;
  const delivery = { send: (bytes: Uint8Array): undefined => { loopback.send("client", bytes); },
    trace: (text: string): undefined => { printed.push(text); }, print: (text: string): undefined => { printed.push(text); } };
  const owner = new ClientDownloads({ files, cvars, connection, clientStatic: lifecycle.clientStatic,
    assertCurrentOperation: () => lifecycle.assertCurrentOperation(), print: text => { printed.push(text); onDownloadPrint(text); },
    addReliableCommand: text => { session.addReliableCommand(text); events.push(text); },
    writePacket: () => { events.push("packet"); session.transmit(delivery); },
    downloadsComplete: async () => {
      if (owner.consumeRestart()) {
        events.push("restart"); await files.restart({ checksumFeed: session.checksumFeed, random: () => 0 }, () => lifecycle.assertCurrentOperation());
        session.addReliableCommand("donedl"); events.push("donedl");
      } else { ready++; lifecycle.clientStatic.phase = "loading"; }
    } });
  connection.downloads = owner;
  lifecycle.applyServerPackages = async info => {
    await files.setServerLoadedPaks(infoValueForKey(info, "sv_paks"), infoValueForKey(info, "sv_pakNames"), () => lifecycle.assertCurrentOperation());
    files.setServerReferencedPaks(infoValueForKey(info, "sv_referencedPaks"), infoValueForKey(info, "sv_referencedPakNames"));
  };
  lifecycle.downloadSizeReceived = fileSize => owner.publishSize(fileSize);
  lifecycle.downloadReceived = block => owner.receive(block);
  lifecycle.gamestateReceived = async () => {
    await files.conditionalRestart(session.checksumFeed, () => lifecycle.assertCurrentOperation());
    await owner.initialize();
  };
  async function send(operations: readonly ServerOperation[]): Promise<void> {
    const sequence = peer.outgoingSequence, acknowledgement = serverAcknowledgement;
    const bytes = encodeServerMessage(acknowledgement, operations, { product: "baseq3", messageNumber: sequence,
      reliableSequence: acknowledgement, serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null });
    for (const packet of peer.transmit(xorServerMessage(bytes, challenge, sequence, connection.reliable.lookupMasked(acknowledgement)))) {
      loopback.send("server", packet);
      const received = loopback.poll("client");
      if (received === null) throw new Error("Loopback lost a queued server packet");
      await session.receiveDatagram(received.payload);
    }
  }
  function receiveClientPackets(): void {
    while (true) {
      const wire = loopback.poll("server"); if (wire === null) break;
      const received = peer.receive(wire.payload); if (received.kind !== "accepted") continue;
      const plaintext = xorClientMessage(received.payload, challenge, () => "");
      const decoded = decodeClientMessage(plaintext, {
        checksumFeed: session.checksumFeed, serverCommand: () => "", reliableSequence: 0,
        lastClientCommand: serverAcknowledgement, lastUserCommandTime: 0 });
      if (decoded.kind !== "accepted") throw new Error(`Server rejected fixture client packet: ${decoded.reason}`);
      serverAcknowledgement = decoded.lastClientCommand;
      const reader = new ClientMessageReader(plaintext), commands: string[] = []; reader.readHeader();
      while (true) {
        const part = reader.next();
        if (part.kind === "eof") break;
        if (part.kind !== "command") throw new Error("Download fixture emitted unexpected movement");
        commands.push(part.command.text);
      }
      packetCommands.push(commands);
    }
  }
  async function packageBytes(basename: string, text: string) {
    const bytes = sourceZip([{ name: new TextEncoder().encode(`scripts/${basename}.txt`), data: new TextEncoder().encode(text), method: 0, utf8: false }]);
    const path = join(root, `${basename}.pk3`); writeFileSync(path, bytes);
    using archive = await Pk3Archive.open(path);
    return { bytes, checksum: archive.checksum | 0, basename };
  }
  async function gamestate(references: string, names: string, pure = ""): Promise<void> {
    session.transmit(delivery); receiveClientPackets();
    const loadedPaks = pure === "" ? "" : `${startupChecksum} ${pure}`;
    await send([{ kind: "gamestate", commandSequence: 0, clientNumber: 1, checksumFeed: 1234, entries: [
      { kind: "configstring", index: 1, value: `\\sv_serverid\\100\\sv_cheats\\1\\sv_pure\\${pure === "" ? 0 : 1}\\sv_paks\\${loadedPaks}\\sv_referencedPaks\\${references}\\sv_referencedPakNames\\${names}` },
    ] }]);
  }
  async function block(download: Download): Promise<void> {
    session.transmit(delivery); receiveClientPackets();
    await send([{ kind: "download", block: download }]);
  }
  async function transfer(bytes: Uint8Array): Promise<void> {
    let number = 0;
    for (let position = 0; position < bytes.length; position += 1024) {
      const data = bytes.subarray(position, position + 1024);
      await block(number === 0 ? { kind: "start", fileSize: bytes.length, data } : { kind: "chunk", number, data });
      number++;
    }
    await block({ kind: "chunk", number, data: new Uint8Array() });
  }
  function close(): void {
    try { owner.disposeResources(); } finally { try { common.close(); } finally { lifecycle.close(); rmSync(root, { recursive: true }); } }
  }
  return { files, cvars, lifecycle, session, owner, events, printed, packetCommands, homePath, dataPath,
    ready: () => ready, send, gamestate, block, transfer, packageBytes, receiveClientPackets, close };
}

test("terminal download disposal closes its partial file without source cvar or connection callbacks", async () => {
  const f = await fixture(), set = f.cvars.set;
  try {
    const pack = await f.packageBytes("partial", "partial download");
    await f.gamestate(String(pack.checksum), "baseq3/partial");
    await f.block({ kind: "start", fileSize: pack.bytes.length, data: pack.bytes.subarray(0, 4) });
    const name = f.cvars.get("cl_downloadName"), temporary = f.lifecycle.clientConnection.downloadTempName;
    const events = [...f.events], printed = [...f.printed];
    f.cvars.set = () => { throw new Error("Terminal release must not call source cvar setters"); };
    f.owner.disposeResources(); f.owner.disposeResources();
    expect(f.cvars.get("cl_downloadName")).toEqual(name);
    expect(f.lifecycle.clientConnection.downloadTempName).toBe(temporary);
    expect(readFileSync(join(f.homePath, temporary))).toEqual(Buffer.from(pack.bytes.subarray(0, 4)));
    expect(f.events).toEqual(events); expect(f.printed).toEqual(printed);
    await expect(f.owner.receive({ kind: "chunk", number: 1, data: Uint8Array.of(1) })).rejects.toThrow("disposed");
    expect(() => f.owner.consumeRestart()).toThrow("disposed");
  } finally { f.cvars.set = set; f.close(); }
});

test("actual loopback download writes all blocks, acknowledges EOF twice, restarts mounts and awaits new gamestate", async () => {
  const f = await fixture();
  try {
    const pack = await f.packageBytes("custom", "downloaded asset\n".repeat(300));
    await f.gamestate(String(pack.checksum), "baseq3/custom", String(pack.checksum));
    expect(f.events).toEqual(["download baseq3/custom.pk3"]); expect(f.ready()).toBe(0);
    expect(f.lifecycle.clientConnection.connectedToPureServer).toBe(true);
    await f.transfer(pack.bytes);
    expect(readFileSync(join(f.homePath, "baseq3/custom.pk3"))).toEqual(Buffer.from(pack.bytes));
    expect(existsSync(join(f.homePath, "baseq3/custom.pk3.tmp"))).toBe(false);
    expect(f.events.slice(-4)).toEqual(["packet", "packet", "restart", "donedl"]);
    const packetsBeforeEof = f.packetCommands.length;
    f.receiveClientPackets(); expect(f.packetCommands.length).toBe(packetsBeforeEof + 2);
    expect(f.packetCommands.at(-2)).toEqual([`nextdl ${Math.ceil(pack.bytes.length / 1024)}`]);
    expect(f.packetCommands.at(-1)).toEqual(f.packetCommands.at(-2));
    expect(f.owner.receivedBytes).toBe(pack.bytes.length); expect(f.cvars.get("cl_downloadName")?.value).toBe("");
    expect(f.files.current.readSync("scripts/custom.txt")).toEqual(new TextEncoder().encode("downloaded asset\n".repeat(300)));
    expect(f.ready()).toBe(0); expect(f.lifecycle.clientStatic.phase).toBe("connected");
    await f.gamestate(String(pack.checksum), "baseq3/custom", String(pack.checksum));
    expect(compareClientPaks(f.files, true)).toBe(""); expect(f.ready()).toBe(1);
  } finally { f.close(); }
});

test("download begin prints after splitting its worklist and before changing names, cvars or commands", async () => {
  const expected = "***** CL_BeginDownload *****\nLocalname: baseq3/begin.pk3\n"
    + "Remotename: baseq3/begin.pk3\n****************************\n";
  let onBegin: (() => void) | null = null;
  const f = await fixture(true, text => { if (text === expected) onBegin?.(); });
  try {
    const pack = await f.packageBytes("begin", "begin bytes");
    f.cvars.set("developer", "1", true);
    f.cvars.set("cl_downloadName", "previous-name", true);
    f.cvars.set("cl_downloadCount", "7", true);
    onBegin = () => {
      expect(f.owner.pendingList).toBe("@baseq3/begin.pk3");
      expect(f.lifecycle.clientConnection.downloadTempName).toBe("");
      expect(f.cvars.get("cl_downloadName")?.value).toBe("previous-name");
      expect(f.cvars.get("cl_downloadCount")?.value).toBe("7");
      expect(f.owner.restartRequired).toBe(false);
      expect(f.events).toEqual([]);
      throw new CommonError("drop", "interrupted download begin print");
    };
    await expect(f.gamestate(`${pack.checksum} 123`, "baseq3/begin baseq3/second"))
      .rejects.toThrow("interrupted download begin print");
    expect(f.printed).toContain(expected);
    expect(f.owner.pendingList).toBe("@baseq3/begin.pk3");
    expect(f.events).toEqual([]);
  } finally { f.close(); }
});

test("zero-length download acknowledges EOF and requests a new gamestate after the empty pak is skipped", async () => {
  const f = await fixture();
  try {
    await f.gamestate("123", "baseq3/empty");
    await f.block({ kind: "start", fileSize: 0, data: new Uint8Array() });
    expect(readFileSync(join(f.homePath, "baseq3/empty.pk3"))).toEqual(Buffer.alloc(0));
    expect(existsSync(join(f.homePath, "baseq3/empty.pk3.tmp"))).toBe(false);
    expect(f.events).toEqual(["download baseq3/empty.pk3", "nextdl 0", "packet", "packet", "restart", "donedl"]);
    expect(f.owner.blockNumber).toBe(1);
    expect(f.owner.receivedBytes).toBe(0);
    expect(f.lifecycle.clientConnection.downloadTempName).toBe("");
    expect(f.ready()).toBe(0);
  } finally { f.close(); }
});

test("package comparison preserves server order, skips retail paks, and downloads a conflicting filename beside it", async () => {
  const f = await fixture();
  try {
    const old = await f.packageBytes("old", "existing package"), replacement = await f.packageBytes("custom", "replacement"), other = await f.packageBytes("other", "next");
    writeFileSync(join(f.homePath, "baseq3/custom.pk3"), old.bytes);
    await f.gamestate(`10 ${replacement.checksum} ${other.checksum} 11`, "baseq3/pak0 baseq3/custom baseq3/other missionpack/pak8");
    const local = `baseq3/custom.${(replacement.checksum >>> 0).toString(16).padStart(8, "0")}.pk3`;
    expect(f.lifecycle.clientConnection.downloadTempName).toBe(`${local}.tmp`);
    expect(f.owner.pendingList).toBe("baseq3/other.pk3@baseq3/other.pk3");
    await f.transfer(replacement.bytes);
    expect(readFileSync(join(f.homePath, "baseq3/custom.pk3"))).toEqual(Buffer.from(old.bytes));
    expect(readFileSync(join(f.homePath, local))).toEqual(Buffer.from(replacement.bytes));
    expect(f.events.at(-1)).toBe("download baseq3/other.pk3"); expect(f.events).not.toContain("donedl");
    await f.transfer(other.bytes); expect(f.events.at(-1)).toBe("donedl");
  } finally { f.close(); }
});

test("out-of-order and duplicate blocks do not append bytes, while source block-zero size updates remain visible", async () => {
  const f = await fixture();
  try {
    const pack = await f.packageBytes("ordered", "ordered bytes");
    await f.gamestate(String(pack.checksum), "baseq3/ordered");
    await f.block({ kind: "chunk", number: 1, data: Uint8Array.of(255) });
    expect(f.owner.receivedBytes).toBe(0); expect(existsSync(join(f.homePath, "baseq3/ordered.pk3.tmp"))).toBe(false);
    await f.block({ kind: "start", fileSize: pack.bytes.length, data: pack.bytes });
    await f.block({ kind: "start", fileSize: 999, data: Uint8Array.of(255) });
    expect(f.owner.receivedBytes).toBe(pack.bytes.length); expect(f.cvars.get("cl_downloadSize")?.value).toBe("999");
    await f.block({ kind: "chunk", number: 1, data: new Uint8Array() });
    expect(readFileSync(join(f.homePath, "baseq3/ordered.pk3"))).toEqual(Buffer.from(pack.bytes));
  } finally { f.close(); }
});

test("unsolicited blocks stop transfer and negative server errors preserve their actual signed size before dropping", async () => {
  const f = await fixture();
  try {
    await f.block({ kind: "start", fileSize: 5, data: Uint8Array.of(1) });
    expect(f.events).toEqual(["stopdl"]); expect(f.cvars.get("cl_downloadSize")?.value).toBe("5");
    await expect(f.block({ kind: "error", fileSize: -123, message: "server refused fixture" })).rejects.toBeInstanceOf(CommonError);
    expect(f.cvars.get("cl_downloadSize")?.value).toBe("-123"); expect(f.owner.receivedBytes).toBe(0);
  } finally { f.close(); }
});

test("download UI cvars narrow source integer values through Cvar_SetValue binary32", async () => {
  const f = await fixture();
  try {
    const pack = await f.packageBytes("scalars", "small payload");
    f.lifecycle.clientStatic.realtime = 16777217;
    await f.gamestate(String(pack.checksum), "baseq3/scalars");
    expect(f.cvars.get("cl_downloadTime")?.value).toBe("16777216");
    await f.block({ kind: "start", fileSize: 16777217, data: pack.bytes });
    expect(f.owner.fileSize).toBe(16777217); expect(f.cvars.get("cl_downloadSize")?.value).toBe("16777216");
    await expect(f.block({ kind: "error", fileSize: -16777217, message: "negative source size" })).rejects.toBeInstanceOf(CommonError);
    expect(f.owner.fileSize).toBe(-16777217); expect(f.cvars.get("cl_downloadSize")?.value).toBe("-16777216");
  } finally { f.close(); }
});

test("disabled downloads print the actual missing list and enter the loading handoff", async () => {
  const f = await fixture(false);
  try {
    const pack = await f.packageBytes("missing", "not installed");
    await f.gamestate(String(pack.checksum), "baseq3/missing");
    expect(f.ready()).toBe(1); expect(f.events).toEqual([]);
    expect(f.printed.some(text => text.includes("baseq3/missing.pk3\nYou might not be able"))).toBe(true);
  } finally { f.close(); }
});

test("a preexisting temporary file is preserved and source open failure sends stopdl before requesting new gamestate", async () => {
  const f = await fixture();
  try {
    const pack = await f.packageBytes("occupied", "payload");
    const path = join(f.homePath, "baseq3/occupied.pk3.tmp"); writeFileSync(path, "unrelated temporary file");
    await f.gamestate(String(pack.checksum), "baseq3/occupied");
    await f.block({ kind: "start", fileSize: pack.bytes.length, data: pack.bytes });
    expect(readFileSync(path, "utf8")).toBe("unrelated temporary file");
    expect(f.events.slice(-3)).toEqual(["stopdl", "restart", "donedl"]); expect(f.ready()).toBe(0);
  } finally { f.close(); }
});

test("download name containment rejects path escapes and finalization never replaces a newly arrived package", async () => {
  const f = await fixture();
  try {
    f.files.setServerReferencedPaks("123", "../escape");
    expect(() => compareClientPaks(f.files, true)).toThrow("Unsafe package");
    const pack = await f.packageBytes("race", "download"), existing = await f.packageBytes("existing", "preserve");
    await f.gamestate(String(pack.checksum), "baseq3/race");
    await f.block({ kind: "start", fileSize: pack.bytes.length, data: pack.bytes });
    const path = join(f.homePath, "baseq3/race.pk3"); writeFileSync(path, existing.bytes);
    await expect(f.block({ kind: "chunk", number: 1, data: new Uint8Array() })).rejects.toThrow();
    expect(readFileSync(path)).toEqual(Buffer.from(existing.bytes));
    expect(readFileSync(`${path}.tmp`)).toEqual(Buffer.from(pack.bytes));
    expect(f.events).not.toContain("donedl");
  } finally { f.close(); }
});
