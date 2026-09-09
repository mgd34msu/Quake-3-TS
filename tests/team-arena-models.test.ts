import { HunkArena } from "../src/core/hunk.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommonFileState } from "../src/assets/filesystem-state.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { SoundOutput } from "../src/engine/sound-output.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { RendererResources } from "../src/render/world.ts";
import { TeamArenaModels } from "../src/ui/team-arena/models.ts";

async function fixture(retail: boolean, filenames: readonly string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "quake3-team-models-"));
  for (const filename of filenames) {
    const path = join(directory, "data/missionpack/models/players", filename);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, new Uint8Array([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 24, 32, 10, 20, 30]));
  }
  const prints: string[] = [], print = (text: string): undefined => { prints.push(text); };
  const cvars = new CvarRegistry(print), sound = new SoundOutput();
  const files = new CommonFileState({ dataPath: retail ? process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a" : join(directory, "data"),
    homePath: join(directory, "home"), cdPath: null, product: "missionpack" }, print, sound, cvars);
  let active = true, cinematics: EngineCinematics | null = null, target: RenderTarget | null = null;
  const assertActive = (): void => { if (!active) throw new Error("retired model-list owner"); };
  const close = (): void => {
    try {
      try { cinematics?.dispose(); } finally { try { files.close(); } finally { sound.close(); rmSync(directory, { recursive: true, force: true }); } }
    } finally { target?.close(); }
  };
  try {
    await files.initialize({ checksumFeed: 0, random: () => 0 }, assertActive);
    const images = new RendererImageCatalog(), builtins = new BuiltinImages(images, identityImageUploadProfile);
    target = new RenderTarget(images, [new SoftwareRenderer(1, 1, images)]);
    const settings = new SourceRendererSettings(new RegisteredRendererCvars(cvars, "linux"), { textureUnits: 2, textureEnvAdd: true });
    cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined, files: { kind: "diagnostic-bytes", reader: files.current }, sound: { kind: "diagnostic", readMixer: () => null }, clock: { sample: () => 0 },
      scratchImages: builtins, console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
    const resources = await RendererResources.create(files.current, { kind: "unaccounted" }, settings,
      { patchMemory: { kind: "diagnostic" }, print, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
    return { directory, prints, files, resources, models: new TeamArenaModels(files, resources, print, assertActive),
      retire: () => { active = false; }, close };
  } catch (error) { close(); throw error; }
}

test("Team Arena lists retail Q3 player heads with actual renderer shader identities", async () => {
  const f = await fixture(true);
  try {
    await f.models.buildList();
    expect(f.models.headCount).toBeGreaterThan(20);
    const sarge = f.models.heads.slice(0, f.models.headCount).find(head => head.name === "sarge");
    if (sarge === undefined) throw new Error("Retail Sarge head was not listed");
    expect(sarge.icon).not.toBeNull();
    expect(sarge.icon).toBe(await f.resources.registerShaderNoMip("models/players/sarge/icon_default"));
    expect(f.models.heads.slice(0, f.models.headCount).some(head => /\/(red|blue)$/i.test(head.name))).toBe(false);
  } finally { f.close(); }
});

test("head list preserves source reload-slot duplicate bug and skips team icons", async () => {
  const f = await fixture(false, ["test/icon_default.tga", "test/icon_first.tga", "test/icon_last.tga", "test/icon_blue.tga", "test/icon_red.tga", "test/body.tga"]);
  try {
    await f.models.buildList();
    expect(f.models.heads.slice(0, f.models.headCount).map(head => head.name).sort()).toEqual(["test", "test/first", "test/last"]);
    const old = f.models.heads.slice(0, 3).map(head => head.name), first = f.models.heads[0];
    await f.models.buildList();
    expect(f.models.headCount).toBe(2);
    expect(f.models.heads[0]).toBe(first);
    expect(f.models.heads.slice(0, 2).map(head => head.name)).toEqual(old.filter((_name, index) => index !== 1));
    expect(f.models.heads[2]?.name).toBe(old[2]);
  } finally { f.close(); }
});

test("head registration retirement retains written name without publishing shader or count", async () => {
  const f = await fixture(false, ["test/icon_default.tga"]);
  try {
    const register = f.resources.registerShaderNoMip.bind(f.resources);
    f.resources.registerShaderNoMip = async name => { const shader = await register(name); f.retire(); return shader; };
    await expect(f.models.buildList()).rejects.toThrow("retired model-list owner");
    expect(f.models.headCount).toBe(0);
    expect(f.models.heads[0]).toEqual({ name: "test", icon: null });
  } finally { f.close(); }
});

test("head names use both source format passes and diagnose bounded truncation", async () => {
  const long = "m".repeat(70), f = await fixture(false, [`${long}/icon_default.tga`, "percent%%%%/icon_default.tga"]);
  try {
    await f.models.buildList();
    expect(f.models.heads.slice(0, f.models.headCount).map(head => head.name).sort()).toEqual(["m".repeat(63), "percent%"]);
    expect(f.prints).toContain("Com_sprintf: overflow of 70 in 64\n");
  } finally { f.close(); }
  const overflow = await fixture(false, [`test/${"x".repeat(64)}.tga`]);
  try { await expect(overflow.models.buildList()).rejects.toThrow("skinname[64]"); }
  finally { overflow.close(); }
});
