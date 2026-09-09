// RB_ShowImages/RB_SwapBuffers/RE_EndRegistration, id Software renderer sources.
// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { CvarFlag, CvarRegistry } from "../src/core/cvar.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import type { Rect2D } from "../src/render/draw2d.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { MaterialRegistry } from "../src/render/material-registry.ts";
import { parseShaderScript } from "../src/render/material.ts";
import { finishShader } from "../src/render/material-finish.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { publishTexture } from "./render-target-fixture.ts";

function registerImage(images: RendererImageCatalog, name: string): RendererImage {
  return publishTexture(images, { name, width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]),
    internalFormat: "rgba8", sampling: { wrap: "repeat", filter: "nearest" }, registrationUnit: 0 });
}

function fixture(width = 40, height = 30) {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(width, height, images), target = new RenderTarget(images, [cpu]);
  const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), cpu.capabilities);
  const tess = new SourceTessState(), events: string[] = [], draws: { image: RendererImage; rect: Rect2D; proportional: boolean }[] = [];
  let time = 100, performanceTime = 0;
  const commands = new RenderCommandBuffer(target, { identityLight: 1, tess, runtime: settings.runtime,
    performanceClock: { milliseconds: () => { performanceTime += 7; return performanceTime; } },
    clock: { milliseconds: () => { events.push(`clock:${time}`); const result = time; time += 7; return result; } },
    print: text => { events.push(text); return undefined; } });
  const begin = cpu.beginView.bind(cpu), clear = cpu.clearColorBuffer.bind(cpu), finish = cpu.finish.bind(cpu), draw = cpu.drawShowImage.bind(cpu);
  cpu.beginView = view => { begin(view); events.push(view.clear === null ? "2d" : "view"); return undefined; };
  cpu.clearColorBuffer = () => { clear(); events.push("clear"); return undefined; };
  cpu.finish = () => { finish(); events.push("finish"); return undefined; };
  cpu.drawShowImage = (image, rect, proportional) => {
    draw(image, rect, proportional); draws.push({ image, rect: { ...rect }, proportional }); events.push(`image:${image.ordinal}`); return undefined;
  };
  return { images, cpu, target, cvars, settings, tess, events, draws, commands };
}

test("show-images cvar is temporary, defaults to zero and remains live", () => {
  const cvars = new CvarRegistry(), settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
  expect(cvars.get("r_showImages")).toMatchObject({ value: "0", flags: CvarFlag.Temporary });
  expect(settings.runtime.showImages).toBe(0);
  cvars.set("r_showImages", "2"); expect(settings.runtime.showImages).toBe(2);
  cvars.set("r_showImages", "-3"); expect(settings.runtime.showImages).toBe(-3);
});

test("registered-images snapshots contain actual creation order and no journal state operations", () => {
  const images = new RendererImageCatalog(), first = registerImage(images, "z"), second = registerImage(images, "a");
  images.setDlightImage(first); images.setTextureMode("GL_NEAREST");
  const before = images.registeredImages(), third = registerImage(images, "z");
  expect(Object.isFrozen(before)).toBe(true);
  expect(before).toEqual([first, second]);
  expect(images.registeredImages()).toEqual([first, second, third]);
});

test("mid-frame drain never draws the grid and frame-end samples the live cvar after queued work", () => {
  const f = fixture();
  try {
    registerImage(f.images, "first"); registerImage(f.images, "second");
    f.commands.addPreparedViews(() => { f.cvars.set("r_showImages", "1"); return []; });
    f.commands.submit(); expect(f.events).toEqual([]);
    f.commands.submitFrame();
    expect(f.events).toEqual(["clock:100", "2d", "clear", "finish", "image:0", "image:1", "finish",
      "7 msec to draw all images\n", "finish"]);
    expect(f.draws.every(draw => !draw.proportional)).toBe(true);
  } finally { f.target.close(); }
});

test("registration ignores cvar zero, drains queued work and adds no swap finish", () => {
  const f = fixture();
  try {
    registerImage(f.images, "first"); registerImage(f.images, "second");
    f.commands.addPreparedViews(() => { f.events.push("queued"); return []; });
    f.commands.endRegistration();
    expect(f.events).toEqual(["queued", "clock:100", "2d", "clear", "finish", "image:0", "image:1", "finish",
      "7 msec to draw all images\n"]);
    f.events.length = 0;
    f.commands.submitFrame(); expect(f.events).toEqual(["finish"]);
  } finally { f.target.close(); }
});

test("already-2D registration keeps its projection time and empty catalogs still clear, finish and print", () => {
  const f = fixture();
  try {
    f.commands.endRegistration();
    expect(f.events).toEqual(["clock:100", "2d", "clear", "finish", "finish", "7 msec to draw all images\n"]);
    const time = f.tess.floatTime;
    f.events.length = 0; f.commands.endRegistration();
    expect(f.events).toEqual(["clear", "finish", "finish", "7 msec to draw all images\n"]);
    expect(f.tess.floatTime).toBe(time);
  } finally { f.target.close(); }
});

test("grid integer division visits registration index 300 and rereads proportional mode per image", () => {
  const f = fixture(641, 481);
  try {
    for (let index = 0; index <= 300; index++) registerImage(f.images, `image${index}`);
    const draw = f.cpu.drawShowImage.bind(f.cpu);
    f.cpu.drawShowImage = (image, rect, proportional) => {
      draw(image, rect, proportional);
      if (image.ordinal === 0) f.cvars.set("r_showImages", "2");
      if (image.ordinal === 1) f.cvars.set("r_showImages", "-1");
      return undefined;
    };
    f.cvars.set("r_showImages", "1"); f.commands.submitFrame();
    expect(f.draws).toHaveLength(301);
    expect(f.draws.slice(0, 3).map(draw => draw.proportional)).toEqual([false, true, false]);
    expect(f.draws[19]?.rect).toEqual({ x: 608, y: 0, width: 32, height: 32 });
    expect(f.draws[20]?.rect).toEqual({ x: 0, y: 32, width: 32, height: 32 });
    expect(f.draws[300]?.rect).toEqual({ x: 0, y: 480, width: 32, height: 32 });
  } finally { f.target.close(); }
});

test("frame-end flushes actual material tess before the grid and preserves view finish bookkeeping", async () => {
  const f = fixture();
  try {
    const image = registerImage(f.images, "white"); registerImage(f.images, "tail");
    const definition = parseShaderScript("pic { { map $whiteimage rgbGen vertex } }")[0];
    if (definition === undefined) throw new Error("Missing fixture shader");
    const finished = finishShader({ definition, lightmapIndex: -4, profile: f.settings.registrationProfile(), images: [{ kind: "loaded", tmu: 0,
      binding: { kind: "images", playback: { kind: "single", image: { image } } } }] });
    const material = await new MaterialRegistry(async () => ({ definition, image, whiteImage: image, finished, defaulted: false, sky: null }), text => { throw new Error(text); }).register("pic", { kind: "picture" });
    const prepare = f.cpu.prepareSourceGeometry.bind(f.cpu);
    f.cpu.prepareSourceGeometry = stage => {
      const prepared = prepare(stage);
      return { ...prepared, draw: primitives => { prepared.draw(primitives); f.events.push("tess"); return undefined; } };
    };
    f.commands.beginFrame();
    f.commands.addView({ viewport: { x: 0, y: 0, width: 40, height: 30 }, clear: { color: null, depth: 1, stencil: false }, operations: [] });
    const drawing = f.commands.draw2D("pixels"); drawing.setColor(null);
    drawing.drawPic({ x: 0, y: 0, width: 4, height: 4 }, { kind: "material", name: "pic", material });
    f.cvars.set("r_showImages", "1"); f.commands.submitFrame();
    expect(f.events).toEqual(["view", "clock:100", "2d", "tess", "clear", "finish", "image:0", "image:1", "finish",
      "7 msec to draw all images\n"]);
    expect(f.tess.numIndexes).toBe(0);
  } finally { f.target.close(); }
});

test("a backend failure stops the grid before its final finish, print and swap finish", () => {
  const f = fixture();
  try {
    registerImage(f.images, "first"); registerImage(f.images, "second");
    const draw = f.cpu.drawShowImage.bind(f.cpu);
    f.cpu.drawShowImage = (image, rect, proportional) => {
      draw(image, rect, proportional); throw new Error("image draw failed");
    };
    f.cvars.set("r_showImages", "1");
    expect(() => f.commands.submitFrame()).toThrow("image draw failed");
    expect(f.events).toEqual(["clock:100", "2d", "clear", "finish", "image:0"]);
    expect(() => f.images.registeredImages()).toThrow("poisoned");
  } finally { f.target.close(); }
});
