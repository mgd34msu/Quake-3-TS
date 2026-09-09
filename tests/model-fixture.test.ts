import { HunkArena } from "../src/core/hunk.ts";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import { RendererResources } from "../src/render/world.ts";
import { loadModelFixture } from "../tools/model-fixture.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { AudioMixer } from "../src/audio/mixer.ts";

const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";

test.skipIf(!existsSync(`${dataPath}/missionpack/pak0.pk3`))("model probe owns its poses, advances source animations, and uses product weapons", async () => {
  for (const product of ["baseq3", "missionpack"] satisfies readonly ("baseq3" | "missionpack")[]) {
    const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product });
    const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(32, 32, images);
    const target = new RenderTarget(images, [cpu]), builtins = new BuiltinImages(images, identityImageUploadProfile);
    const cinematicMixer = new AudioMixer(44100, () => 0);
    const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: assets }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: () => 0 },
      scratchImages: builtins, console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
    try {
    const scene = await (await RendererResources.create(assets, { kind: "unaccounted" }, createRendererSettings(),
      { patchMemory: { kind: "diagnostic" }, print: () => undefined, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics })).loadWorld("q3dm1");
    const camera = scene.initialCamera();
    const first = await loadModelFixture(scene, assets, camera, product);
    const second = await loadModelFixture(scene, assets, camera, product);
    const initial = first(0), initialBytes = JSON.stringify(initial);
    expect(initial).toHaveLength(5);
    let posed = initial;
    for (let frame = 0; frame <= 60; frame++) {
      posed = first(frame / 60);
      expect(posed).toEqual(second(frame / 60));
    }
    expect(JSON.stringify(initial)).toBe(initialBytes);
    const legs = posed[0], weapon = posed[3];
    if (legs === undefined || weapon === undefined) throw new Error("Missing player fixture");
    expect(legs.origin).toEqual({ x: 306, y: 1328, z: 24 });
    expect({ frame: legs.frame, oldFrame: legs.oldFrame, backLerp: legs.backLerp }).toEqual({ frame: 106, oldFrame: 105, backLerp: 1 });
    expect(weapon.model.path).toBe(product === "missionpack" ? "models/weapons/nailgun/nailgun.md3" : "models/weapons2/machinegun/machinegun.md3");
    expect(() => first(0.5)).toThrow("monotonic");
    expect(() => first(Number.NaN)).toThrow("monotonic");
    expect(() => first(0x80000000 / 1000)).toThrow("game clock");
    } finally { target.close(); cinematics.dispose(); }
  }
}, 30_000);
