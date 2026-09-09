import { finishCalls, runCalls } from "../src/core/call-steps.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { closeSync, fstatSync, openSync, readlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerDownloadError } from "../src/assets/download-file.ts";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { MessageReader, MessageWriter } from "../src/protocol/message.ts";
import { ServerOpcode } from "../src/protocol/server-message.ts";
import { ServerDownloadRuntime } from "../src/server/downloads.ts";
import { ServerStaticState } from "../src/server/state.ts";
import type { Product } from "../src/shared/definitions.ts";

const directories: string[] = [];
const runtimes: ServerDownloadRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    for (const client of runtime.staticState.clients) if (client.download.file !== null) runtime.close(client);
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(product: Product, size: number) {
  const root = await mkdtemp(join(tmpdir(), "quake-server-download-")); directories.push(root);
  await mkdir(join(root, "custom"));
  const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 53 + 7) & 255);
  await writeFile(join(root, "custom", "map.pk3"), bytes);
  const state = new ServerStaticState({ product, maxClients: 2, dedicated: false });
  const client = state.clients[0];
  if (client === undefined) throw new Error("Missing fixture client");
  client.rate = 0; client.snapshotMsec = 50;
  const cvars = new CvarRegistry();
  cvars.register("sv_allowDownload", "1"); cvars.register("sv_pure", "0"); cvars.register("sv_maxRate", "0");
  const logs: string[] = [], drops: string[] = [], gamestates: number[] = [];
  const files = new CommonFileState({ homePath: root, dataPath: root, cdPath: null, product },
    () => undefined, new SoundOutput(), cvars);
  fileOwners.push(files);
  await files.initialize({ checksumFeed: 0, random: () => 0 }, () => undefined);
  const runtime = new ServerDownloadRuntime(state, { files: files.server, cvars,
    print: text => logs.push(text), debugPrint: text => logs.push(text), *dropClient(target, reason): CallSteps { drops.push(`${target.slot}:${reason}`); },
    sendClientGameState: target => gamestates.push(target.slot) });
  runtimes.push(runtime);
  return { root, bytes, state, client, cvars, logs, drops, gamestates, runtime, files };
}

function message(): MessageWriter { return new MessageWriter("oob"); }

test("broken download acknowledgement waits for the reached drop without advancing the window", async () => {
  const f = await fixture("baseq3", 20), events: string[] = [];
  const runtime = new ServerDownloadRuntime(f.state, { ...f.runtime.host,
    *dropClient(client, reason): CallSteps {
      events.push(reason);
      yield async () => { expect(client.download.clientBlock).toBe(0); };
      events.push("completed");
    } });
  runtimes.push(runtime);
  runtime.begin(f.client, ["download", "custom/map.pk3"]);
  const completion = runCalls(runtime.next(f.client, ["nextdl", "9"]));
  expect(events).toEqual(["broken download"]);
  await completion;
  expect(events).toEqual(["broken download", "completed"]);
  expect(f.client.download.clientBlock).toBe(0);
});

function ownDownloadDescriptors(root: string): number[] {
  return readdirSync("/proc/self/fd").flatMap(entry => {
    try { return readlinkSync(`/proc/self/fd/${entry}`).startsWith(`${root}/`) ? [Number(entry)] : []; }
    catch { return []; }
  }).sort((a, b) => a - b);
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  const outcomes: readonly ({ kind: "released" } | { kind: "failed"; value: unknown })[] = [
    { kind: "released" }, { kind: "failed", value: new CommonError("drop", "late acquired file release") },
    { kind: "failed", value: null }, { kind: "failed", value: undefined },
    { kind: "failed", value: new ServerDownloadError("io", "custom/map.pk3", "late release IO failure", null) },
  ];
  for (const outcome of outcomes) {
    test(`${product}: late download handoff releases unpublished real file: ${outcome.kind === "released" ? "success" : String(outcome.value)}`, async () => {
      const f = await fixture(product, 20), rawCloses: (() => void)[] = [], replacements: number[] = [];
      let closes = 0;
      const RetiringFiles = (name: string) => {
          const file = f.files.server.openDownload(name);
          if (file === null) throw new Error("Expected real provider acquisition");
          const descriptor = ownDownloadDescriptors(f.root)[0];
          if (descriptor === undefined) throw new Error("Expected actual acquired descriptor");
          const close = file.close.bind(file); rawCloses.push(close);
          file.close = () => {
            closes++; close();
            expect(f.client.download.file).toBeNull();
            runtime.disposeResources();
            if (outcome.kind === "failed") {
              const replacement = openSync(join(f.root, "custom", "map.pk3"), "r"); replacements.push(replacement);
              expect(replacement).toBe(descriptor);
              throw outcome.value;
            }
          };
          runtime.disposeResources();
          return file;
        };
      const runtime: ServerDownloadRuntime = new ServerDownloadRuntime(f.state, { ...f.runtime.host, files: { openDownload: RetiringFiles } });
      runtimes.push(runtime); runtime.begin(f.client, ["download", "custom/map.pk3"]);
      const download = f.client.download;
      download.size = 777; download.count = 113; download.currentBlock = 11; download.clientBlock = 13;
      download.xmitBlock = 5; download.sendTime = 79; download.eof = true;
      const window = { size: download.size, count: download.count, currentBlock: download.currentBlock,
        clientBlock: download.clientBlock, xmitBlock: download.xmitBlock, sendTime: download.sendTime, eof: download.eof };
      const writer = message(); writer.writeByte(0x55); const bytes = writer.toBytes();
      let result: { kind: "returned" } | { kind: "thrown"; value: unknown } = { kind: "returned" };
      try {
        try { runtime.writeToClient(f.client, writer); } catch (value) { result = { kind: "thrown", value }; }
        expect(result.kind).toBe("thrown");
        if (result.kind !== "thrown") throw new Error("Terminal provider handoff continued source work");
        if (outcome.kind === "released") {
          expect(result.value).toBeInstanceOf(Error);
          if (!(result.value instanceof Error)) throw new Error("Missing terminal ownership failure");
          expect(result.value.message).toContain("disposed");
        } else {
          expect(result.value).toBeInstanceOf(AggregateError);
          if (!(result.value instanceof AggregateError)) throw new Error("Missing ownership/release aggregate");
          const errors: unknown = result.value.errors;
          if (!Array.isArray(errors)) throw new Error("Aggregate members must be an array");
          expect(errors.length).toBe(2);
          const release: unknown = errors[1]; expect(release).toBe(outcome.value);
          const ownership: unknown = errors[0];
          expect(ownership).toBeInstanceOf(Error);
          if (!(ownership instanceof Error)) throw new Error("Missing primary ownership failure");
          expect(ownership.message).toContain("disposed");
        }
        expect(closes).toBe(1); expect(download.file).toBeNull(); expect(download.name).toBe("");
        expect(download.blocks.every(block => block === null)).toBe(true);
        expect({ size: download.size, count: download.count, currentBlock: download.currentBlock,
          clientBlock: download.clientBlock, xmitBlock: download.xmitBlock, sendTime: download.sendTime, eof: download.eof }).toEqual(window);
        expect(writer.toBytes()).toEqual(bytes);
        expect(f.logs).toEqual(['clientDownload: 0 : begining "custom/map.pk3"\n']);
        expect(f.drops).toEqual([]); expect(f.gamestates).toEqual([]);
        runtime.disposeResources(); expect(closes).toBe(1);
        expect(ownDownloadDescriptors(f.root)).toEqual(replacements);
        for (const descriptor of replacements) expect(fstatSync(descriptor).isFile()).toBe(true);
      } finally {
        for (const close of rawCloses) close();
        for (const descriptor of replacements) closeSync(descriptor);
        download.file = null;
      }
    });
  }

  test(`${product}: late download handoff stops immediately after print retires ownership`, async () => {
    const f = await fixture(product, 0);
    let opens = 0;
    const ObservedFiles = (name: string) => { opens++; return f.files.server.openDownload(name); };
    const runtime: ServerDownloadRuntime = new ServerDownloadRuntime(f.state, { ...f.runtime.host, files: { openDownload: ObservedFiles },
      print: text => { f.logs.push(text); runtime.disposeResources(); } });
    runtimes.push(runtime); runtime.begin(f.client, ["download", "custom/map.pk3"]);
    const writer = message();
    expect(() => runtime.writeToClient(f.client, writer)).toThrow("disposed");
    expect(opens).toBe(0); expect(writer.byteLength).toBe(0); expect(f.logs).toHaveLength(1);
    expect(f.client.download.file).toBeNull(); expect(ownDownloadDescriptors(f.root)).toEqual([]);
  });

  test(`${product}: late download handoff rejects a retired provider's null result without packet recovery`, async () => {
    const f = await fixture(product, 0);
    const RetiringMissingFiles = (name: string) => {
        const file = f.files.server.openDownload(name); expect(file).toBeNull(); runtime.disposeResources(); return file;
      };
    const runtime: ServerDownloadRuntime = new ServerDownloadRuntime(f.state, { ...f.runtime.host, files: { openDownload: RetiringMissingFiles } });
    runtimes.push(runtime); runtime.begin(f.client, ["download", "custom/missing.pk3"]);
    const writer = message();
    expect(() => runtime.writeToClient(f.client, writer)).toThrow("disposed");
    expect(writer.byteLength).toBe(0); expect(f.logs).toEqual(['clientDownload: 0 : begining "custom/missing.pk3"\n']);
    expect(f.client.download.file).toBeNull(); expect(ownDownloadDescriptors(f.root)).toEqual([]);
  });

  test(`${product}: late download handoff preserves source-active provider CommonError identity`, async () => {
    const f = await fixture(product, 0), failure = new CommonError("drop", "source-active provider");
    const FailingFiles = (_name: string): never => { throw failure; };
    const runtime = new ServerDownloadRuntime(f.state, { ...f.runtime.host, files: { openDownload: FailingFiles } });
    runtimes.push(runtime); runtime.begin(f.client, ["download", "custom/map.pk3"]);
    const writer = message(); let observed: unknown;
    try { runtime.writeToClient(f.client, writer); } catch (error) { observed = error; }
    expect(observed).toBe(failure); expect(writer.byteLength).toBe(0); expect(f.logs).toHaveLength(1);
    expect(f.client.download.name).toBe("custom/map.pk3"); runtime.disposeResources();
  });
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  for (const edge of ["done", "next", "next-eof-debug", "next-eof-print", "stop", "stock", "disabled", "missing", "source-error-print", "block-debug"]) {
    test(`${product}: late download callback continuation stops at ${edge}`, async () => {
      const f = await fixture(product, 20), writer = message(), calls: string[] = [];
      const observed: { clientBlock: number; xmitBlock: number; sendTime: number; bytes: Uint8Array }[] = [];
      const retire = (): void => {
        runtime.disposeResources();
        observed.push({ clientBlock: f.client.download.clientBlock, xmitBlock: f.client.download.xmitBlock,
          sendTime: f.client.download.sendTime, bytes: writer.toBytes() });
        calls.push("disposed");
      };
      const runtime: ServerDownloadRuntime = new ServerDownloadRuntime(f.state, { ...f.runtime.host,
        debugPrint(text) {
          calls.push(text);
          if (["done", "next", "next-eof-debug", "stop", "block-debug"].includes(edge)) retire();
        },
        print(text) {
          calls.push(text);
          if ((edge === "next-eof-print" && text.includes("completed"))
            || (edge === "stock" && text.includes("cannot download"))
            || (edge === "disabled" && text.includes("download disabled"))
            || (edge === "missing" && text.includes("file not found"))
            || (edge === "source-error-print" && text.includes("rejected:"))) retire();
        },
        sendClientGameState: () => { calls.push("gamestate"); },
      });
      runtimes.push(runtime);
      runtime.begin(f.client, ["download", edge === "stock" ? `${product}/pak0.pk3`
        : edge === "missing" ? "custom/missing.pk3" : edge === "source-error-print" ? "../outside.pk3" : "custom/map.pk3"]);
      if (edge === "disabled") f.cvars.set("sv_allowDownload", "0");
      f.state.time = 100; f.client.download.sendTime = 37;
      f.client.download.blockSizes[0] = edge.startsWith("next-eof") ? 0 : 20;
      const execute = (): void => {
        if (edge === "done") runtime.done(f.client);
        else if (edge.startsWith("next")) finishCalls(runtime.next(f.client, ["nextdl", "0"]));
        else if (edge === "stop") runtime.stop(f.client);
        else runtime.writeToClient(f.client, writer);
      };
      try {
        expect(execute).toThrow("disposed");
        const boundary = observed[0];
        if (boundary === undefined) throw new Error("Declared callback did not retire the runtime");
        expect(observed).toHaveLength(1); expect(calls.at(-1)).toBe("disposed"); expect(calls).not.toContain("gamestate");
        expect(f.client.download.clientBlock).toBe(boundary.clientBlock);
        expect(f.client.download.xmitBlock).toBe(boundary.xmitBlock); expect(f.client.download.sendTime).toBe(boundary.sendTime);
        expect(writer.toBytes()).toEqual(boundary.bytes); expect(f.client.download.file).toBeNull();
        expect(f.client.download.name).toBe(""); expect(f.client.download.blocks.every(block => block === null)).toBe(true);
        expect(ownDownloadDescriptors(f.root)).toEqual([]); runtime.disposeResources();
      } finally { runtime.disposeResources(); }
    });
  }

  for (const edge of ["begin-close", "source-error-close"]) {
    test(`${product}: late download callback continuation cannot resume after ${edge}`, async () => {
      const f = await fixture(product, 20), calls: string[] = [], rawCloses: (() => void)[] = [];
      let armed = false;
      const ClosingFiles = (name: string) => {
          const file = f.files.server.openDownload(name);
          if (file === null) return null;
          const close = file.close.bind(file); rawCloses.push(close);
          file.close = () => {
            close();
            if (armed) { armed = false; runtime.disposeResources(); calls.push("disposed"); }
          };
          return file;
        };
      const runtime: ServerDownloadRuntime = new ServerDownloadRuntime(f.state, { ...f.runtime.host, files: { openDownload: ClosingFiles },
        print: text => { calls.push(text); }, debugPrint: text => { calls.push(text); } });
      runtimes.push(runtime); runtime.begin(f.client, ["download", "custom/map.pk3"]);
      runtime.writeToClient(f.client, message());
      calls.length = 0; armed = true;
      const writer = message();
      try {
        if (edge === "begin-close") expect(() => runtime.begin(f.client, ["download", "custom/new.pk3"])).toThrow("disposed");
        else {
          // The real reader detects an actual size change before source error recovery closes it.
          await writeFile(join(f.root, "custom", "map.pk3"), "changed");
          f.client.download.count = 0; f.client.download.currentBlock = 0; f.client.download.eof = false;
          expect(() => runtime.writeToClient(f.client, writer)).toThrow("disposed");
        }
        expect(calls).toEqual(["disposed"]); expect(writer.byteLength).toBe(0);
        expect(f.client.download.name).toBe(""); expect(f.client.download.file).toBeNull();
        expect(ownDownloadDescriptors(f.root)).toEqual([]); runtime.disposeResources();
      } finally {
        armed = false; for (const close of rawCloses) close(); f.client.download.file = null;
      }
    });
  }

  test(`${product}: late download provider failure after disposal bypasses source error translation`, async () => {
    const f = await fixture(product, 0), failure = new ServerDownloadError("io", "missing", "provider terminal error", undefined);
    const RetiringFiles = (name: string): never => {
        expect(f.files.server.openDownload(name)).toBeNull(); runtime.disposeResources(); throw failure;
      };
    const runtime: ServerDownloadRuntime = new ServerDownloadRuntime(f.state, { ...f.runtime.host, files: { openDownload: RetiringFiles } });
    runtimes.push(runtime); runtime.begin(f.client, ["download", "custom/missing.pk3"]);
    const writer = message(); let observed: unknown;
    try { runtime.writeToClient(f.client, writer); } catch (error) { observed = error; }
    expect(observed).toBe(failure); expect(f.logs).toHaveLength(1); expect(writer.byteLength).toBe(0);
    expect(f.client.download.file).toBeNull(); expect(ownDownloadDescriptors(f.root)).toEqual([]);
  });

  for (const failure of [new CommonError("drop", "source-active debug"), null, undefined]) {
    test(`${product}: late download continuation guards preserve active callback failure ${String(failure)}`, async () => {
      const f = await fixture(product, 0), calls: string[] = [];
      const runtime = new ServerDownloadRuntime(f.state, { ...f.runtime.host,
        debugPrint: () => { calls.push("debug"); throw failure; }, sendClientGameState: () => { calls.push("gamestate"); } });
      runtimes.push(runtime); let outcome: { kind: "returned" } | { kind: "thrown"; value: unknown } = { kind: "returned" };
      try { runtime.done(f.client); } catch (value) { outcome = { kind: "thrown", value }; }
      expect(outcome.kind).toBe("thrown"); if (outcome.kind === "thrown") expect(outcome.value).toBe(failure);
      expect(calls).toEqual(["debug"]); runtime.disposeResources();
    });
  }
}

for (const failure of [new CommonError("drop", "download disposal"), null, undefined]) {
  test(`resource-only download disposal consumes all files before throwing callbacks: ${String(failure)}`, async () => {
    const f = await fixture("baseq3", 5000), calls: number[] = [];
    const reopened: number[] = [], rawCloses: (() => void)[] = [];
    for (const client of f.state.clients) {
      f.runtime.begin(client, ["download", "custom/map.pk3"]); f.runtime.writeToClient(client, message());
      const file = client.download.file;
      if (file === null) throw new Error("Expected actual open download");
      const close = file.close.bind(file);
      rawCloses.push(close);
      const descriptor = readdirSync("/proc/self/fd").flatMap(entry => {
        try { return readlinkSync(`/proc/self/fd/${entry}`) === join(f.root, "custom", "map.pk3") ? [Number(entry)] : []; }
        catch { return []; }
      }).sort((a, b) => a - b).at(-1);
      if (descriptor === undefined) throw new Error("Expected owned download descriptor");
      file.close = () => {
        calls.push(client.slot);
        for (const owned of f.state.clients) {
          expect(owned.download.file).toBeNull(); expect(owned.download.name).toBe("");
          expect(owned.download.blocks.every(block => block === null)).toBe(true);
        }
        close(); f.runtime.disposeResources();
        expect(() => f.runtime.begin(client, ["download", "custom/map.pk3"])).toThrow("disposed");
        expect(() => f.runtime.writeToClient(client, message())).toThrow("disposed");
        if (client.slot === 0) {
          const replacement = openSync(join(f.root, "custom", "map.pk3"), "r"); reopened.push(replacement);
          expect(replacement).toBe(descriptor); throw failure;
        }
      };
    }
    const before = [...f.logs];
    let result: { kind: "returned" } | { kind: "thrown"; value: unknown } = { kind: "returned" };
    try {
      try { f.runtime.disposeResources(); } catch (value) { result = { kind: "thrown", value }; }
      expect(result.kind).toBe("thrown"); if (result.kind === "thrown") expect(result.value).toBe(failure);
      expect(calls).toEqual([0, 1]); expect(f.logs).toEqual(before); expect(f.drops).toEqual([]); expect(f.gamestates).toEqual([]);
      f.runtime.disposeResources(); expect(calls).toEqual([0, 1]);
      for (const operation of [
        () => f.runtime.begin(f.client, ["download", "custom/map.pk3"]),
        () => f.runtime.writeToClient(f.client, message()), () => f.runtime.close(f.client),
        () => finishCalls(f.runtime.next(f.client, ["nextdl", "0"])), () => f.runtime.stop(f.client), () => f.runtime.done(f.client),
      ]) expect(operation).toThrow("disposed");
      for (const descriptor of reopened) expect(fstatSync(descriptor).isFile()).toBe(true);
      const owned = readdirSync("/proc/self/fd").flatMap(entry => {
        try { const path = readlinkSync(`/proc/self/fd/${entry}`); return path.startsWith(`${f.root}/`) ? [Number(entry)] : []; }
        catch { return []; }
      });
      expect(owned.sort((a, b) => a - b)).toEqual([...reopened].sort((a, b) => a - b));
    } finally {
      for (const close of rawCloses) close();
      for (const descriptor of reopened) closeSync(descriptor);
      for (const client of f.state.clients) client.download.file = null;
    }
  });
}

test("resource-only download disposal retains multiple thrown values in release order", async () => {
  const f = await fixture("missionpack", 10), values: readonly unknown[] = [null, undefined], calls: number[] = [];
  const rawCloses: (() => void)[] = [];
  for (const client of f.state.clients) {
    f.runtime.begin(client, ["download", "custom/map.pk3"]); f.runtime.writeToClient(client, message());
    const file = client.download.file;
    if (file === null) throw new Error("Expected actual file");
    const close = file.close.bind(file); rawCloses.push(close);
    file.close = () => { calls.push(client.slot); close(); throw values[client.slot]; };
  }
  try {
    let observed: unknown;
    try { f.runtime.disposeResources(); } catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(AggregateError);
    if (!(observed instanceof AggregateError)) throw new Error("Expected managed aggregate");
    const errors: unknown = observed.errors;
    expect(errors).toEqual(values); expect(calls).toEqual([0, 1]);
    f.runtime.disposeResources(); expect(calls).toEqual([0, 1]);
  } finally {
    for (const close of rawCloses) close();
    for (const client of f.state.clients) client.download.file = null;
  }
});

function block(reader: MessageReader, number: number, size: number, data: Uint8Array): void {
  expect(reader.readByte()).toBe(ServerOpcode.Download);
  expect(reader.readShort()).toBe(number);
  if (number === 0) expect(reader.readLong()).toBe(size);
  expect(reader.readShort()).toBe(data.length);
  expect(reader.readData(data.length)).toEqual(data);
}

for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
  test(`${product}: streams an eight-block window, refills only after acknowledgement, and closes at EOF acknowledgement`, async () => {
    const f = await fixture(product, 2048 * 9 + 3);
    f.runtime.begin(f.client, ["download", "custom/map.pk3"]);
    expect(f.client.download.file).toBeNull();
    for (let index = 0; index < 11; index++) {
      const writer = message(); f.state.time = 100 + index * 50;
      f.runtime.writeToClient(f.client, writer);
      const expected = f.bytes.slice(index * 2048, (index + 1) * 2048);
      block(new MessageReader(writer.toBytes(), "oob"), index, f.bytes.length, expected);
      if (index === 0) {
        expect(f.client.download.currentBlock).toBe(8);
        expect(f.client.download.count).toBe(2048 * 8);
        expect(f.client.download.eof).toBe(false);
      }
      finishCalls(f.runtime.next(f.client, ["nextdl", String(index)]));
    }
    expect(f.client.download.file).toBeNull(); expect(f.client.download.name).toBe("");
    expect(f.client.download.blocks).toEqual([null, null, null, null, null, null, null, null]);
    expect(f.client.download.clientBlock).toBe(10);
    expect(f.client.download.currentBlock).toBe(11);
    expect(f.drops).toEqual([]);
    f.runtime.done(f.client); expect(f.gamestates).toEqual([0]);
  });
}

test("retransmission requires strictly more than one second and restarts at the oldest unacknowledged block", async () => {
  const f = await fixture("baseq3", 1);
  f.runtime.begin(f.client, ["download", "custom/map.pk3"]);
  f.state.time = 10; const start = message(); f.runtime.writeToClient(f.client, start);
  f.state.time = 20; const eof = message(); f.runtime.writeToClient(f.client, eof);
  f.state.time = 1020; const notYet = message(); f.runtime.writeToClient(f.client, notYet);
  expect(notYet.byteLength).toBe(0);
  f.state.time = 1021; const resent = message(); f.runtime.writeToClient(f.client, resent);
  expect(resent.toBytes()).toEqual(start.toBytes());
  expect(f.client.download.xmitBlock).toBe(1); expect(f.client.download.sendTime).toBe(1021);
  finishCalls(f.runtime.next(f.client, ["nextdl", "0"]));
  f.state.time = 1030; const last = message(); f.runtime.writeToClient(f.client, last);
  expect(last.toBytes()).toEqual(eof.toBytes());
});

test("block acknowledgements preserve native source atoi and drop on unexpected block", async () => {
  const f = await fixture("baseq3", 4096);
  f.runtime.begin(f.client, ["download", "custom/map.pk3"]); f.runtime.writeToClient(f.client, message());
  finishCalls(f.runtime.next(f.client, ["nextdl", "  +0ignored"]));
  expect(f.client.download.clientBlock).toBe(1);
  finishCalls(f.runtime.next(f.client, ["nextdl", "0"]));
  expect(f.drops).toEqual(["0:broken download"]); expect(f.client.download.clientBlock).toBe(1);
});

test("overflowing acknowledgement text saturates like i386 libc instead of wrapping like QVM atoi", async () => {
  const f = await fixture("baseq3", 4096);
  f.runtime.begin(f.client, ["download", "custom/map.pk3"]); f.runtime.writeToClient(f.client, message());
  f.client.download.clientBlock = 2147483647;
  f.client.download.blockSizes[7] = 0;
  finishCalls(f.runtime.next(f.client, ["nextdl", "999999999999999999999999999999999999999"]));
  expect(f.drops).toEqual([]);
  expect(f.client.download.name).toBe("");
  expect(f.client.download.file).toBeNull();
});

test("rate and snapshot interval select block count and force a low nonzero maximum rate to 1000", async () => {
  const f = await fixture("baseq3", 5000);
  f.client.rate = 40000; f.client.snapshotMsec = 100;
  f.runtime.begin(f.client, ["download", "custom/map.pk3"]);
  const writer = message(); f.runtime.writeToClient(f.client, writer);
  const reader = new MessageReader(writer.toBytes(), "oob");
  block(reader, 0, f.bytes.length, f.bytes.slice(0, 2048));
  block(reader, 1, f.bytes.length, f.bytes.slice(2048, 4096));
  expect(f.client.download.xmitBlock).toBe(2);
  f.runtime.begin(f.client, ["download", "custom/map.pk3"]); f.cvars.set("sv_maxRate", "1", true);
  f.runtime.writeToClient(f.client, message());
  expect(f.cvars.get("sv_maxRate")?.integerValue).toBe(1000);
  expect(f.client.download.xmitBlock).toBe(1);
});

test("stock content denial includes extensionless source names and hardened .pk3 wire names", async () => {
  const f = await fixture("baseq3", 1);
  for (const name of ["baseq3/pak0", "BASEQ3\\PAK8.PK3", "missionpack/pak0.pk3"]) {
    f.runtime.begin(f.client, ["download", name]); const writer = message();
    f.runtime.writeToClient(f.client, writer);
    const reader = new MessageReader(writer.toBytes(), "oob");
    expect(reader.readByte()).toBe(ServerOpcode.Download); expect(reader.readShort()).toBe(0); expect(reader.readLong()).toBe(-1);
    expect(reader.readString()).toContain(name.startsWith("missionpack") ? "Cannot autodownload Team Arena" : "Cannot autodownload id pk3");
    expect(f.client.download.name).toBe(""); expect(f.client.download.file).toBeNull();
  }
});

test("disabled, missing and empty files emit source download errors without payload blocks", async () => {
  const f = await fixture("missionpack", 0);
  for (const pure of [0, 1]) {
    f.cvars.set("sv_allowDownload", "0", true); f.cvars.set("sv_pure", String(pure), true);
    f.runtime.begin(f.client, ["download", "custom/map.pk3"]); const writer = message(); f.runtime.writeToClient(f.client, writer);
    const reader = new MessageReader(writer.toBytes(), "oob");
    expect(reader.readByte()).toBe(ServerOpcode.Download); expect(reader.readShort()).toBe(0); expect(reader.readLong()).toBe(-1);
    expect(reader.readString()).toContain(pure === 1 ? "connect to this pure server" : "not a pure server");
  }
  f.cvars.set("sv_allowDownload", "1", true);
  for (const name of ["custom/missing.pk3", "custom/map.pk3"]) {
    f.runtime.begin(f.client, ["download", name]); const writer = message(); f.runtime.writeToClient(f.client, writer);
    const reader = new MessageReader(writer.toBytes(), "oob");
    expect(reader.readByte()).toBe(ServerOpcode.Download); expect(reader.readShort()).toBe(0); expect(reader.readLong()).toBe(-1);
    expect(reader.readString()).toBe(`File "${name}" not found on server for autodownloading.\n`);
    expect(f.client.download.name).toBe("");
  }
});

test("begin closes old resource, copies source MAX_QPATH bytes and stop preserves scalar bookkeeping", async () => {
  const f = await fixture("baseq3", 4);
  f.runtime.begin(f.client, ["download", "custom/map.pk3"]); f.runtime.writeToClient(f.client, message());
  const old = f.client.download.file;
  if (old === null) throw new Error("Expected opened download");
  f.runtime.begin(f.client, ["download", "x".repeat(70) + "\0ignored"]);
  expect(() => old.read(new Uint8Array(1))).toThrow("closed");
  expect(f.client.download.name).toBe("x".repeat(63));
  expect(f.client.download.count).toBe(4);
  f.runtime.stop(f.client);
  expect(f.client.download.name).toBe(""); expect(f.client.download.count).toBe(4);
  const other = new ServerStaticState({ product: "baseq3", maxClients: 1, dedicated: false }).clients[0];
  if (other === undefined) throw new Error("Missing foreign client");
  expect(() => f.runtime.writeToClient(other, message())).toThrow("does not belong");
});

test("invalid raw paths report a download error without ending the server session", async () => {
  const f = await fixture("baseq3", 1);
  f.runtime.begin(f.client, ["download", "../outside.pk3"]);
  const writer = message();
  expect(() => f.runtime.writeToClient(f.client, writer)).not.toThrow();
  const reader = new MessageReader(writer.toBytes(), "oob");
  expect(reader.readByte()).toBe(ServerOpcode.Download);
  expect(reader.readShort()).toBe(0);
  expect(reader.readLong()).toBe(-1);
  expect(reader.readString()).toBe('File "../outside.pk3" could not be read safely for autodownloading.\n');
  expect(f.client.download.file).toBeNull();
  expect(f.client.download.name).toBe("");
  expect(f.drops).toEqual([]);
  f.runtime.begin(f.client, ["download", "custom/map.pk3"]);
  const retry = message(); f.runtime.writeToClient(f.client, retry);
  block(new MessageReader(retry.toBytes(), "oob"), 0, 1, f.bytes);
});

test("a changed open file closes its window and emits an error instead of leaking a filesystem exception", async () => {
  const f = await fixture("missionpack", 2048 * 9);
  f.runtime.begin(f.client, ["download", "custom/map.pk3"]);
  f.runtime.writeToClient(f.client, message());
  const file = f.client.download.file;
  if (file === null) throw new Error("Expected opened fixture download");
  finishCalls(f.runtime.next(f.client, ["nextdl", "0"]));
  await writeFile(join(f.root, "custom", "map.pk3"), new Uint8Array(1));
  const writer = message();
  expect(() => f.runtime.writeToClient(f.client, writer)).not.toThrow();
  const reader = new MessageReader(writer.toBytes(), "oob");
  expect(reader.readByte()).toBe(ServerOpcode.Download);
  expect(reader.readShort()).toBe(0);
  expect(reader.readLong()).toBe(-1);
  expect(reader.readString()).toContain("could not be read safely");
  expect(f.client.download.name).toBe("");
  expect(f.client.download.file).toBeNull();
  expect(f.client.download.blocks).toEqual([null, null, null, null, null, null, null, null]);
  expect(() => file.read(new Uint8Array(1))).toThrow("closed");
  expect(f.drops).toEqual([]);
});
const fileOwners: CommonFileState[] = [];
  for (const files of fileOwners.splice(0)) files.close();
