// Actual frontend/backend thread lifecycle, from tr_cmds.c and cl_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ClientHost } from "../src/engine/client-host.ts";
import { RenderCommandBuffer } from "../src/render/commands.ts";
import { RendererConfiguration } from "../src/render/configuration.ts";
import { ThreadedBackend } from "../src/render/threaded-backend.ts";
import { CommonError } from "../src/core/common-error.ts";
import { ScreenshotCommand } from "../src/render/screenshot.ts";

const dataPath = process.env["Q3_DATA"];
const renderer = process.env["QUAKE_SMP_ENGINE_RENDERER"] === "gl" ? "gl" : "cpu";
const enabled = process.env["QUAKE_SMP_ENGINE_TEST"] === "1" && dataPath !== undefined
  && process.env["SDL_VIDEODRIVER"] === "x11" && process.env["WAYLAND_DISPLAY"] === undefined
  && process.env["SDL_AUDIODRIVER"] === "dummy";

test.skipIf(!enabled)(`actual ${renderer} SMP renders source frames, screenshots, and video restart`, async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA is required");
  const homePath = await mkdtemp(join(tmpdir(), "quake3-engine-smp-"));
  const output: string[] = [], frames: number[] = [], active: boolean[] = [];
  let issued = 0, closed = 0;
  const issue = ThreadedBackend.prototype.issue, close = ThreadedBackend.prototype.close;
  const submitFrame = RenderCommandBuffer.prototype.submitFrame, copy = RendererConfiguration.prototype.copy;
  const issueSpy = spyOn(ThreadedBackend.prototype, "issue").mockImplementation(function(this: ThreadedBackend, payload) {
    issued++; return issue.call(this, payload);
  });
  const closeSpy = spyOn(ThreadedBackend.prototype, "close").mockImplementation(function(this: ThreadedBackend) {
    closed++; return close.call(this);
  });
  const frameSpy = spyOn(RenderCommandBuffer.prototype, "submitFrame").mockImplementation(function(this: RenderCommandBuffer, present) {
    frames.push(this.tess.frontEndSmpFrame); return submitFrame.call(this, present);
  });
  const copySpy = spyOn(RendererConfiguration.prototype, "copy").mockImplementation(function(this: RendererConfiguration) {
    const result = copy.call(this); active.push(result.smpActive); return result;
  });
  let host: ClientHost | null = null;
  try {
    host = await ClientHost.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
      startupText: "+set net_ip 127.0.0.1 +set net_port 0 +set cl_motd 0 +set s_initsound 0 +set bot_enable 0 "
        + "+set ui_cdkeychecked 1 +set in_mouse 0 +set in_joystick 0 +set r_ignorehwgamma 1 +set r_fullscreen 0 "
        + "+set r_mode 0 +set com_maxfps 0 +set fixedtime 50 +set r_smp 1 +set r_finish 0 +set r_allowSoftwareGL 1 +map q3dm1",
      buildDate: "engine-smp", print: text => {
        output.push(text); if (process.env["QUAKE_SMP_TRACE"] === "1") process.stderr.write(text);
      }, bots: { kind: "unavailable", reason: "SMP lifecycle does not require bots" },
      video: { renderer, width: 320, height: 240, hidden: true }, sound: { sampleRate: 48000 },
      input: { stdin: new PassThrough(), signals: "none" } });
    const current = host;
    const frame = async (): Promise<void> => {
      expect((await current.frame()).kind).toBe("frame");
      await Bun.sleep(1);
    };
    for (let index = 0; index < 60 && current.client.clientStatic.phase !== "active"; index++) await frame();
    expect(current.client.clientStatic.phase).toBe("active");
    for (let index = 0; index < 4; index++) await frame();
    current.common.commands.append("screenshot smp-before\n"); await frame(); await frame();
    const pixels = await readFile(join(homePath, "baseq3/screenshots/smp-before.tga"));
    expect(pixels.length).toBe(18 + 320 * 240 * 3);
    expect(new Set(pixels.subarray(18)).size).toBeGreaterThan(16);
    expect(issued).toBeGreaterThan(2);
    expect(frames).toContain(0); expect(frames).toContain(1);
    expect(active).toContain(true);
    current.common.commands.append("vid_restart\n"); await frame(); await frame();
    expect(closed).toBeGreaterThan(0);
    expect(current.client.clientStatic.phase).toBe("active");
    current.common.commands.append("screenshot smp-after\n"); await frame(); await frame();
    expect((await readFile(join(homePath, "baseq3/screenshots/smp-after.tga"))).length).toBe(pixels.length);
    expect(output.join("")).toContain("Trying SMP acceleration...\n...succeeded.\n");
    const failedThread = spyOn(ThreadedBackend, "open").mockRejectedValue(new Error("Synthetic worker startup failure"));
    try {
      current.common.commands.append("vid_restart\n"); await frame(); await frame();
      expect(active.at(-1)).toBe(false);
      expect(current.client.clientStatic.phase).toBe("active");
      expect(output.join("")).toContain("Trying SMP acceleration...\n...failed.\n");
      const beforeFallbackFrames = issued;
      current.common.commands.append("screenshot smp-fallback\n"); await frame(); await frame();
      expect(issued).toBe(beforeFallbackFrames);
      expect((await readFile(join(homePath, "baseq3/screenshots/smp-fallback.tga"))).length).toBe(pixels.length);
    } finally { failedThread.mockRestore(); }
    await current.close(); host = null;
    expect(closed).toBeGreaterThan(1);
  } finally {
    try { await host?.close(); }
    finally { issueSpy.mockRestore(); closeSpy.mockRestore(); frameSpy.mockRestore(); copySpy.mockRestore(); }
  }
}, 180_000);

test.skipIf(!enabled)(`actual ${renderer} SMP retires a dropped host callback and starts a fresh renderer`, async () => {
  if (dataPath === undefined) throw new Error("Q3_DATA is required");
  const homePath = await mkdtemp(join(tmpdir(), "quake3-smp-recovery-"));
  const output: string[] = [];
  let host: ClientHost | null = null, callbacks = 0, armed = false;
  const execute = ScreenshotCommand.prototype.execute;
  const execution = spyOn(ScreenshotCommand.prototype, "execute").mockImplementation(function(this: ScreenshotCommand, parameters) {
    callbacks++;
    if (armed) {
      armed = false;
      if (host === null) throw new Error("Screenshot callback lost its client host");
      host.common.cvars.set("smp_callback_effect", "retained", true);
      throw new CommonError("drop", "SMP host callback recovery probe");
    }
    return execute.call(this, parameters);
  });
  try {
    host = await ClientHost.open({ roots: { dataPath, homePath, cdPath: null, product: "baseq3" },
      startupText: "+set net_ip 127.0.0.1 +set net_port 0 +set cl_motd 0 +set s_initsound 0 +set bot_enable 0 "
        + "+set ui_cdkeychecked 1 +set in_mouse 0 +set in_joystick 0 +set r_ignorehwgamma 1 +set r_fullscreen 0 "
        + "+set r_mode 0 +set com_maxfps 0 +set fixedtime 50 +set r_smp 1 +set r_finish 0 +set r_allowSoftwareGL 1 +map q3dm1",
      buildDate: "smp-recovery", print: text => {
        output.push(text); if (process.env["QUAKE_SMP_TRACE"] === "1") process.stderr.write(text);
      }, bots: { kind: "unavailable", reason: "SMP recovery does not require bots" },
      video: { renderer, width: 320, height: 240, hidden: true }, sound: { sampleRate: 48000 },
      input: { stdin: new PassThrough(), signals: "none" } });
    const current = host;
    for (let index = 0; index < 60 && current.client.clientStatic.phase !== "active"; index++)
      expect((await current.frame()).kind).toBe("frame");
    expect(current.client.clientStatic.phase).toBe("active");
    const initialWorkers = output.join("").split("...succeeded.\n").length;
    armed = true; current.common.commands.append("screenshot smp-drop\nscreenshot smp-discard\n");
    let recovered = false;
    for (let index = 0; index < 4 && !recovered; index++) {
      const result = await current.frame();
      if (result.kind === "aborted") {
        expect(result.code).toBe("drop"); expect(result.message).toBe("SMP host callback recovery probe"); recovered = true;
      } else expect(result.kind).toBe("frame");
      await Bun.sleep(1);
    }
    expect(recovered).toBe(true);
    expect(callbacks).toBe(1);
    expect(current.common.cvars.get("smp_callback_effect")?.value).toBe("retained");
    expect(output.join("")).not.toContain("recursive error after");
    expect(output.join("").split("...succeeded.\n").length).toBeGreaterThan(initialWorkers);
    expect(await Bun.file(join(homePath, "baseq3/screenshots/smp-drop.tga")).exists()).toBe(false);
    expect(await Bun.file(join(homePath, "baseq3/screenshots/smp-discard.tga")).exists()).toBe(false);
    current.common.commands.append("map q3dm1\n");
    for (let index = 0; index < 60; index++) {
      expect((await current.frame()).kind).toBe("frame");
      if (current.client.clientStatic.phase === "active") break;
    }
    expect(current.client.clientStatic.phase).toBe("active");
    current.common.commands.append("screenshot smp-recovered\n");
    for (let index = 0; index < 3; index++) expect((await current.frame()).kind).toBe("frame");
    expect(callbacks).toBe(2);
    expect((await readFile(join(homePath, "baseq3/screenshots/smp-recovered.tga"))).length).toBe(18 + 320 * 240 * 3);
    await current.close(); host = null;
  } finally { try { await host?.close(); } finally { execution.mockRestore(); } }
}, 180_000);
