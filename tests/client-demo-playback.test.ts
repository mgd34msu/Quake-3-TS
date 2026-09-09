import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CommonError } from "../src/core/common-error.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ClientDemoPlayback } from "../src/engine/client-demo-playback.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { encodeDemo } from "../src/protocol/demo.ts";
import type { DemoEnd, DemoMessage } from "../src/protocol/demo.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { sourceZip } from "./pk3-source-fixture.ts";

async function fixture(packed: Uint8Array | null = null) {
  const root = mkdtempSync(join(tmpdir(), "quake3-demo-playback-"));
  mkdirSync(join(root, "baseq3/demos"), { recursive: true });
  writeFileSync(join(root, "baseq3/default.cfg"), "fixture\n");
  if (packed !== null) writeFileSync(join(root, "baseq3/pak0.pk3"), sourceZip([
    { name: new TextEncoder().encode("demos/packed.dm_68"), data: packed, method: 8, utf8: false },
  ]));
  const prints: string[] = [], cvars = new CvarRegistry(), sound = new SoundOutput();
  const print = (text: string): undefined => { prints.push(text); };
  const files = new CommonFileState({ dataPath: root, homePath: root, cdPath: null, product: "baseq3" }, print, sound, cvars);
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => {});
  const opened: ClientDemoPlayback[] = [];
  function open(name: string, diagnostic = print): ClientDemoPlayback {
    return ClientDemoPlayback.open(files, name, diagnostic, playback => { opened.push(playback); });
  }
  function write(name: string, bytes: Uint8Array): string {
    const path = join(root, "baseq3/demos", name);
    writeFileSync(path, bytes);
    return path;
  }
  function close(): void {
    for (const playback of opened) playback.close();
    files.close(); sound.close(); rmSync(root, { recursive: true, force: true });
  }
  return { root, files, cvars, prints, opened, open, write, close };
}

test("actual session publishes the retained demo sequence before length reads, completion, warning and errors", async () => {
  const header = new Uint8Array(8), view = new DataView(header.buffer);
  view.setInt32(0, -2147483648, true);
  const cases: { readonly bytes: Uint8Array; readonly error: boolean; readonly expectedSequence: number; readonly payloadRead: boolean }[] = [];
  for (let length = 0; length < 8; length++) {
    cases.push({ bytes: header.slice(0, length), error: false, expectedSequence: length < 4 ? 55 : -2147483648, payloadRead: false });
  }
  for (const length of [-1, -2, -2147483648, 16385, 4]) {
    view.setInt32(4, length, true);
    cases.push({ bytes: length === 4 ? Uint8Array.of(...header, 11, 12) : header.slice(),
      error: length < -1 || length > 16384, expectedSequence: -2147483648, payloadRead: length === 4 });
  }
  for (const input of cases) {
    const f = await fixture();
    try {
      f.write("sequence.dm_68", input.bytes);
      const reader = f.open("sequence.dm_68"), lifecycle = new ProtocolClientLifecycle(f.cvars);
      const session = new EngineClientSession({ product: "baseq3", cvars: f.cvars, lifecycle, mode: { kind: "demo", reader } });
      await session.receiveServerMessage(55, encodeServerMessage(0, [{ kind: "nop" }], {
        product: "baseq3", messageNumber: 55, reliableSequence: 0, serverCommandSequence: 0,
        parseEntitiesNumber: 0, baseline: () => null, history: () => null,
      }));
      lifecycle.clientStatic.realtime = 456; lifecycle.clientConnection.lastPacketTime = 123;
      const reads: (readonly [number, number, number])[] = [], completions: (readonly [number, number])[] = [];
      const files = f.files.current, readInto = files.readInto.bind(files), complete = lifecycle.demoCompleted.bind(lifecycle);
      files.readInto = (file, destination) => {
        reads.push([reader.offset, session.serverMessageSequence, lifecycle.clientConnection.lastPacketTime]);
        return readInto(file, destination);
      };
      lifecycle.demoCompleted = async (end, timing) => {
        completions.push([session.serverMessageSequence, lifecycle.clientConnection.lastPacketTime]);
        await complete(end, timing);
      };
      if (input.error) await expect(session.readInitialDemoMessages()).rejects.toThrow(CommonError);
      else await session.readInitialDemoMessages();
      expect(session.serverMessageSequence).toBe(input.expectedSequence);
      expect(lifecycle.clientConnection.lastPacketTime).toBe(123);
      expect(completions).toEqual(input.error ? [] : [[input.expectedSequence, 123]]);
      expect(reads).toEqual(input.bytes.length < 4 ? [[0, 55, 123]] : input.payloadRead
        ? [[0, 55, 123], [4, -2147483648, 123], [8, -2147483648, 123]]
        : [[0, 55, 123], [4, -2147483648, 123]]);
      expect(reader.offset).toBe(input.bytes.length);
      expect(f.prints).toEqual(input.payloadRead ? ["Demo file was truncated.\n"] : []);
      lifecycle.close();
    } finally { f.close(); }
  }
});

test("source fallback tries protocols 66, 67, 68 in order; explicit supported extensions never retry", async () => {
  const f = await fixture();
  try {
    f.write("walk.dm_67", encodeDemo([]));
    f.write("walk.dm_68", encodeDemo([]));
    expect(f.open("walk").source).toBe("demos/walk.dm_67");
    expect(f.prints).toEqual(["Not found: demos/walk.dm_66\n", "Demo file: demos/walk.dm_67\n"]);
    f.prints.length = 0;
    expect(f.open("walk.dm_68").source).toBe("demos/walk.dm_68");
    expect(f.prints).toEqual([]);
    expect(() => f.open("walk.dm_66")).toThrow("couldn't open demos/walk.dm_66");
    expect(f.prints).toEqual([]);
    f.write("walk.dm_66", encodeDemo([]));
    expect(f.open("walk").source).toBe("demos/walk.dm_66");
    f.write("upper.DM_68", encodeDemo([]));
    expect(f.open("upper.DM_68").source).toBe("demos/upper.DM_68");
  } finally { f.close(); }
});

test("an aborted successful demo diagnostic leaves the source file open for disconnect", async () => {
  const f = await fixture();
  try {
    f.write("opened.dm_66", encodeDemo([]));
    const files = f.files.current, closeFile = files.closeFile.bind(files);
    let closes = 0;
    files.closeFile = file => { closes++; closeFile(file); };
    const failure = new CommonError("drop", "demo diagnostic abort");
    expect(() => f.open("opened", () => {
      expect(f.opened.at(-1)?.name).toBe("");
      throw failure;
    })).toThrow(failure);
    expect(closes).toBe(0);
    const reader = f.opened.at(-1);
    if (reader === undefined) throw new Error("Demo file was not published before the diagnostic");
    expect(reader.next(() => undefined)).toEqual({ kind: "end", reason: "terminator", offset: 0 });
    reader.close(); reader.close();
    expect(closes).toBe(1);
  } finally { f.close(); }
});

test("demo formatting warns at Linux PATH_MAX before open and checks the 32000-byte scratch first", async () => {
  const f = await fixture();
  try {
    f.write("target.dm_68", encodeDemo([]));
    const files = f.files.current, open = files.openUniqueRead.bind(files);
    const events: string[] = [];
    files.openUniqueRead = path => {
      events.push(`open:${path.length}`);
      return open("demos/target.dm_68");
    };
    for (const explicit of [false, true]) {
      for (const length of [4095, 4096, 31999, 32000]) {
        events.length = 0;
        const name = "\xe9".repeat(length - 12) + (explicit ? ".dm_68" : "");
        const print = (text: string): undefined => { events.push(text); };
        if (length === 32000) {
          expect(() => f.open(name, print)).toThrow("Com_sprintf: overflowed bigbuffer");
          expect(events).toEqual([]);
        } else {
          const reader = f.open(name, print);
          try {
            const path = `demos/${name}${explicit ? "" : ".dm_66"}`.slice(0, 4095);
            expect(reader.source).toBe(path);
            expect(events).toEqual([
              ...(length >= 4096 ? [`Com_sprintf: overflow of ${length} in 4096\n`] : []),
              "open:4095",
              ...(explicit ? [] : [`Demo file: ${path}\n`]),
            ]);
          } finally { reader.close(); }
        }
      }
    }
  } finally { f.close(); }
});

test("aborting a filename warning preserves prior fallback effects without opening the next attempt", async () => {
  const f = await fixture();
  try {
    const events: string[] = [], failure = new Error("print abort");
    let warnings = 0;
    f.files.current.openUniqueRead = path => { events.push(`open:${path.length}`); return undefined; };
    const name = "x".repeat(4084);
    expect(() => f.open(name, text => {
      events.push(text);
      if (text.startsWith("Com_sprintf") && ++warnings === 2) throw failure;
    })).toThrow(failure);
    expect(events).toEqual([
      "Com_sprintf: overflow of 4096 in 4096\n", "open:4095",
      `Not found: ${`demos/${name}.dm_66`.slice(0, 4095)}\n`,
      "Com_sprintf: overflow of 4096 in 4096\n",
    ]);
    events.length = 0;
    expect(() => f.open(`${name}.dm_68`, () => { throw failure; })).toThrow(failure);
    expect(events).toEqual([]);
  } finally { f.close(); }
});

test("demo arguments end at the first source NUL before extension detection", async () => {
  const f = await fixture();
  try {
    f.write("nul.dm_68", encodeDemo([]));
    const reader = f.open("nul.dm_68\0ignored.dm_99");
    expect(reader.source).toBe("demos/nul.dm_68");
    expect(reader.name).toBe("nul.dm_68");
    expect(f.prints).toEqual([]);
    expect(() => f.open("\u0100.dm_68")).toThrow("source byte characters");
  } finally { f.close(); }
});

test("unsupported demo protocol copies the bounded retry name before stripping six bytes", async () => {
  const f = await fixture();
  try {
    const events: string[] = [], name = `${"x".repeat(4100)}.dm_99`;
    f.files.current.openUniqueRead = path => { events.push(path); return undefined; };
    expect(() => f.open(name, text => { events.push(text); })).toThrow("couldn't open");
    const path = `demos/${"x".repeat(4089)}`;
    expect(events).toEqual([
      "Protocol 99 not supported for demos\n",
      ...[66, 67, 68].flatMap(() => ["Com_sprintf: overflow of 4101 in 4096\n", path, `Not found: ${path}\n`]),
    ]);
  } finally { f.close(); }
});

test("protocols 66, 67 and 68 share source gamestate and snapshot bytes through retained playback", async () => {
  // The dbe4ddb MSG_*/SV_WriteSnapshotToClient captures in server-message.test.ts.
  // CL_PlayDemo_f selects a filename; CL_ParseServerMessage always uses MSG_Bitstream.
  const messages: readonly DemoMessage[] = [
    { kind: "message", sequence: 9, payload: Buffer.from("6c15f9ab6c3d967781cdcde66519781ec18e014259ca028f60b2b7c7f22eb0f3604717b023944bc786df2f1bba3e01c0480000ff15a92e8d3705bf02", "hex") },
    { kind: "message", sequence: 10, payload: Buffer.from("6c35e2570b8f5018b23707c3c49cf54fb2d55024fb9b21be6c5d29410100000000cbdb4b229d58f900bc97c90a", "hex") },
    { kind: "message", sequence: 11, payload: Buffer.from("6cf55f2554772892fd21c53eea13001c0a0060da9eac00", "hex") },
  ];
  const bytes = encodeDemo(messages);
  for (const protocol of [66, 67, 68]) {
    const f = await fixture(), lifecycle = new ProtocolClientLifecycle(f.cvars);
    try {
      const name = `source.dm_${protocol}`;
      f.write(name, bytes);
      f.cvars.register("sv_serverid", "456");
      const reader = f.open(name);
      const session = new EngineClientSession({ product: "baseq3", cvars: f.cvars, lifecycle, mode: { kind: "demo", reader } });
      const received = lifecycle.gamestateReceived.bind(lifecycle);
      lifecycle.gamestateReceived = async generation => {
        await received(generation);
        session.prime(generation); // Explicit protocol fixture only; no cgame initialization.
      };
      await session.readInitialDemoMessages();
      expect(lifecycle.clientStatic.phase).toBe("primed");
      expect(reader.offset).toBe(68);
      expect(session.serverMessageSequence).toBe(9);
      expect(session.getConfigString(0)).toBe("\\sv_hostname\\Fixture");
      expect([session.clientNumber, session.checksumFeed, session.serverId, session.serverCommandSequence])
        .toEqual([2, 0x12345678, 123, 7]);
      expect(f.cvars.get("sv_serverid")?.value).toBe("456");
      await session.setCGameTime();
      expect(reader.offset).toBe(68);
      await session.setCGameTime();
      expect(lifecycle.clientStatic.phase).toBe("active");
      expect(session.serverMessageSequence).toBe(11);
      expect(reader.offset).toBe(bytes.length - 8);
      const full = session.snapshots.read(10), delta = session.snapshots.read(11);
      expect(full?.playerState.origin).toEqual({ x: 10.5, y: 0, z: 0 });
      expect(full?.playerState.stats.get(0)).toBe(100);
      expect(full?.entities.map(entity => [entity.number, entity.modelindex])).toEqual([[1, 0], [3, 7]]);
      expect(full?.areaMask.slice(0, 3)).toEqual(Uint8Array.of(3, 128, 0));
      expect(delta?.playerState.origin).toEqual({ x: 12, y: 0, z: 0 });
      expect(delta?.entities.map(entity => [entity.number, entity.modelindex])).toEqual([[1, 0], [2, 9]]);
      expect(session.snapshots.current()).toEqual({ number: 11, serverTime: 1050 });
      lifecycle.clientStatic.realtime = 50;
      await session.setCGameTime();
      expect(lifecycle.clientStatic.phase).toBe("disconnected");
      expect(session.serverMessageSequence).toBe(-1);
      expect(reader.offset).toBe(bytes.length);
      expect(lifecycle.completions).toEqual([{ end: { kind: "end", reason: "terminator", offset: bytes.length - 8 }, timing: null }]);
      expect(f.prints).toEqual([]);
    } finally { lifecycle.close(); f.close(); }
  }
});

test("only the source final six-character extension pattern triggers protocol stripping", async () => {
  const f = await fixture();
  try {
    f.write("retry.dm_68", encodeDemo([]));
    expect(f.open("retry.Dm_99").source).toBe("demos/retry.dm_68");
    expect(f.prints).toEqual(["Protocol 99 not supported for demos\n", "Not found: demos/retry.dm_66\n",
      "Not found: demos/retry.dm_67\n", "Demo file: demos/retry.dm_68\n"]);
    f.prints.length = 0;
    f.write("retry.dm_6.dm_66", encodeDemo([]));
    expect(f.open("retry.dm_6").source).toBe("demos/retry.dm_6.dm_66");
    f.write(".dm_68.dm_66", encodeDemo([]));
    expect(f.open(".dm_68").source).toBe("demos/.dm_68.dm_66");
    f.write("retry.dm_068.dm_66", encodeDemo([]));
    expect(f.open("retry.dm_068").source).toBe("demos/retry.dm_068.dm_66");
    f.prints.length = 0;
    expect(() => f.open("missing")).toThrow("couldn't open demos/missing.dm_68");
    expect(f.prints).toEqual(["Not found: demos/missing.dm_66\n", "Not found: demos/missing.dm_67\n", "Not found: demos/missing.dm_68\n"]);
  } finally { f.close(); }
});

test("retained loose reads observe later growth and retain the opened file across pathname replacement and mount restart", async () => {
  const f = await fixture();
  try {
    const path = f.write("live.dm_68", new Uint8Array());
    const reader = f.open("live.dm_68");
    const first: DemoMessage = { kind: "message", sequence: 7, payload: Uint8Array.of(11, 12) };
    const second: DemoMessage = { kind: "message", sequence: -2147483648, payload: new Uint8Array(16384).fill(27) };
    appendFileSync(path, encodeDemo([first]).subarray(0, 10));
    expect(reader.next(() => undefined)).toEqual(first);
    expect(reader.offset).toBe(10);
    renameSync(path, `${path}.retained`);
    f.write("live.dm_68", encodeDemo([]));
    appendFileSync(`${path}.retained`, encodeDemo([second]));
    await f.files.restart({ checksumFeed: 1, random: () => 0 }, () => {});
    expect(reader.next(() => undefined)).toEqual(second);
    expect(reader.next(() => undefined)).toEqual({ kind: "end", reason: "terminator", offset: 16402 });
    expect(reader.offset).toBe(16410);
    reader.close(); reader.close();
    expect(f.open("live.dm_68").next(() => undefined)).toEqual({ kind: "end", reason: "terminator", offset: 0 });
  } finally { f.close(); }
});

test("each short header consumes only available bytes and ends without the payload warning", async () => {
  const f = await fixture();
  try {
    for (let length = 0; length < 8; length++) {
      f.write(`short${length}.dm_68`, new Uint8Array(length));
      const reader = f.open(`short${length}.dm_68`);
      const end: DemoEnd = { kind: "end", reason: length === 0 ? "eof" : "truncated-header", offset: 0 };
      expect(reader.next(() => undefined)).toEqual(end);
      expect(reader.offset).toBe(length);
      expect(reader.next(() => undefined)).toEqual(end);
    }
    expect(f.prints).toEqual([]);
  } finally { f.close(); }
});

test("truncation after open is seen at its payload read; zero lengths and non-minus-one sequence terminators follow source framing", async () => {
  const f = await fixture();
  try {
    const path = f.write("cut.dm_68", Buffer.from("0100000004000000aabbccdd", "hex"));
    const cut = f.open("cut.dm_68");
    truncateSync(path, 10);
    expect(cut.next(() => undefined)).toEqual({ kind: "end", reason: "truncated-payload", offset: 0 });
    expect(cut.offset).toBe(10);
    cut.next(() => undefined);
    expect(f.prints).toEqual(["Demo file was truncated.\n"]);
    f.write("zero.dm_68", Buffer.from("ffffffff0000000005000000ffffffffaabbcc", "hex"));
    const zero = f.open("zero.dm_68");
    expect(zero.next(() => undefined)).toEqual({ kind: "message", sequence: -1, payload: new Uint8Array() });
    expect(zero.next(() => undefined)).toEqual({ kind: "end", reason: "terminator", offset: 8 });
    expect(zero.offset).toBe(16);
  } finally { f.close(); }
});

test("oversized and invalid negative lengths drop after the eight-byte header", async () => {
  const f = await fixture();
  try {
    for (const length of [16385, 2147483647, -2, -2147483648]) {
      const bytes = new Uint8Array(12);
      new DataView(bytes.buffer).setInt32(4, length, true);
      f.write("bad.dm_68", bytes);
      const reader = f.open("bad.dm_68");
      expect(() => reader.next(() => undefined)).toThrow(CommonError);
      expect(reader.offset).toBe(8);
      reader.close();
    }
    expect(f.prints).toEqual([]);
  } finally { f.close(); }
});

test("packed demo readers have independent cursors and survive source common mount replacement", async () => {
  const messages: readonly [DemoMessage, DemoMessage] = [
    { kind: "message", sequence: 1, payload: Uint8Array.of(13, 14) },
    { kind: "message", sequence: 2, payload: Uint8Array.of(21) },
  ];
  const f = await fixture(encodeDemo(messages));
  try {
    const first = f.open("packed.dm_68"), second = f.open("packed.dm_68");
    expect(first.next(() => undefined)).toEqual(messages[0]);
    expect(second.next(() => undefined)).toEqual(messages[0]);
    await f.files.restart({ checksumFeed: 2, random: () => 0 }, () => {});
    expect(first.next(() => undefined)).toEqual(messages[1]);
    first.close();
    expect(second.next(() => undefined)).toEqual(messages[1]);
    expect(second.next(() => undefined)).toEqual({ kind: "end", reason: "terminator", offset: 19 });
  } finally { f.close(); }
});
