import { HunkArena } from "../src/core/hunk.ts";
import { describe, expect, test } from "bun:test";
import type { AssetReader } from "../src/assets/reader.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { BinaryWriter } from "../src/core/binary.ts";
import { CinematicStatus, EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { qvmCinematicSyscall, type QvmCinematicServices } from "../src/vm/cinematic-syscalls.ts";
import { QvmMemory } from "../src/vm/memory.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

function chunk(id: number, bytes: readonly number[], flags = 0): Uint8Array {
  const writer = new BinaryWriter(bytes.length + 8);
  writer.u16(id); writer.u32(bytes.length); writer.u16(flags); writer.bytes(Uint8Array.from(bytes));
  return writer.finish();
}

function movie(): Uint8Array {
  const chunks = [chunk(0x1001, [16, 0, 16, 0, 8, 0, 4, 0]), chunk(0x1020, [1, 2], 1000),
    chunk(0x1002, [255, 255, 255, 255, 128, 128, 0, 0, 0, 0], 0x0101),
    chunk(0x1011, [0, 170, 0, 0, 0, 0]), chunk(0x1011, [0, 170, 0, 0, 0, 0]), chunk(0x1013, [])];
  const writer = new BinaryWriter(8 + chunks.reduce((sum, bytes) => sum + bytes.length, 0));
  writer.u16(0x1084); writer.u32(0xffffffff); writer.u16(30);
  for (const bytes of chunks) writer.bytes(bytes);
  return writer.finish();
}

function words(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  for (const [index, value] of values.entries()) view.setInt32(index * 4, value, true);
  return view;
}

function fixture(customFiles?: AssetReader) {
  const images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const cpu = new SoftwareRenderer(64, 48, images), target = new RenderTarget(images, [cpu]);
  const mixer = new AudioMixer(22050, () => 0), events: string[] = [], reads: string[] = [];
  const clock = { time: 0, sample(): number { return this.time; } };
  const files: AssetReader = customFiles ?? { has: path => path !== "video/missing", list: () => [],
    read: async path => { reads.push(path); return path === "video/bad" ? new Uint8Array(8) : movie(); } };
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files },
    sound: { kind: "diagnostic", readMixer: () => mixer }, clock, scratchImages: builtins,
    console: { kind: "available", close: () => { events.push("console"); } },
    settings: { hardware: "generic", maxTextureSize: 4096, inGameVideo: () => 1 } });
  const commands = new RenderCommandBuffer(target, { print: text => { throw new Error(text); },
    clock: { milliseconds: () => 0 }, identityLight: 1, tess: new SourceTessState(), runtime: createRendererSettings().runtime });
  const draw = commands.draw2D("base-ui-640"), memory = new QvmMemory(new Uint8Array(256));
  const services: QvmCinematicServices = { cinematics, draw, developerPrint: text => { events.push(text); } };
  const call = (role: "game" | "cgame" | "ui", ...args: number[]) => qvmCinematicSyscall(role, words(...args), memory, services);
  const play = (role: "cgame" | "ui", name = "tiny", bits = 0) => {
    memory.writeString(32, name, 64);
    return call(role, role === "ui" ? 75 : 74, 32, 0, 0, 640, 480, bits);
  };
  const close = () => { cinematics.dispose(); commands.close("discard"); target.close(); };
  return { cinematics, cpu, commands, mixer, events, reads, clock, memory, services, call, play, close };
}

describe("QVM cinematic traps over actual cinematic and CPU renderer owners", () => {
  for (const role of ["ui", "cgame"] satisfies readonly ("ui" | "cgame")[]) {
    const base = role === "ui" ? 75 : 74;
    test(`${role} exact IDs, signed missing handles, initial selected idle and missing files`, async () => {
      const f = fixture();
      try {
        expect(f.call("game", base)).toBeNull();
        expect(f.call(role, base - 1)).toBeNull(); expect(f.call(role, base + 5)).toBeNull();
        expect(f.call(role, base + 2, 0)).toBe(CinematicStatus.Idle);
        for (const index of [-2147483648, -1, 16, 2147483647]) {
          expect(f.call(role, base + 1, index)).toBe(2); expect(f.call(role, base + 2, index)).toBe(2);
          expect(f.call(role, base + 3, index)).toBe(0); expect(f.call(role, base + 4, index, 1, 2, 3, 4)).toBe(0);
        }
        expect(await f.play(role, "missing")).toBe(-1); expect(await f.play(role, "bad")).toBe(-1);
      } finally { f.close(); }
    });

    test(`${role} retained slot drawing consumes older commands and preserves source extents`, async () => {
      const f = fixture();
      try {
        expect(await f.play(role)).toBe(0);
        const handle = f.cinematics.handleAtSlot(0);
        if (handle === undefined) throw new Error("Missing permanent cinematic slot");
        let older = 0;
        f.commands.addPreparedViews(() => { older++; return []; });
        expect(f.call(role, base + 3, 0)).toBe(0); expect(older).toBe(0);
        expect(f.call(role, base + 2, 0)).toBe(1);
        f.clock.time = 34; expect(f.call(role, base + 2, 0)).toBe(1);
        expect(f.call(role, base + 4, 0, 100, 100, 200, 200)).toBe(0);
        expect(f.call(role, base + 3, 0)).toBe(0); expect(older).toBe(1);
        const pixel = (x: number, y: number) => f.cpu.pixels[(y * 64 + x) * 4];
        expect(pixel(9, 10)).toBe(0); expect(pixel(10, 10)).toBe(255);
        expect(pixel(29, 29)).toBe(255); expect(pixel(30, 30)).toBe(0);
        expect(f.cinematics.prepareUiRaw(handle)?.dirty).toBe(false);
        expect(f.commands.submit()).toEqual({ commands: 0, views: 0, batches: 0 });
        expect(f.call(role, base + 1, 0)).toBe(2);
        expect(await f.play(role, "replacement")).toBe(0);
        expect(f.cinematics.handleAtSlot(0)).toBe(handle);
      } finally { f.close(); }
    });
  }

  test("both roles share names and first flags, all sixteen slots come from the engine", async () => {
    const f = fixture();
    try {
      expect(await f.play("ui", "shared", 8)).toBe(0);
      expect(await f.play("cgame", "shared", 0)).toBe(0);
      f.call("cgame", 76, 0); f.clock.time = 34; f.call("cgame", 76, 0);
      expect(f.mixer.rawEnd).toBe(0);
      for (let index = 1; index < 16; index++) expect(await f.play("cgame", `movie-${index}`)).toBe(index);
      await expect(f.play("ui", "overflow")).rejects.toThrow("none free");
    } finally { f.close(); }
  });

  test("play snapshots source byte strings and scalar words before diagnostic reentry", async () => {
    const f = fixture();
    try {
      f.memory.writeString(32, "\u00e9.roq", 64);
      const input = words(75, 32, 100, 100, 200, 200, 8);
      const services: QvmCinematicServices = { ...f.services, developerPrint: () => {
        for (let offset = 4; offset < input.byteLength; offset += 4) input.setInt32(offset, 0, true);
        f.memory.writeString(32, "changed", 64);
      } };
      expect(await qvmCinematicSyscall("ui", input, f.memory, services)).toBe(0);
      expect(f.reads).toEqual(["video/\u00e9.roq"]);
      f.call("ui", 77, 0); f.clock.time = 34; f.call("ui", 77, 0); f.call("ui", 78, 0);
      expect(f.mixer.rawEnd).toBe(0);
      expect(f.cpu.pixels[(10 * 64 + 10) * 4]).toBe(255);
      expect(f.cpu.pixels[0]).toBe(0);
    } finally { f.close(); }
  });

  test("required strings and scalar words reject malformed memory before owner effects", () => {
    const f = fixture();
    try {
      expect(() => f.call("ui", 75, 0, 0, 0, 640, 480, 0)).toThrow("nonnull");
      f.memory.bytes.fill(65, 250);
      expect(() => f.call("cgame", 74, 250, 0, 0, 640, 480, 0)).toThrow("terminator");
      expect(() => f.call("ui", 75, 32, 0)).toThrow();
      expect(f.events).toEqual([]); expect(f.reads).toEqual([]);
    } finally { f.close(); }
  });

  test("pending asset reads cannot publish a handle after owner disposal", async () => {
    const pending = Promise.withResolvers<Uint8Array>();
    const f = fixture({ has: () => true, list: () => [], read: () => pending.promise });
    try {
      const result = f.play("cgame", "pending");
      f.cinematics.dispose(); pending.resolve(movie());
      await expect(result).rejects.toThrow("disposed");
      expect(f.events).toEqual([]);
    } finally { pending.resolve(movie()); f.close(); }
  });

  test("hold, loop, silent and shader bits reach actual playback", async () => {
    for (const bits of [0, 2, 4, 8, 16, 6, 0x40000000]) {
      const f = fixture();
      try {
        expect(await f.play("cgame", "flags", bits)).toBe(0);
        f.call("cgame", 76, 0); f.clock.time = 34; f.call("cgame", 76, 0);
        expect(f.mixer.rawEnd).toBe((bits & 8) === 0 ? 2 : 0);
        f.clock.time = 1000;
        const status = f.call("cgame", 76, 0);
        if ((bits & 16) !== 0) expect(status).toBe(1);
        else if ((bits & 4) !== 0 || (bits & 2) === 0) expect(status).toBe(0);
        else expect(status).toBe(1);
        if ((bits & 4) !== 0) expect(await f.play("ui", "flags")).toBe(0);
      } finally { f.close(); }
    }
  });

  test("system bit awaits the attached menu host and uses requested extents without command-wrapper sounds", async () => {
    const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let state: "cinematic" | "other" = "other", next = "map next";
    const system = f.cinematics.attachSystem({ state: () => state, closeMenu: async () => {
      f.events.push("menu"); entered.resolve(); await release.promise;
    }, enterCinematic: () => { state = "cinematic"; f.events.push("cinematic"); },
    enterDisconnected: () => { state = "other"; f.events.push("disconnected"); }, nextMap: () => next,
    clearNextMap: () => { next = ""; }, appendCommand: text => { f.events.push(text); },
    stopAllSounds: () => { throw new Error("Direct CIN trap called console wrapper sound stop"); } });
    try {
      f.memory.writeString(32, "system", 64);
      const pending = f.call("ui", 75, 32, 100, 100, 200, 200, 1 | 8);
      await entered.promise;
      expect(f.events).toEqual(["UI_CIN_PlayCinematic\n", "menu"]);
      const handle = f.cinematics.handleAtSlot(0);
      if (handle === undefined) throw new Error("Missing permanent cinematic slot");
      expect(f.cinematics.prepareUiRaw(handle)).toBeNull();
      release.resolve(); expect(await pending).toBe(0);
      expect(f.events).toEqual(["UI_CIN_PlayCinematic\n", "menu", "cinematic", "console"]);
      // The CIN trap does not publish the CL_PlayCinematic_f global handle.
      expect(system.run()).toBe(2);
      f.call("ui", 77, 0); f.clock.time = 34; f.call("ui", 77, 0); f.call("ui", 78, 0);
      expect(f.cpu.pixels[(10 * 64 + 10) * 4]).toBe(255); expect(f.cpu.pixels[0]).toBe(0);
      state = "other"; expect(f.call("ui", 76, 0)).toBe(1);
      state = "cinematic"; expect(f.call("ui", 76, 0)).toBe(2);
      expect(f.events.slice(-2)).toEqual(["disconnected", "map next\n"]); expect(next).toBe("");
    } finally { release.resolve(); f.close(); }
  });

  test("system playback without a client host rejects explicitly", async () => {
    const f = fixture();
    try { await expect(f.play("cgame", "system", 1)).rejects.toThrow("attached client host"); }
    finally { f.close(); }
  });

  test("uninitialized cross-slot reset publishes source EOF before explicit profile rejection", async () => {
    const f = fixture();
    try {
      const idle = f.cinematics.handleAtSlot(15);
      if (idle === undefined) throw new Error("Missing permanent cinematic slot");
      expect(() => f.cinematics.run(idle)).toThrow("unchecked retained RoQ header is unsupported");
      expect(f.cinematics.run(idle)).toBe(2);
      expect(f.call("ui", 77, 15)).toBe(2);
      expect(f.cinematics.handleAtSlot(15)).toBe(idle);
      expect(f.call("ui", 79, 15, 0, 0, 640, 480)).toBe(0);
      expect(await f.play("cgame", "new")).toBe(0);
      expect(f.call("cgame", 76, 0)).toBe(1);
    } finally { f.close(); }
  });
});
