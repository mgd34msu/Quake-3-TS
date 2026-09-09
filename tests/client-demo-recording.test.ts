import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { WritableFileSystem } from "../src/assets/writable-files.ts";
import type { CommandContext } from "../src/core/commands.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ClientDemoRecording } from "../src/engine/client-demo-recording.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { DemoReader } from "../src/protocol/demo.ts";
import { MessageWriter } from "../src/protocol/message.ts";
import { Netchannel, xorServerMessage } from "../src/protocol/netchan.ts";
import { decodeServerMessage, encodeServerMessage, ServerOpcode } from "../src/protocol/server-message.ts";
import type { ServerMessageContext, ServerOperation, Snapshot } from "../src/protocol/server-message.ts";
import { EntityState } from "../src/shared/entity-state.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";

function command(...argv: string[]): CommandContext {
  return { argv, args: argv.slice(1), raw: argv.join(" "), append: () => {}, insert: () => {}, assertActive: () => {} };
}

async function fixture(onPrint: (text: string) => undefined = () => undefined) {
  const root = mkdtempSync(join(tmpdir(), "quake3-demo-recording-"));
  mkdirSync(join(root, "baseq3"));
  writeFileSync(join(root, "baseq3/default.cfg"), "fixture\n");
  const cvars = new CvarRegistry(), sound = new SoundOutput(), prints: string[] = [];
  const files = new CommonFileState({ dataPath: root, homePath: root, cdPath: null, product: "baseq3" },
    text => { prints.push(text); }, sound, cvars);
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
  const lifecycle = new ProtocolClientLifecycle(cvars);
  const session = new EngineClientSession({ product: "baseq3", cvars, lifecycle,
    mode: { kind: "network", challenge: 71, qport: 27961 } });
  lifecycle.clientConnection.reliable.add("userinfo test");
  const recorder = new ClientDemoRecording({ files, cvars, connection: lifecycle.clientConnection,
    session: () => session, print: text => { prints.push(text); onPrint(text); } });
  const peer = new Netchannel("server", 27961);
  function context(): ServerMessageContext {
    return { product: "baseq3", messageNumber: peer.outgoingSequence, reliableSequence: 1,
      serverCommandSequence: 3, parseEntitiesNumber: 0, baseline: () => null, history: () => null };
  }
  async function receive(bytes: Uint8Array): Promise<void> {
    const sequence = peer.outgoingSequence;
    for (const packet of peer.transmit(xorServerMessage(bytes, 71, sequence, "userinfo test"))) {
      await session.receiveDatagram(packet);
    }
  }
  async function send(operations: readonly ServerOperation[]): Promise<Uint8Array> {
    const bytes = encodeServerMessage(1, operations, context());
    await receive(bytes);
    return bytes;
  }
  function snapshot(deltaNumber = -1): Snapshot {
    return { messageNumber: peer.outgoingSequence, serverTime: peer.outgoingSequence * 50,
      deltaNumber, flags: 0, serverCommandNumber: 3, parseEntitiesNumber: 0,
      areaMask: new Uint8Array(), playerState: new PlayerState("baseq3"), entities: [] };
  }
  async function activate(): Promise<void> {
    const baseline = new EntityState(); baseline.number = 1; baseline.modelindex = 9;
    await send([{ kind: "gamestate", commandSequence: 3, clientNumber: 7, checksumFeed: 1234, entries: [
      { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1" },
      { kind: "configstring", index: 5, value: "" },
      { kind: "baseline", number: 0, entity: new EntityState() },
      { kind: "baseline", number: 1, entity: baseline },
    ] }]);
    session.prime(session.gamestateGeneration);
    await send([{ kind: "snapshot", validity: { kind: "valid" }, snapshot: snapshot() }]);
    await session.setCGameTime();
    expect(lifecycle.clientStatic.phase).toBe("active");
  }
  function close(): void {
    recorder.close(); lifecycle.close(); files.close(); sound.close();
    rmSync(root, { recursive: true, force: true });
  }
  return { root, files, cvars, lifecycle, session, recorder, prints, peer, context, receive, send, snapshot, activate, close };
}

test("record copies at most 63 source bytes before formatting and stops at NUL", async () => {
  const f = await fixture();
  try {
    await f.activate();
    f.cvars.register("g_synchronousClients", "1");
    for (const requested of ["\xe9".repeat(62), "\xe9".repeat(63), "\xe9".repeat(64), "short\0ignored"]) {
      f.prints.length = 0;
      const name = requested.startsWith("short") ? "short" : requested.slice(0, 63);
      f.recorder.record(command("record", requested));
      expect(f.recorder.screenInfo()?.name).toBe(name);
      expect(statSync(join(f.root, `baseq3/demos/${name}.dm_68`)).size).toBeGreaterThan(8);
      expect(f.prints).toEqual([`recording to demos/${name}.dm_68.\n`]);
      f.recorder.stop();
    }
  } finally { f.close(); }
});

test("aborting the recording filename print opens no file and leaves recording state untouched", async () => {
  const failure = new Error("record print abort");
  const f = await fixture(text => { if (text.startsWith("recording to")) throw failure; });
  try {
    await f.activate();
    let opens = 0;
    const writable = f.files.writable, open = writable.openBinaryWrite.bind(writable);
    writable.openBinaryWrite = path => { opens++; return open(path); };
    expect(() => f.recorder.record(command("record", "abort"))).toThrow(failure);
    expect(opens).toBe(0);
    expect(f.recorder.active).toBe(false);
    expect(f.lifecycle.clientConnection.demoWaiting).toBe(false);
    expect(f.recorder.screenInfo()).toBeNull();
    expect(f.prints).toEqual([
      "^3WARNING: You should set 'g_synchronousClients 1' for smoother demo recording\n",
      "recording to demos/abort.dm_68.\n",
    ]);
  } finally { f.close(); }
});

test("actual recording writes present gamestate fields, waits for a full packet, and ends with the demo terminator", async () => {
  const f = await fixture();
  try {
    expect(f.recorder.screenInfo()).toBeNull();
    f.recorder.record(command("record", "early"));
    expect(f.prints.at(-1)).toBe("You must be in a level to record.\n");
    await f.activate();
    f.recorder.record(command("record", "roundtrip"));
    expect(f.lifecycle.clientConnection.demoWaiting).toBe(true);
    const path = join(f.root, "baseq3/demos/roundtrip.dm_68");
    const initialSize = statSync(path).size;
    const firstReader = new DemoReader(readFileSync(path));
    const first = firstReader.next(() => undefined);
    if (first.kind !== "message") throw new Error("Expected initial gamestate record");
    expect(first.sequence).toBe(1);
    const decoded = decodeServerMessage(first.payload, { ...f.context(), messageNumber: first.sequence });
    expect(decoded.reliableAcknowledge).toBe(1);
    const state = decoded.operations[0];
    if (state?.kind !== "gamestate") throw new Error("Expected recorded gamestate");
    expect([state.commandSequence, state.clientNumber, state.checksumFeed]).toEqual([3, 7, 1234]);
    expect(state.entries.filter(entry => entry.kind === "configstring")).toEqual([
      { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1" },
      { kind: "configstring", index: 5, value: "" },
    ]);
    expect(state.entries.filter(entry => entry.kind === "baseline").map(entry => entry.number)).toEqual([1]);
    await f.send([{ kind: "nop" }]);
    expect(statSync(path).size).toBe(initialSize);
    const full = await f.send([{ kind: "snapshot", validity: { kind: "valid" }, snapshot: f.snapshot() }]);
    expect(f.lifecycle.clientConnection.demoWaiting).toBe(false);
    expect(f.recorder.screenInfo()).toEqual({ name: "roundtrip", kibibytes: Math.trunc(statSync(path).size / 1024) });
    f.recorder.stop();
    const reader = new DemoReader(readFileSync(path));
    expect(reader.next(() => undefined)).toEqual(first);
    expect(reader.next(() => undefined)).toEqual({ kind: "message", sequence: 4, payload: full });
    expect(reader.next(() => undefined)).toEqual({ kind: "end", reason: "terminator", offset: initialSize + full.length + 8 });
    expect(f.recorder.screenInfo()).toBeNull();
    expect(f.prints.at(-1)).toBe("Stopped demo.\n");
    f.cvars.register("ui_recordSPDemo", "1");
    f.recorder.record(command("record"));
    expect(f.recorder.screenInfo()).toBeNull();
    expect(statSync(join(f.root, "baseq3/demos/demo0000.dm_68")).size).toBeGreaterThan(8);
    f.recorder.stop();
  } finally { f.close(); }
});

test("a malformed full snapshot clears demoWaiting at its header before its body fails and records no failed packet", async () => {
  const f = await fixture();
  try {
    await f.activate();
    f.recorder.record(command("record", "partial"));
    const path = join(f.root, "baseq3/demos/partial.dm_68"), initialSize = statSync(path).size;
    const writer = new MessageWriter();
    writer.writeLong(1); writer.writeByte(ServerOpcode.Snapshot);
    writer.writeLong(500); writer.writeByte(0); writer.writeByte(0); writer.writeByte(33);
    await expect(f.receive(writer.toBytes())).rejects.toThrow("area mask");
    expect(f.lifecycle.clientConnection.demoWaiting).toBe(false);
    expect(statSync(path).size).toBe(initialSize);
  } finally { f.close(); }
});

test("binary FS_Write returns source zero after partial progress while tell reads the actual descriptor position", () => {
  const root = mkdtempSync(join(tmpdir(), "quake3-demo-write-")), prints: string[] = [];
  class PartialFiles extends WritableFileSystem {
    calls = 0;
    protected override writeChunk(descriptor: number, bytes: Uint8Array, offset: number, length: number, position: number | null): number {
      this.calls++;
      return this.calls === 1 ? super.writeChunk(descriptor, bytes, offset, Math.min(length, 2), position) : 0;
    }
  }
  const files = new PartialFiles({ homePath: root, product: "baseq3", print: text => { prints.push(text); } });
  try {
    const file = files.openBinaryWrite("demos/partial.dm_68");
    if (file === null) throw new Error("Expected actual binary writable file");
    expect(file.writeBytes(new Uint8Array([0, 255, 128, 0]))).toBe(0);
    expect(file.tell()).toBe(2);
    writeFileSync(join(root, "baseq3/demos/partial.dm_68"), new Uint8Array(4096));
    expect(file.tell()).toBe(2);
    expect(prints).toEqual(["FS_Write: 0 bytes written\n"]);
  } finally { files.closeAll(); rmSync(root, { recursive: true, force: true }); }
});
