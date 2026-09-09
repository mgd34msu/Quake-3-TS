import { HunkArena } from "../src/core/hunk.ts";
import { withRetainedFiles } from "./retained-file-fixture.ts";
import type { RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { ClientMedia, registerClientLoadingGraphics, registerClientSounds, registerClientGraphics, registerClients } from "../src/cgame/media.ts";
import type { ClientMediaHost } from "../src/cgame/media.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { ClientInfoStore } from "../src/cgame/players.ts";
import { ClientServerCommandRuntime } from "../src/cgame/server-commands.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { AssetReader, SourceFileReader } from "../src/assets/reader.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderTarget } from "../src/render/commands.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { RendererResources } from "../src/render/world.ts";
import type { RendererResources as Resources } from "../src/render/world.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { GameRandom } from "../src/game/numeric.ts";
import { GameType, Team, Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { itemList } from "../src/shared/items.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

function unavailable(): never { throw new Error("Unexpected fixture service"); }
function missingAsset(path: string): never { throw new Error(`Missing fixture asset ${path}`); }
const sourceDirectory = process.env["Q3_CGAME_MEDIA_ORACLE"] ?? "/tmp/quake3-cgame-media-reference-CWS3PZ";
const dataPath = process.env["Q3_DATA"] ?? "/home/buzzkill/Projects/qfiles/q3a";
const owners: { readonly target: RenderTarget; readonly cinematics: EngineCinematics }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    try { owner.target.close(); } finally { owner.cinematics.dispose(); }
  }
});
async function registrationResources(files: RetainedFileReader & AssetReader & Pick<SourceFileReader, "readFileLength" | "readFileOptional">, print: (text: string) => undefined): Promise<Resources> {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(1, 1, images);
  const target = new RenderTarget(images, [cpu]), builtins = new BuiltinImages(images, identityImageUploadProfile);
  const cinematicMixer = new AudioMixer(22050, () => 0);
  const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print, files: { kind: "diagnostic-bytes", reader: files }, sound: { kind: "diagnostic", readMixer: () => cinematicMixer }, clock: { sample: () => 0 }, scratchImages: builtins,
    console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
  owners.push({ target, cinematics });
  return RendererResources.create(files, { kind: "unaccounted" }, createRendererSettings(),
    { patchMemory: { kind: "diagnostic" }, print, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
}
// gcc -O0, untouched cg_main.c at dbe4ddb; ordered traps/helper boundaries, no final newline.
// Reproduce: bash $Q3_CGAME_MEDIA_ORACLE/build.sh PRODUCT; PRODUCT GAMETYPE BUILDSCRIPT 1.
const sourceHashes: Readonly<Record<Product, ReadonlyMap<string, string>>> = {
  baseq3: new Map([["0:0", "b2d14acbb616c2a4d576789088eefcde45ce604cf35a6302d9f7f27fa6d9b0b0"],
    ["3:0", "a50358deab691480c40e026c1c80ae9132f17f5054ed5cf491d780489eee5451"],
    ["4:0", "3315c2c6cff6d1e2e6c28cee31b3b3f9dbe70f5d0241459fabef23e6770558a9"],
    ["0:1", "070e4617e31d816da474e9e6e183b322c6bf403ee2727c0fbec58b00c9b69c51"]]),
  missionpack: new Map([["0:0", "2e45fb55b227d42e284fc53efad6c6d8f6f7418e3923070c5edb4e2c2beb53cc"],
    ["3:0", "c42ee74d934e4a89262d5fac01b0e0f65eaec4c997502f2fb93cc3e255464335"],
    ["4:0", "361ec8b7cfa5ae4bd6d7f4a3bce79df15c8cc35cfa9eabd37cd0f612d4b08eb1"],
    ["5:0", "096e1deaf61765d31bb2704cbe6369e97f6ab374d70ad04e464ef30042c7d870"],
    ["6:0", "317e455d896c0002cd9a061b214625043894f2e3da5241b3e88e24a8c2a246e9"],
    ["7:0", "5e390ac25d5d7eacf27c582353482ae53c89cac586247c494bc96d6f5a479370"],
    ["0:1", "605ed3bab9c21848c188f45395b85cffa176288df17652bf0537705fe70f35e7"]]),
};
function referenceTrace(calls: readonly string[], product: Product, gameType: GameType, buildScript: boolean, inlineCount: number): void {
  const expected = sourceHashes[product].get(`${gameType}:${buildScript ? 1 : 0}`);
  if (expected === undefined) throw new Error("Missing captured native registration trace");
  expect(createHash("sha256").update(calls.join("\n")).digest("hex")).toBe(expected);
  const source = `${sourceDirectory}/${product}`;
  if (existsSync(source)) {
    const result = Bun.spawnSync([source, String(gameType), buildScript ? "1" : "0", String(inlineCount)]);
    expect(result.exitCode).toBe(0); expect(calls).toEqual(new TextDecoder().decode(result.stdout).trim().split("\n"));
  }
}
async function fixture(product: Product, gameType = GameType.GT_FFA, buildScript = false) {
  const calls: string[] = [], warnings: string[] = [], itemCalls: number[] = [];
  const assets = await VirtualFileSystem.openInspection({ dataPath, homePath: dataPath, cdPath: null, product }), actual = await registrationResources(assets, text => { warnings.push(text); });
  const state = new ClientGameState(product, 3, 0), staticState = new ClientGameStaticState(product);
  staticState.mapname = "maps/q3dm1.bsp"; staticState.gameType = gameType;
  let nested = false;
  const record = (line: string): void => { if (!nested) calls.push(line); };
  const bank = new ClientSoundBank(assets, { debugPrint: text => { warnings.push(text); }, print: text => warnings.push(text) });
  await bank.beginRegistration();
  const registerSound = bank.registerSound.bind(bank);
  bank.registerSound = (path, compressed) => { record(`S|${path}|${compressed ? 1 : 0}`); return registerSound(path, compressed); };
  const resources: Resources = { ...actual,
    registerModel: path => { record(`M|${path}`); return actual.registerModel(path); },
    registerSkin: path => { record(`K|${path}`); return actual.registerSkin(path); },
    registerShader: path => {
      if (path === "explode11") record("particles");
      if (!/^explode1\d+$/.test(path)) record(`H|${path}`);
      return actual.registerShader(path);
    },
    registerShaderNoMip: path => { record(`N|${path}`); return actual.registerShaderNoMip(path); },
    loadWorld: path => { record(`world|${path}`); return actual.loadWorld(path); },
  };
  const media = new ClientMedia(product, staticState, resources, bank);
  const registerVisual = media.weaponRegistry.registerItemVisuals.bind(media.weaponRegistry);
  media.weaponRegistry.registerItemVisuals = async number => {
    record(`visual|${number}`); nested = true;
    try { await registerVisual(number); } finally { nested = false; }
  };
  const settings = { buildScript };
  const clients = new ClientInfoStore({ state, assets, resources,
    settings: () => ({ gameType, maxClients: 64, forceModel: false, model: "sarge", headModel: "sarge", redTeamName: "Stroggs", blueTeamName: "Pagans",
      deferPlayers: false, buildScript: settings.buildScript, loading: true }), memoryRemaining: () => 100000000,
    registerShaderNoMip: path => resources.registerShaderNoMip(path), registerSound: (path, compressed) => bank.registerSound(path, compressed),
    sound: (path, compressed) => bank.sound(path, compressed), print: text => warnings.push(text),
  }, staticState.clientInfo);
  const newClientInfo = clients.newClientInfo.bind(clients);
  clients.newClientInfo = async (number, config) => {
    record(`info|${number}`); nested = true;
    try { await newClientInfo(number, config); } finally { nested = false; }
  };
  const configs = new Map<number, string>([[27, itemList(product).map((_, index) => index === 3 || index === 9 ? "1" : "0").join("")], [289, "*custom"], [290, "sound/custom.wav"], [292, "ignored.wav"],
    [33, "models/custom.md3"], [35, "ignored.md3"], [545, "\\n\\One\\t\\3\\model\\sarge/default\\hmodel\\sarge/default"],
    [550, "\\n\\Six\\t\\0\\model\\sarge/default\\hmodel\\sarge/default"]]);
  const cvars = new CvarRegistry();
  cvars.register("com_buildScript", buildScript ? "1" : "0");
  const commands = new ClientServerCommandRuntime({ state, staticState, assets, resources, clients, random: new GameRandom(1),
    configString: number => configs.get(number) ?? "", getServerCommand: unavailable, refreshGameState: unavailable,
    resetPlayerEntity: unavailable, readVmCvar: name => { const value = cvars.get(name); if (value === undefined) throw new Error(`Missing fixture cvar ${name}`); return value; },
    setCvar: unavailable, print: text => warnings.push(text), centerPrint: unavailable, sendConsoleCommand: unavailable,
    sound: name => media.sounds[name], registerSound: (path, compressed) => bank.registerSound(path, compressed), startLocalSound: unavailable,
    startBackgroundTrack: unavailable, remapShader: unavailable, clearLocalEntities: unavailable, clearMarks: unavailable, clearParticles: unavailable,
    clearLoopingSounds: unavailable, setScoreSelection: unavailable, showResponseHead: unavailable, memoryRemaining: () => 100000000,
  });
  const loadVoice = commands.loadVoiceChats.bind(commands);
  commands.loadVoiceChats = async () => { record("voice"); nested = true; try { await loadVoice(); } finally { nested = false; } };
  const host: ClientMediaHost = { state, staticState, clients, commands, settings: () => settings,
    configString: number => configs.get(number) ?? "", loadingString: text => { record(`loading|${text}`); return Promise.resolve(); },
    loadingItem: number => { itemCalls.push(number); record(`item|${number}`); return Promise.resolve(); },
    loadingClient: number => { record(`client|${number}`); return Promise.resolve(); }, clearScene: () => record("clear"),
  };
  return { media, host, state, staticState, clients, commands, configs, calls, warnings, itemCalls, settings, bank, resources, actual };
}

describe("source cgame media loading", () => {
  test("source-zero shader handles remain zero through every media projection", async () => {
    const missingAssets: RetainedFileReader & SoundAssetReader & SourceFileReader = withRetainedFiles<SoundAssetReader & SourceFileReader>({ has: () => false, list: () => [],
      read: async (path): Promise<Uint8Array> => missingAsset(path), readSync: missingAsset,
      readFileLength: () => -1, readFileOptional: async () => undefined, readFileOptionalSync: () => undefined });
    const resources = await registrationResources(missingAssets, () => undefined);
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const soundDebugMessages: string[] = [];
      const media = new ClientMedia(product, new ClientGameStaticState(product), resources, new ClientSoundBank(missingAssets, { debugPrint: text => { soundDebugMessages.push(text); }, print: () => undefined }));
      await registerClientLoadingGraphics(media);
      expect(media.graphics.charsetShader).toBeNull();
      expect([media.graphics.charsetProp, media.graphics.charsetPropGlow, media.graphics.charsetPropB]).toEqual([null, null, null]);
      expect(media.graphics.whiteShader).toBe(await resources.registerShader("white"));
      media.graphics.smokePuffShader = await resources.registerShader("smokePuff");
      media.graphics.bloodTrailShader = await resources.registerShader("bloodTrail");
      media.graphics.bloodMarkShader = await resources.registerShader("bloodMark");
      media.graphics.burnMarkShader = await resources.registerShader("gfx/damage/burn_med_mrk");
      expect(media.particles).toEqual({ tracerShader: null, smokePuffShader: null, waterBubbleShader: null });
      expect(media.localEntities.media.bloodTrailShader).toBeNull();
      expect(media.localEntities.media.bloodMarkShader).toBeNull();
      expect(media.localEntities.media.burnMarkShader).toBeNull();
      expect(media.localEntities.media.numberShaders.every(shader => shader === null)).toBe(true);
      expect(media.events.smokePuffShader).toBeNull();
      expect(media.effects.bloodExplosionShader).toBeNull();
      expect(media.players.quadShader).toBeNull();
      expect(media.packet.plasmaBallShader).toBeNull();
      expect(media.weapons.shaders.smokePuff).toBeNull();
      if (product === "baseq3") expect(() => media.missionPlayers).toThrow("Mission player media");
    }
  });
  test("both products prepare the five real CG_Init loading handles in exact source order", async () => {
    for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
      const f = await fixture(product), g = f.media.graphics;
      expect([g.charsetShader, g.whiteShader, g.charsetProp, g.charsetPropGlow, g.charsetPropB]).toEqual([null, null, null, null, null]);
      await registerClientLoadingGraphics(f.media);
      expect(f.calls).toEqual(["H|gfx/2d/bigchars", "H|white", "N|menu/art/font1_prop.tga", "N|menu/art/font1_prop_glo.tga", "N|menu/art/font2_prop.tga"]);
      expect(g.charsetShader).toBe(await f.actual.registerShader("gfx/2d/bigchars"));
      expect(g.whiteShader).toBe(await f.actual.registerShader("white"));
      expect(g.charsetProp).toBe(await f.actual.registerShaderNoMip("menu/art/font1_prop.tga"));
      expect(g.charsetPropGlow).toBe(await f.actual.registerShaderNoMip("menu/art/font1_prop_glo.tga"));
      expect(g.charsetPropB).toBe(await f.actual.registerShaderNoMip("menu/art/font2_prop.tga"));
      expect(f.media.graphics.smokePuffShader).toBeNull();
      expect(f.media.sounds.oneMinuteSound).toBeNull();
      f.commands.dispose();
    }
  });
  test("early loading handles publish sequentially after each actual registration completes", async () => {
    const f = await fixture("baseq3"), first = Promise.withResolvers<void>();
    const registerShader = f.resources.registerShader.bind(f.resources);
    f.resources.registerShader = async name => { if (name === "gfx/2d/bigchars") await first.promise; return registerShader(name); };
    const loading = registerClientLoadingGraphics(f.media);
    expect(f.media.graphics.charsetShader).toBeNull(); expect(f.media.graphics.whiteShader).toBeNull(); expect(f.calls).toEqual([]);
    first.resolve(); await loading;
    expect(f.calls.length).toBe(5); expect(f.media.graphics.charsetPropB).not.toBeNull();
    f.commands.dispose();
  });
  test("graphics registration awaits each loading screen at its original source boundary", async () => {
    const f = await fixture("baseq3");
    const mapScreen = Promise.withResolvers<void>(), gameScreen = Promise.withResolvers<void>();
    const gameScreenEntered = Promise.withResolvers<void>();
    f.host.loadingString = text => {
      f.calls.push(`loading|${text}`);
      if (text === f.staticState.mapname) return mapScreen.promise;
      expect(text).toBe("game media"); gameScreenEntered.resolve(); return gameScreen.promise;
    };
    const registration = registerClientGraphics(f.media, f.host);
    expect(f.calls).toEqual(["clear", "loading|maps/q3dm1.bsp"]);
    expect(f.media.graphics.numberShaders.every(shader => shader === null)).toBe(true);
    mapScreen.resolve(); await gameScreenEntered.promise;
    expect(f.calls).toEqual(["clear", "loading|maps/q3dm1.bsp", "world|maps/q3dm1.bsp", "loading|game media"]);
    expect(f.media.graphics.numberShaders.every(shader => shader === null)).toBe(true);
    gameScreen.resolve(); await registration;
    expect(f.media.graphics.numberShaders.every(shader => shader !== null)).toBe(true);
    f.commands.dispose();
  });
  for (const product of ["baseq3", "missionpack"] satisfies readonly Product[]) {
    test(`${product} retail source registration, canonical projections and local-first client loading`, async () => {
      const f = await fixture(product);
      expect(f.media.packet.gameModels).toBe(f.staticState.gameModels);
      expect(f.media.events.gameSounds).toBe(f.staticState.gameSounds);
      expect(f.media.graphics.redFlagModel.kind).toBe("default");
      expect(f.media.particles).toEqual({ tracerShader: null, smokePuffShader: null, waterBubbleShader: null });
      f.calls.push("SOUNDS"); await registerClientSounds(f.media, f.host);
      f.calls.push("GRAPHICS"); const graphics = await registerClientGraphics(f.media, f.host);
      f.calls.push("CLIENTS"); await registerClients(f.media, f.host);
      expect(f.itemCalls).toEqual([3, 9]);
      expect(f.calls).toContain("S|sound/weapons/grenade/hgrenb1a.wav|0");
      expect(f.calls.some(call => call.includes("ignored"))).toBe(false);
      expect(f.calls.slice(-7)).toEqual(["CLIENTS", "client|3", "info|3", "client|1", "info|1", "client|6", "info|6"]);
      expect(f.clients.clientInfo(3).infoValid).toBe(false);
      expect(f.staticState.clientInfo[1]).toBe(f.clients.clientInfo(1));
      expect(f.clients.clientInfo(1).team).toBe(Team.TEAM_SPECTATOR);
      expect(f.state.spectatorList).toBe("One     ");
      expect(f.state.spectatorWidth).toBe(-1);
      expect(f.media.inlineModels.length).toBe(graphics.world.map.models.length);
      expect(graphics.particleAnimations.explode1.length).toBe(23);
      expect(f.media.weapons.models.machinegunBrass).toBe(f.media.graphics.machinegunBrassModel);
      expect(f.media.players.quadShader).toBe(f.media.graphics.quadShader);
      expect(f.media.effects.smoke2).toBe(f.media.graphics.shotgunBrassModel);
      expect(f.media.graphics.smokePuffShader).toBe(f.media.particles.smokePuffShader);
      expect(f.media.sounds.gibBounce1Sound).toBe(f.media.localEntities.media.gibBounceSounds[0]);
      expect(f.media.packet.items).toBe(f.media.weaponRegistry.items);
      expect(f.media.weaponRegistry.requireWeapon(Weapon.WP_SHOTGUN).weaponModel.kind).toBe("md3");
      expect(f.media.weaponRegistry.weapon(Weapon.WP_ROCKET_LAUNCHER).item).toBeNull();
      expect(f.media.sounds.captureAwardSound).toBeNull();
      referenceTrace(f.calls, product, GameType.GT_FFA, false, graphics.world.map.models.length);
      const before = [...f.calls]; expect(f.bank.sound("sound/weapons/rocket/rockfly.wav", false)?.frameCount).toBeGreaterThan(0); expect(f.calls).toEqual(before);
      if (product === "missionpack") expect(f.bank.sound("sound/weapons/vulcan/wvulwind.wav", false)?.frameCount).toBeGreaterThan(0);
      f.commands.dispose();
    });
  }
  test("mission mode/buildScript conditions and registration order match untouched native CG_Main", async () => {
    for (const [gameType, buildScript] of [[GameType.GT_TEAM, false], [GameType.GT_CTF, false], [GameType.GT_1FCTF, false],
      [GameType.GT_OBELISK, false], [GameType.GT_HARVESTER, false], [GameType.GT_FFA, true]] satisfies readonly (readonly [GameType, boolean])[]) {
      const f = await fixture("missionpack", gameType, buildScript);
      f.calls.push("SOUNDS"); await registerClientSounds(f.media, f.host);
      f.calls.push("GRAPHICS"); const graphics = await registerClientGraphics(f.media, f.host);
      f.calls.push("CLIENTS"); await registerClients(f.media, f.host);
      referenceTrace(f.calls, "missionpack", gameType, buildScript, graphics.world.map.models.length);
      expect(f.media.sounds.captureAwardSound).not.toBeNull();
      expect(f.media.graphics.overloadBaseModel.kind !== "default").toBe(gameType === GameType.GT_OBELISK || buildScript);
      expect(f.media.graphics.harvesterModel.kind !== "default").toBe(gameType === GameType.GT_HARVESTER || buildScript);
      expect(f.media.graphics.neutralFlagModel.kind !== "default").toBe(gameType === GameType.GT_1FCTF || buildScript);
      if (buildScript) expect(f.itemCalls).toEqual(itemList("missionpack").slice(1).map((_, index) => index + 1));
      f.commands.dispose();
    }
  }, 30000);
  test("base team, CTF and buildScript retain their distinct source mission-independent registrations", async () => {
    for (const [gameType, buildScript] of [[GameType.GT_TEAM, false], [GameType.GT_CTF, false], [GameType.GT_FFA, true]] satisfies readonly (readonly [GameType, boolean])[]) {
      const f = await fixture("baseq3", gameType, buildScript);
      f.calls.push("SOUNDS"); await registerClientSounds(f.media, f.host);
      f.calls.push("GRAPHICS"); const graphics = await registerClientGraphics(f.media, f.host);
      f.calls.push("CLIENTS"); await registerClients(f.media, f.host);
      referenceTrace(f.calls, "baseq3", gameType, buildScript, graphics.world.map.models.length);
      expect(f.media.sounds.yourTeamTookTheFlagSound).not.toBeNull();
      expect(f.media.graphics.flagPoleModel.kind).toBe("default");
      if (buildScript) expect(f.itemCalls.length).toBe(itemList("baseq3").length - 1);
      f.commands.dispose();
    }
  }, 15000);
  test("retail inline models publish real renderer identity and source float32 bounds midpoints", async () => {
    const f = await fixture("baseq3"); f.staticState.mapname = "maps/q3dm7.bsp";
    f.configs.set(33, "*1"); f.configs.set(34, "*01"); f.configs.set(35, "*999");
    f.state.refdef.width = 640; f.state.refdef.areaMask.fill(255);
    const graphics = await registerClientGraphics(f.media, f.host);
    expect(f.media.inlineModels.length).toBe(8);
    for (let i = 1; i < 8; i++) {
      const entry = f.media.inlineModels[i], model = graphics.world.map.models[i];
      if (entry === undefined || model === undefined) throw new Error("Missing retail inline model");
      expect(entry.model).toBe(graphics.world.inlineModel(i));
      const bounds = model.bounds, round = Math.fround;
      expect(entry.midpoint).toEqual({ x: round(bounds.min.x + round(0.5 * round(bounds.max.x - bounds.min.x))),
        y: round(bounds.min.y + round(0.5 * round(bounds.max.y - bounds.min.y))), z: round(bounds.min.z + round(0.5 * round(bounds.max.z - bounds.min.z))) });
    }
    expect(f.staticState.gameModels[1]).toBe(graphics.world.inlineModel(1));
    expect(f.staticState.gameModels[2]?.kind).toBe("default");
    expect(f.staticState.gameModels[3]?.kind).toBe("default");
    expect(f.state.refdef.width).toBe(0); expect([...f.state.refdef.areaMask]).toEqual(Array.from({ length: 32 }, () => 0));
    f.commands.dispose();
  });
  test("source precache scratch limits and canonical state mismatches reject explicitly", async () => {
    const f = await fixture("baseq3");
    await expect(registerClients(f.media, { ...f.host, staticState: new ClientGameStaticState("baseq3") })).rejects.toThrow("canonical");
    expect(() => f.media.missionPlayers).toThrow("baseq3");
    f.configs.set(27, "0".repeat(257));
    await expect(registerClientSounds(f.media, f.host)).rejects.toThrow("MAX_ITEMS");
    f.commands.dispose();
  });
  test("registration waits for the real loading helper before visual and client-info work", async () => {
    const f = await fixture("baseq3"), item = Promise.withResolvers<void>(), client = Promise.withResolvers<void>();
    const itemStarted = Promise.withResolvers<void>(), clientStarted = Promise.withResolvers<void>();
    const graphics = registerClientGraphics(f.media, { ...f.host, loadingItem: async number => {
      f.itemCalls.push(number); itemStarted.resolve(); await item.promise;
    } });
    await itemStarted.promise;
    expect(f.media.weaponRegistry.items[3]?.models[0].kind).toBe("default");
    item.resolve(); await graphics;
    expect(f.media.weaponRegistry.items[3]?.models[0].kind).toBe("md3");
    const clients = registerClients(f.media, { ...f.host, loadingClient: async () => { clientStarted.resolve(); await client.promise; } });
    await clientStarted.promise;
    expect(f.calls.some(call => call.startsWith("info|"))).toBe(false);
    client.resolve(); await clients; expect(f.clients.clientInfo(1).infoValid).toBe(true);
    f.commands.dispose();
  });
});
