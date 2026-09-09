// AssetCache and Asset_Parse destinations from id Software's code/ui/ui_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import type { PcmSound } from "../../assets/wav.ts";
import type { Vec4 } from "../../core/math.ts";
import type { EngineSound } from "../../engine/sound.ts";
import type { EngineUiCinematics } from "../../engine/ui-cinematics.ts";
import type { MaterialPicture, PictureAsset } from "../../render/draw2d.ts";
import type { FontSet, RegisteredFont, UiAssetRegistry } from "../../render/font.ts";
import type { SceneModel } from "../../render/ref-entity.ts";
import type { RendererResources } from "../../render/world.ts";
import type { UiMenuAssetPublication, UiMenuAssetSink, UiMenuRegistrationEvent, UiMenuRegistrationResult, UiMenuRegistrationSink } from "../menu.ts";
import type { UiCinematicAsset, UiRuntimeResources, UiWidgetAssets } from "../runtime.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import type { UiStringReference } from "./memory.ts";

export interface TeamArenaUiResourceServices {
  readonly renderer: RendererResources;
  readonly sound: Pick<EngineSound, "bank">;
  readonly fontRegistry: UiAssetRegistry;
  readonly cinematics: EngineUiCinematics;
  readonly cvars: TeamArenaUiCvars;
  assertCurrentOperation(): void;
}

export interface TeamArenaUiAssets extends UiWidgetAssets {
  readonly displayCursor: PictureAsset;
  readonly cursor: PictureAsset;
  readonly cursorStr: string | null;
  readonly textFont: RegisteredFont;
  readonly smallFont: RegisteredFont;
  readonly bigFont: RegisteredFont;
  readonly fontRegistered: boolean;
  readonly fxBasePic: PictureAsset;
  readonly fxPic: readonly PictureAsset[];
  readonly crosshairShader: readonly PictureAsset[];
  readonly newHighScoreSound: PcmSound | null;
  readonly menuEnterSound: PcmSound | null;
  readonly menuExitSound: PcmSound | null;
  readonly menuBuzzSound: PcmSound | null;
  readonly itemFocusSound: PcmSound | null;
  readonly fadeClamp: number;
  readonly fadeCycle: number;
  readonly fadeAmount: number;
  readonly shadowX: number;
  readonly shadowY: number;
  readonly shadowColor: Vec4;
  readonly shadowFadeClamp: number;
}

function zeroFont(): RegisteredFont {
  return { name: "", glyphScale: 0, glyphs: Array.from({ length: 256 }, () => ({ height: 0, top: 0, bottom: 0,
    pitch: 0, xSkip: 0, imageWidth: 0, imageHeight: 0, s: 0, t: 0, s2: 0, t2: 0, shaderName: "", picture: null })) };
}
function fold(path: string | null): string {
  return path === null ? "null" : `name:${path.replace(/[A-Z]/g, character => String.fromCharCode(character.charCodeAt(0) + 32))}`;
}

/** One UI VM's asset destinations. Renderer, sound and cinematic lifetimes remain engine-owned. */
export class TeamArenaUiResources implements UiRuntimeResources, UiMenuRegistrationSink, UiMenuAssetSink {
  readonly fonts: FontSet;
  readonly handles: Extract<UiRuntimeResources["handles"], { kind: "source" }>;
  private state: TeamArenaUiAssets;
  private cursorString: UiStringReference | null = null;
  private closed = false;
  private readonly pictures = new Map<string, PictureAsset | undefined>();
  private readonly sounds = new Map<string, PcmSound | undefined>();
  private readonly models = new Map<string, SceneModel>();
  private readonly registeredFonts = new Map<string, RegisteredFont | null>();

  constructor(private readonly services: TeamArenaUiResourceServices) {
    services.assertCurrentOperation();
    if (services.cinematics.profile !== "ui") throw new Error("Team Arena UI resources require the UI cinematic profile");
    const zero = services.renderer.picture(null);
    this.state = { displayCursor: zero, whiteShader: zero, cursor: zero, cursorStr: null,
      textFont: zeroFont(), smallFont: zeroFont(), bigFont: zeroFont(), fontRegistered: false,
      gradientBar: zero, fxBasePic: zero, fxPic: Array.from({ length: 7 }, () => zero),
      scrollBar: zero, scrollBarArrowDown: zero, scrollBarArrowUp: zero, scrollBarArrowLeft: zero,
      scrollBarArrowRight: zero, scrollBarThumb: zero, sliderBar: zero, sliderThumb: zero,
      crosshairShader: Array.from({ length: 10 }, () => zero), newHighScoreSound: null,
      menuEnterSound: null, menuExitSound: null, menuBuzzSound: null, itemFocusSound: null,
      fadeClamp: 0, fadeCycle: 0, fadeAmount: 0, shadowX: 0, shadowY: 0,
      shadowColor: { x: 0, y: 0, z: 0, w: 0 }, shadowFadeClamp: 0 };
    const owner = this;
    this.fonts = { profile: "ui", get small() { owner.current(); return owner.state.smallFont; },
      get normal() { owner.current(); return owner.state.textFont; }, get big() { owner.current(); return owner.state.bigFont; },
      get smallThreshold() { owner.current(); return services.cvars.get("ui_smallFont").numericValue; },
      get bigThreshold() { owner.current(); return services.cvars.get("ui_bigFont").numericValue; } };
    this.handles = { kind: "source",
      pictureHandle: picture => {
        this.current();
        if (picture === undefined) return 0;
        if (picture.kind !== "material") throw new Error("Source UI picture handle requires a registered renderer material");
        return picture.material.order;
      },
      pictureForHandle: handle => {
        this.current();
        if (handle === 0) return undefined;
        const picture = services.renderer.picture(services.renderer.shaderForHandle(handle));
        this.current(); return picture;
      },
      modelForHandle: handle => {
        this.current(); const model = services.renderer.modelForHandle(handle); this.current(); return model;
      } };
  }

  private current(): void {
    this.services.assertCurrentOperation();
    if (this.closed) throw new Error("Team Arena UI resources are disposed");
  }
  get assets(): TeamArenaUiAssets {
    this.current();
    return Object.freeze({ ...this.state, cursorStr: this.cursorString?.read() ?? null, fxPic: Object.freeze([...this.state.fxPic]),
      crosshairShader: Object.freeze([...this.state.crosshairShader]), shadowColor: Object.freeze({ ...this.state.shadowColor }) });
  }
  get widgetAssets(): UiWidgetAssets { return this.assets; }

  /** The two registrations immediately preceding AssetCache in _UI_Init. */
  async initializeDisplayAssets(): Promise<void> {
    const displayCursor = await this.registerPicture("menu/art/3_cursor2"); this.current();
    this.state = { ...this.state, displayCursor: displayCursor ?? this.services.renderer.picture(null) };
    const whiteShader = await this.registerPicture("white"); this.current();
    this.state = { ...this.state, whiteShader: whiteShader ?? this.services.renderer.picture(null) };
  }

  async assetCache(): Promise<void> {
    this.current();
    const picture = async (path: string): Promise<PictureAsset> => {
      const registered = await this.registerPicture(path); this.current();
      return registered ?? this.services.renderer.picture(null);
    };
    const gradientBar = await picture("ui/assets/gradientbar2.tga"); this.current(); this.state = { ...this.state, gradientBar };
    const fxBasePic = await picture("menu/art/fx_base"); this.current(); this.state = { ...this.state, fxBasePic };
    for (const [index, color] of ["red", "yel", "grn", "teal", "blue", "cyan", "white"].entries()) {
      const registered = await picture(`menu/art/fx_${color}`), colors = [...this.state.fxPic];
      this.current();
      colors[index] = registered; this.state = { ...this.state, fxPic: colors };
    }
    for (const [field, path] of [
      ["scrollBar", "ui/assets/scrollbar.tga"], ["scrollBarArrowDown", "ui/assets/scrollbar_arrow_dwn_a.tga"],
      ["scrollBarArrowUp", "ui/assets/scrollbar_arrow_up_a.tga"], ["scrollBarArrowLeft", "ui/assets/scrollbar_arrow_left.tga"],
      ["scrollBarArrowRight", "ui/assets/scrollbar_arrow_right.tga"], ["scrollBarThumb", "ui/assets/scrollbar_thumb.tga"],
      ["sliderBar", "ui/assets/slider2.tga"], ["sliderThumb", "ui/assets/sliderbutt_1.tga"],
    ] satisfies readonly (readonly [keyof UiWidgetAssets, string])[]) {
      const registered = await picture(path); this.current(); this.state = { ...this.state, [field]: registered };
    }
    for (let index = 0; index < 10; index++) {
      const registered = await picture(`gfx/2d/crosshair${String.fromCharCode(97 + index)}`), crosshairs = [...this.state.crosshairShader];
      this.current();
      crosshairs[index] = registered; this.state = { ...this.state, crosshairShader: crosshairs };
    }
    const sound = await this.registerSound("sound/feedback/voc_newhighscore.wav"); this.current();
    this.state = { ...this.state, newHighScoreSound: sound ?? null };
  }

  async registerPicture(path: string | null): Promise<MaterialPicture | undefined> {
    this.current();
    const shader = await this.services.renderer.registerShaderNoMip(path); this.current();
    const picture = shader === null ? undefined : this.services.renderer.picture(shader);
    this.pictures.set(fold(path), picture); return picture;
  }
  registeredPicture(path: string | null): PictureAsset | undefined { this.current(); return this.pictures.get(fold(path)); }
  async registerSound(path: string | null): Promise<PcmSound | undefined> {
    this.current(); const sound = await this.services.sound.bank.registerSound(path, false); this.current();
    const registered = sound ?? undefined;
    this.sounds.set(fold(path), registered);
    return registered;
  }
  registeredSound(path: string | null): PcmSound | undefined { this.current(); return this.sounds.get(fold(path)); }
  async registerModel(path: string | null): Promise<SceneModel> {
    this.current(); const model = await this.services.renderer.registerModel(path); this.current();
    this.models.set(fold(path), model); return model;
  }
  registeredModel(path: string | null): SceneModel | undefined { this.current(); return this.models.get(fold(path)); }
  async registerFont(path: string | null, pointSize: number): Promise<void> {
    this.current(); const font = await this.services.fontRegistry.registerFont(path, pointSize); this.current();
    this.registeredFonts.set(`${fold(path)}\0${pointSize}`, font);
  }
  async prepareCinematic(path: string): Promise<UiCinematicAsset> {
    this.current(); const asset = await this.services.cinematics.owner.prepare(path); this.current(); return asset;
  }
  async register(event: UiMenuRegistrationEvent): Promise<UiMenuRegistrationResult> {
    switch (event.kind) {
      case "font": await this.registerFont(event.reference.path, event.reference.pointSize); return;
      case "picture": {
        const picture = await this.registerPicture(event.reference.path); this.current();
        return { handle: picture === undefined ? 0 : picture.material.order };
      }
      case "sound": {
        const sound = await this.registerSound(event.reference.path); this.current();
        return { handle: this.services.sound.bank.indexForSound(sound ?? null) };
      }
      case "model": {
        const model = await this.registerModel(event.reference.path); this.current();
        return { handle: this.services.renderer.modelHandle(model) };
      }
    }
  }

  /** Reached Asset_Parse assignments, not a completed-file transaction. */
  publish(event: UiMenuAssetPublication): void {
    this.current();
    switch (event.field) {
      case "textFont": case "smallFont": case "bigFont": {
        const font = this.registeredFonts.get(`${fold(event.value.path)}\0${event.value.pointSize}`);
        if (font === undefined) throw new Error("UI font publication preceded its registration");
        if (font === null) return;
        this.state = { ...this.state, [event.field]: font }; return;
      }
      case "cursor": case "gradientBar": {
        const key = fold(event.value.path);
        if (!this.pictures.has(key)) throw new Error("UI picture publication preceded its registration");
        this.state = { ...this.state, [event.field]: this.pictures.get(key) ?? this.services.renderer.picture(null) }; return;
      }
      case "menuEnterSound": case "menuExitSound": case "menuBuzzSound": case "itemFocusSound": {
        const key = fold(event.value.path);
        if (!this.sounds.has(key)) throw new Error("UI sound publication preceded its registration");
        this.state = { ...this.state, [event.field]: this.sounds.get(key) ?? null }; return;
      }
      case "shadowColorComponent":
        this.state = { ...this.state, shadowColor: { ...this.state.shadowColor, [event.component]: event.value } }; return;
      case "cursorStr": this.cursorString = event.value; return;
      case "fontRegistered": case "fadeClamp": case "fadeCycle": case "fadeAmount":
      case "shadowX": case "shadowY": case "shadowFadeClamp":
        this.state = { ...this.state, [event.field]: event.value }; return;
      default: { const exhaustive: never = event; return exhaustive; }
    }
  }

  dispose(): void {
    this.closed = true;
    this.pictures.clear(); this.sounds.clear(); this.models.clear(); this.registeredFonts.clear();
  }
}
