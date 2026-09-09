/*
 * Team Arena shared-menu runtime translated from id Software's
 * code/ui/ui_shared.c and ui_shared.h. Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { KEY_CHAR_FLAG, KeyCode } from "../core/key-codes.ts";
import { CommonParseCursor, CommonParseState } from "../core/common-parse.ts";
import { qvmFloatToInt } from "../core/numeric.ts";
import type { PcmSound } from "../assets/wav.ts";
import type { CommandBuffer } from "../core/commands.ts";
import type { CvarRegistry } from "../core/cvar.ts";
import type { Vec4 } from "../core/math.ts";
import { Draw2D, type PictureAsset } from "../render/draw2d.ts";
import { textHeight, textPaint, textPaintWithCursor, textWidth, type FontSet } from "../render/font.ts";
import { DEFAULT_MODEL, type SceneModel } from "../render/ref-entity.ts";
import type { SourceLocation } from "../script/lexer.ts";
import { gameFormat } from "../game/format.ts";
import { gameAtof, gameAtoi } from "../game/numeric.ts";
import {
  UiWindowFlag,
  MAX_UI_MENUS,
  type UiMenuAssetPublication,
  type UiMenuRegistrationEvent,
  type UiItemDefinition,
  type UiListBoxDefinition,
  type UiMenuDefinition,
  type UiMenuDefinitions,
  type UiMenuMemoryOwnership,
  type UiRect,
  type UiScript,
  type UiScriptToken,
  type UiWindowDefinition,
} from "./menu.ts";

const MAX_OPEN_MENUS = 16;
const SCROLLBAR_SIZE = 16;
const SLIDER_WIDTH = 96;
const SLIDER_THUMB_WIDTH = 12;
const DOUBLE_CLICK_DELAY = 300;
const PULSE_DIVISOR = 75;
const BLINK_DIVISOR = 200;
const f = Math.fround;


export type UiKeyEvent =
  | { readonly kind: "key"; readonly code: number; readonly down: boolean }
  | { readonly kind: "character"; readonly code: number };

export interface UiRuntimeAudio {
  playLocal(sound: PcmSound | number | undefined): void;
  startBackground(path: string | null): Promise<void>;
  stopBackground(): void;
}

export interface UiRuntimeResources {
  readonly handles: { readonly kind: "diagnostic" } | {
    readonly kind: "source";
    pictureHandle(value: PictureAsset | undefined): number;
    pictureForHandle(handle: number): PictureAsset | undefined;
    modelForHandle(handle: number): SceneModel;
  };
  registerFont(path: string | null, pointSize: number): Promise<void>;
  registerPicture(path: string | null): Promise<PictureAsset | undefined>;
  registeredPicture(path: string | null): PictureAsset | undefined;
  registerSound(path: string | null): Promise<PcmSound | undefined>;
  registeredSound(path: string | null): PcmSound | undefined;
  registerModel(path: string | null): Promise<SceneModel>;
  registeredModel(path: string | null): SceneModel | undefined;
  prepareCinematic(path: string): Promise<UiCinematicAsset>;
}

export interface UiCinematicAsset { readonly path: string }
export interface UiCinematicInstance { readonly asset: UiCinematicAsset; readonly handle: { readonly index: number } }

export interface UiRuntimeCinematics {
  play(asset: UiCinematicAsset, rect: UiRect): UiCinematicInstance | undefined;
  run(handle: number, time: number): void;
  draw(handle: number, rect: UiRect, draw: Draw2D): void;
  stop(handle: number): void;
}

export interface UiWidgetAssets {
  readonly whiteShader: PictureAsset;
  readonly gradientBar: PictureAsset;
  readonly scrollBar: PictureAsset;
  readonly scrollBarArrowDown: PictureAsset;
  readonly scrollBarArrowUp: PictureAsset;
  readonly scrollBarArrowLeft: PictureAsset;
  readonly scrollBarArrowRight: PictureAsset;
  readonly scrollBarThumb: PictureAsset;
  readonly sliderBar: PictureAsset;
  readonly sliderThumb: PictureAsset;
}

export interface UiModelPaintRequest {
  readonly draw: Draw2D;
  readonly model: SceneModel;
  readonly rect: UiRect;
  readonly time: number;
  readonly angle: number;
  /** Source zero means use the viewport dimension after AdjustFrom640. */
  readonly fieldOfViewX: number;
  /** Source zero means use the viewport dimension after AdjustFrom640. */
  readonly fieldOfViewY: number;
}

export interface UiOwnerDrawPaintRequest {
  readonly draw: Draw2D;
  readonly rect: UiRect;
  readonly textX: number;
  readonly textY: number;
  readonly ownerDraw: number;
  readonly ownerDrawFlags: number;
  readonly alignment: number;
  readonly special: number;
  readonly textScale: number;
  readonly color: Vec4;
  readonly background: PictureAsset | (() => PictureAsset) | undefined;
  readonly textStyle: number;
}

export interface UiRuntimeBindings {
  keyName(key: number): string;
  getBinding(key: number): string;
  setBinding(key: number, command: string): void;
  getOverstrike(): boolean;
  setOverstrike(enabled: boolean): void;
}

export interface UiRuntimeFeederItem {
  readonly text: string | null;
  readonly picture: PictureAsset | undefined;
}

export interface UiRuntimeFeeder {
  count(feeder: number): number;
  item(feeder: number, index: number, column: number): UiRuntimeFeederItem | undefined | Promise<UiRuntimeFeederItem | undefined>;
  image(feeder: number, index: number): PictureAsset | undefined | Promise<PictureAsset | undefined>;
  select(feeder: number, index: number): void | Promise<void>;
}

export interface UiOwnerDrawKeyResult { readonly handled: boolean; readonly special: number }

export interface UiRuntimeOwnerDraw {
  visible(flags: number): boolean;
  width(ownerDraw: number, scale: number): number;
  value(ownerDraw: number): number;
  handleKey(ownerDraw: number, flags: number, special: number, key: number): UiOwnerDrawKeyResult | Promise<UiOwnerDrawKeyResult>;
  paint(request: UiOwnerDrawPaintRequest): void | Promise<void>;
  closeCinematic(ownerDraw: number): void;
}

export interface UiExternalScriptContext {
  readonly menuName: string | undefined;
  readonly itemName: string | undefined;
}

export interface UiScriptCursor {
  readonly position: number;
  readonly remaining: number;
  peek(): UiScriptToken | undefined;
  next(): UiScriptToken | undefined;
  /** String_Parse: undefined means no token; null means successful allocation returned NULL. */
  string(): string | null | undefined;
}

export interface UiExternalScriptHost {
  /** Mirrors displayContextDef_t.runScript(char **p), after the shared marker token was consumed. */
  run(cursor: UiScriptCursor, context: UiExternalScriptContext): void | Promise<void>;
}

export interface UiRuntimeOptions {
  readonly definitions: UiMenuDefinitions;
  readonly sourceParser?: CommonParseState;
  readonly print?: (text: string) => void;
  readonly cvarValue?: (name: string) => number;
  readonly cvars: Pick<CvarRegistry, "get" | "set" | "set2">;
  readonly commands: Pick<CommandBuffer, "append">;
  readonly resources: UiRuntimeResources;
  readonly fonts: FontSet;
  readonly widgetAssets: UiWidgetAssets;
  readonly zeroPicture: PictureAsset;
  readonly audio: UiRuntimeAudio;
  readonly cinematics: UiRuntimeCinematics;
  readonly paintModel: (request: UiModelPaintRequest) => void;
  readonly context: UiRuntimeContext;
  readonly feeder: UiRuntimeFeeder;
  readonly ownerDraw: UiRuntimeOwnerDraw;
  readonly externalScript: UiExternalScriptHost;
  readonly getTeamColor: () => Vec4;
}

export type UiRuntimeContext =
  | { readonly kind: "ui"; readonly bindings: UiRuntimeBindings; readonly pause: (paused: boolean) => void | Promise<void> }
  | { readonly kind: "cgame" };

export interface UiCapturedMenu {
  readonly definition: UiMenuDefinition;
}

export interface UiRuntimeItemSnapshot {
  readonly name: string | undefined;
  readonly group: string | undefined;
  readonly flags: number;
  readonly rect: UiRect;
  readonly clientRect: UiRect;
  readonly foreColor: Vec4;
  readonly backColor: Vec4;
  readonly borderColor: Vec4;
  readonly background: PictureAsset | undefined;
  readonly cursorPosition: number;
  readonly special: number;
  readonly enabled: boolean;
  readonly shown: boolean;
  readonly behavior: UiRuntimeItemBehaviorSnapshot;
}

export type UiRuntimeItemBehaviorSnapshot =
  | { readonly kind: "list-box"; readonly startPosition: number; readonly endPosition: number; readonly cursorPosition: number; readonly drawPadding: number }
  | { readonly kind: "edit"; readonly paintOffset: number }
  | { readonly kind: "other" };

export interface UiRuntimeMenuSnapshot {
  readonly name: string | undefined;
  readonly flags: number;
  readonly rect: UiRect;
  readonly cursorItem: number;
  readonly items: readonly UiRuntimeItemSnapshot[];
}

export interface UiRuntimeSnapshot {
  readonly focusedMenu: string | undefined;
  readonly openStack: readonly (string | undefined)[];
  readonly menus: readonly UiRuntimeMenuSnapshot[];
}

export interface UiRuntimeFrame {
  readonly time: number;
  readonly frameTime: number;
  readonly draw: Draw2D;
}

interface WindowState extends Pick<UiWindowDefinition,
  "rect" | "clientRect" | "rectEffects" | "rectEffects2" | "flags" | "foreColor" | "backColor" | "borderColor" | "nextTime" | "offsetTime" | "cinematicHandle" | "backgroundHandle" | "setBackground"> {
  readonly backgroundPath: string | null | undefined;
}

interface ItemState extends Pick<UiItemDefinition, "cursorPosition" | "special" | "textRect"> {
  definition: UiItemDefinition;
  window: WindowState;
}

interface MenuState extends Pick<UiMenuDefinition, "cursorItem"> {
  definition: UiMenuDefinition;
  window: WindowState;
  readonly itemCount: number;
  itemAt(index: number): ItemState | undefined;
  readonly captureHandle: { definition: UiMenuDefinition };
}

function* menuItems(menu: MenuState): Generator<ItemState, undefined, undefined> {
  for (let index = 0; index < menu.itemCount; index++) {
    const item = menu.itemAt(index);
    if (item === undefined) throw new Error("UI menu item dereference reached a NULL item pointer");
    yield item;
  }
  return undefined;
}

function findMenuItem(menu: MenuState, matches: (item: ItemState) => boolean): ItemState | undefined {
  for (const item of menuItems(menu)) if (matches(item)) return item;
  return undefined;
}

interface ScriptOwner {
  readonly menu: MenuState;
  readonly item: ItemState | undefined;
}

type CaptureState =
  | { readonly kind: "idle" }
  | {
    readonly kind: "list-auto" | "list-thumb" | "slider-thumb";
    readonly item: ItemState;
    readonly key: number;
    xStart: number;
    yStart: number;
  };

class RuntimeScriptCursor implements UiScriptCursor {
  private index = 0;
  private readonly cursor: CommonParseCursor;

  constructor(
    text: string,
    private readonly parser: CommonParseState,
    private readonly memory: UiMenuMemoryOwnership,
  ) { this.cursor = new CommonParseCursor(quakeString(text).slice(0, 1023)); }

  get position(): number { return this.index; }
  get remaining(): number {
    const cursor = this.lookaheadCursor(), parser = new CommonParseState();
    let count = 0;
    while (parser.parse(cursor, false).length !== 0) count++;
    return count;
  }
  private lookaheadCursor(): CommonParseCursor {
    const cursor = new CommonParseCursor(this.cursor.source);
    cursor.offset = this.cursor.offset;
    return cursor;
  }
  peek(): UiScriptToken | undefined {
    const parser = new CommonParseState();
    const text = parser.parse(this.lookaheadCursor(), false);
    return text.length === 0 ? undefined : { text, location: { path: "<UI script>", line: this.parser.line, column: 1 } };
  }

  next(): UiScriptToken | undefined {
    const text = this.parser.parse(this.cursor, false);
    if (text.length === 0) return undefined;
    this.index++;
    return { text, location: { path: "<UI script>", line: this.parser.line, column: 1 } };
  }

  rawString(): string | undefined {
    const token = this.next();
    if (token === undefined || token.text.length === 0) return undefined;
    return quakeString(token.text, token.location);
  }

  string(): string | null | undefined {
    const text = this.rawString();
    if (text === undefined || this.memory.kind === "unaccounted") return text;
    return this.memory.memory.stringAlloc(text);
  }
}

function asciiLower(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    result += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
  }
  return result;
}

function equalName(left: string | undefined, right: string): boolean {
  return left !== undefined && asciiLower(left) === asciiLower(right);
}

function resourceKey(path: string | null): string {
  return path === null ? "null" : `name:${asciiLower(quakeString(path))}`;
}

function quakeString(value: string, location?: SourceLocation): string {
  const nul = value.indexOf("\0");
  const text = nul < 0 ? value : value.slice(0, nul);
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 255) {
      const where = location === undefined ? "" : ` at ${location.path}:${location.line}:${location.column}`;
      throw new RangeError(`Quake UI text must be an 8-bit string${where}`);
    }
  }
  return text;
}

function copyRect(value: UiRect): UiRect {
  return { x: f(value.x), y: f(value.y), width: f(value.width), height: f(value.height) };
}

function copyColor(value: Vec4): Vec4 {
  return { x: f(value.x), y: f(value.y), z: f(value.z), w: f(value.w) };
}

function windowState(definition: UiWindowDefinition): WindowState {
  return {
    get rect(): UiWindowDefinition["rect"] { return definition.rect; },
    set rect(value: UiRect) { definition.rect = value; },
    get clientRect(): UiWindowDefinition["clientRect"] { return definition.clientRect; },
    set clientRect(value: UiRect) { definition.clientRect = value; },
    get rectEffects(): UiWindowDefinition["rectEffects"] { return definition.rectEffects; },
    set rectEffects(value: UiRect) { definition.rectEffects = value; },
    get rectEffects2(): UiWindowDefinition["rectEffects2"] { return definition.rectEffects2; },
    set rectEffects2(value: UiRect) { definition.rectEffects2 = value; },
    get flags(): number { return definition.flags; },
    set flags(value: number) { definition.flags = value; },
    get foreColor(): UiWindowDefinition["foreColor"] { return definition.foreColor; },
    set foreColor(value: Vec4) { definition.foreColor = value; },
    get backColor(): UiWindowDefinition["backColor"] { return definition.backColor; },
    set backColor(value: Vec4) { definition.backColor = value; },
    get borderColor(): UiWindowDefinition["borderColor"] { return definition.borderColor; },
    set borderColor(value: Vec4) { definition.borderColor = value; },
    get backgroundPath(): string | null | undefined { return definition.backgroundHandle === undefined ? definition.background?.path : undefined; },
    get nextTime(): number { return definition.nextTime; },
    set nextTime(value: number) { definition.nextTime = value; },
    get offsetTime(): number { return definition.offsetTime; },
    set offsetTime(value: number) { definition.offsetTime = value; },
    get cinematicHandle(): number { return definition.cinematicHandle; },
    set cinematicHandle(value: number) { definition.cinematicHandle = value; },
    get backgroundHandle(): number | undefined { return definition.backgroundHandle; },
    setBackground(value, handle): void { definition.setBackground(value, handle); },
  };
}

function setItemScreenCoords(item: ItemState, x: number, y: number): void {
  if (item.definition.window.border !== 0) {
    x = f(x + item.definition.window.borderSize);
    y = f(y + item.definition.window.borderSize);
  }
  item.window.rect.x = f(x + item.window.clientRect.x);
  item.window.rect.y = f(y + item.window.clientRect.y);
  item.window.rect.width = item.window.clientRect.width;
  item.window.rect.height = item.window.clientRect.height;
  item.textRect.width = 0;
  item.textRect.height = 0;
}

function updateItemPosition(item: ItemState): void {
  const parent = item.definition.parent;
  if (parent === undefined) return;
  let x = parent.window.rect.x, y = parent.window.rect.y;
  if (parent.window.border !== 0) {
    x = f(x + parent.window.borderSize);
    y = f(y + parent.window.borderSize);
  }
  setItemScreenCoords(item, x, y);
}

function populateItem(item: ItemState, definition: UiItemDefinition): void {
  item.definition = definition;
  item.window = windowState(definition.window);
}

function newItem(definition: UiItemDefinition): ItemState {
  const item: ItemState = {
    definition,
    window: windowState(definition.window),
    get cursorPosition(): number { return this.definition.cursorPosition; },
    set cursorPosition(value: number) { this.definition.cursorPosition = value; },
    get special(): number { return this.definition.special; },
    set special(value: number) { this.definition.special = value; },
    get textRect(): UiItemDefinition["textRect"] { return this.definition.textRect; },
    set textRect(value: UiRect) { this.definition.textRect = value; },
  };
  return item;
}

function populateMenu(
  menu: MenuState,
  definition: UiMenuDefinition,
): void {
  menu.definition = definition;
  menu.window = windowState(definition.window);
  menu.captureHandle.definition = definition;
}

function makeMenu(
  definition: UiMenuDefinition,
  allocateItem: (definition: UiItemDefinition) => ItemState,
): MenuState {
  const captureHandle = { definition };
  const menu: MenuState = {
    definition,
    window: windowState(definition.window),
    get itemCount(): number { return this.definition.itemCount; },
    itemAt(index): ItemState | undefined {
      const item = this.definition.itemAt(index);
      return item === undefined ? undefined : allocateItem(item);
    },
    get cursorItem(): number { return this.definition.cursorItem; },
    set cursorItem(value: number) { this.definition.cursorItem = value; },
    captureHandle,
  };
  return menu;
}

function parsedRect(cursor: RuntimeScriptCursor): UiRect | undefined {
  const x = cursor.rawString(); if (x === undefined) return undefined;
  const y = cursor.rawString(); if (y === undefined) return undefined;
  const width = cursor.rawString(); if (width === undefined) return undefined;
  const height = cursor.rawString(); if (height === undefined) return undefined;
  return { x: gameAtof(x), y: gameAtof(y), width: gameAtof(width), height: gameAtof(height) };
}

function matchesItem(item: ItemState, name: string): boolean {
  return equalName(item.definition.window.name, name) || equalName(item.definition.window.group, name);
}

const BIND_COMMANDS: readonly string[] = [
  "+scores", "+button2", "+speed", "+forward", "+back", "+moveleft", "+moveright", "+moveup", "+movedown",
  "+left", "+right", "+strafe", "+lookup", "+lookdown", "+mlook", "centerview", "+zoom",
  "weapon 1", "weapon 2", "weapon 3", "weapon 4", "weapon 5", "weapon 6", "weapon 7", "weapon 8", "weapon 9",
  "weapon 10", "weapon 11", "weapon 12", "weapon 13", "+attack", "weapprev", "weapnext", "+button3", "+button4",
  "prevTeamMember", "nextTeamMember", "nextOrder", "confirmOrder", "denyOrder", "taskOffense", "taskDefense",
  "taskPatrol", "taskCamp", "taskFollow", "taskRetrieve", "taskEscort", "taskOwnFlag", "taskSuicide",
  "tauntKillInsult", "tauntPraise", "tauntTaunt", "tauntDeathInsult", "tauntGauntlet", "scoresUp", "scoresDown",
  "messagemode", "messagemode2", "messagemode3", "messagemode4",
];

interface BindingState {
  readonly command: string;
  first: number;
  second: number;
}

function loadBindings(host: UiRuntimeBindings): BindingState[] {
  const bindings = BIND_COMMANDS.map(command => ({ command, first: -1, second: -1 }));
  for (const binding of bindings) {
    for (let key = 0; key < 256; key++) {
      if (equalName(quakeString(host.getBinding(key)).slice(0, 255), binding.command)) {
        if (binding.first === -1) binding.first = key;
        else { binding.second = key; break; }
      }
    }
  }
  return bindings;
}

function rectContains(rect: UiRect, x: number, y: number): boolean {
  return x > rect.x && x < f(rect.x + rect.width) && y > rect.y && y < f(rect.y + rect.height);
}

function isMouseKey(key: number): boolean {
  return key === KeyCode.Mouse1 || key === KeyCode.Mouse2 || key === KeyCode.Mouse3;
}

function isActivateKey(key: number): boolean {
  return isMouseKey(key) || key === KeyCode.Enter;
}

export class UiRuntime {
  private readonly menus: MenuState[] = [];
  private definitions: UiMenuDefinitions;
  private activeMenuCount: number;
  private readonly pictures: Map<string, PictureAsset | undefined>;
  private readonly sounds: Map<string, PcmSound | undefined>;
  private readonly models: Map<string, SceneModel>;
  private readonly cinematics: Map<string, UiCinematicAsset>;
  private readonly capturedMenus = new Map<UiCapturedMenu, MenuState>();
  private readonly openStack: MenuState[] = [];
  private readonly bindings: BindingState[];
  private readonly itemArena: ItemState[] = [];
  private readonly itemSlots = new Map<number, ItemState>();
  private itemAllocationPoint = 0;
  private disposed = false;
  private displayCursorX = 0;
  private displayCursorY = 0;
  private realTime = 0;
  private lastListBoxClickTime = 0;
  private editingItem: ItemState | undefined;
  private bindingItem: ItemState | undefined;
  private waitingForKey = false;
  private capture: CaptureState = { kind: "idle" };
  private nextScrollTime = 0;
  private nextScrollAdjustTime = 0;
  private scrollAdjustValue = 0;
  private debug = false;
  private readonly sourceParser: CommonParseState;

  private constructor(
    private readonly options: UiRuntimeOptions,
    pictures: Map<string, PictureAsset | undefined>,
    sounds: Map<string, PcmSound | undefined>,
    models: Map<string, SceneModel>,
    cinematics: Map<string, UiCinematicAsset>,
  ) {
    this.sourceParser = options.sourceParser ?? new CommonParseState();
    this.definitions = options.definitions;
    for (const definition of options.definitions.menus) this.menus.push(makeMenu(definition, item => this.allocateItem(item)));
    this.activeMenuCount = this.menus.length;
    this.pictures = pictures;
    this.sounds = sounds;
    this.models = models;
    this.cinematics = cinematics;
    this.bindings = options.context.kind === "ui"
      ? loadBindings(options.context.bindings)
      : BIND_COMMANDS.map(command => ({ command, first: -1, second: -1 }));
    for (const menu of this.activeMenus()) {
      this.capturedMenus.set(menu.captureHandle, menu);
      for (let index = 0; index < menu.itemCount; index++) menu.itemAt(index);
    }
  }

  static async create(options: UiRuntimeOptions): Promise<UiRuntime> {
    const pictures = new Map<string, PictureAsset | undefined>();
    const sounds = new Map<string, PcmSound | undefined>();
    const models = new Map<string, SceneModel>();
    const cinematics = new Map<string, UiCinematicAsset>();
    for (const event of options.definitions.registration.events) {
      await UiRuntime.resolveRegistration(options, options.definitions.registration.kind === "completed", event, pictures, sounds, models);
    }
    for (const menu of options.definitions.menus) {
      await UiRuntime.cacheWindowCinematic(options, menu.window, cinematics);
      for (const item of menu.items) await UiRuntime.cacheWindowCinematic(options, item.window, cinematics);
    }
    return new UiRuntime(options, pictures, sounds, models, cinematics);
  }

  private static async resolveRegistration(
    options: UiRuntimeOptions,
    completed: boolean,
    event: UiMenuRegistrationEvent,
    pictures: Map<string, PictureAsset | undefined>,
    sounds: Map<string, PcmSound | undefined>,
    models: Map<string, SceneModel>,
  ): Promise<void> {
    switch (event.kind) {
      case "font":
        if (!completed) await options.resources.registerFont(event.reference.path, event.reference.pointSize);
        return;
      case "picture": {
        const picture = completed
          ? options.resources.registeredPicture(event.reference.path)
          : await options.resources.registerPicture(event.reference.path);
        pictures.set(resourceKey(event.reference.path), picture);
        return;
      }
      case "sound": {
        const sound = completed
          ? options.resources.registeredSound(event.reference.path)
          : await options.resources.registerSound(event.reference.path);
        sounds.set(resourceKey(event.reference.path), sound);
        return;
      }
      case "model": {
        const model = completed
          ? options.resources.registeredModel(event.reference.path)
          : await options.resources.registerModel(event.reference.path);
        if (model === undefined) throw new Error(`Completed UI model registration is missing ${event.reference.path}`);
        models.set(resourceKey(event.reference.path), model);
      }
    }
  }

  private static async cacheWindowCinematic(
    options: UiRuntimeOptions,
    window: UiWindowDefinition,
    cinematics: Map<string, UiCinematicAsset>,
  ): Promise<void> {
    if (window.cinematic === undefined) return;
    cinematics.set(window.cinematic, await options.resources.prepareCinematic(window.cinematic));
  }

  resetDefinitions(reset: "menus" | "strings"): void {
    this.opened();
    this.activeMenuCount = 0;
    if (reset === "strings") {
      this.itemAllocationPoint = 0;
      this.openStack.length = 0;
      if (this.options.context.kind === "ui") this.reloadBindings();
    }
  }

  acceptMenuRegistration(event: UiMenuRegistrationEvent): void {
    this.opened();
    const key = resourceKey(event.reference.path);
    switch (event.kind) {
      case "font": return;
      case "picture": this.pictures.set(key, this.options.resources.registeredPicture(event.reference.path)); return;
      case "sound": this.sounds.set(key, this.options.resources.registeredSound(event.reference.path)); return;
      case "model": {
        const model = this.options.resources.registeredModel(event.reference.path);
        if (model === undefined) throw new Error(`Completed UI model registration is missing ${event.reference.path}`);
        this.models.set(key, model); return;
      }
    }
  }

  publishMenuAsset(event: UiMenuAssetPublication): void {
    this.opened();
    if (event.field === "cursorStr") return;
    if (event.field === "fontRegistered") {
      this.definitions = { ...this.definitions, fontRegistered: event.value }; return;
    }
    const assets = this.definitions.assets;
    if (event.field === "shadowColorComponent") {
      this.definitions = { ...this.definitions, assets: { ...assets, shadowColor: { ...assets.shadowColor, [event.component]: event.value } } };
    } else this.definitions = { ...this.definitions, assets: { ...assets, [event.field]: event.value } };
  }

  async appendMenu(definition: UiMenuDefinition, memory: UiMenuMemoryOwnership): Promise<void> {
    this.opened();
    this.assertMenuMemory(memory);
    if (this.activeMenuCount >= MAX_UI_MENUS) throw new RangeError("UI menu publication exceeds the source static menu array");
    const index = this.activeMenuCount;
    await UiRuntime.cacheWindowCinematic(this.options, definition.window, this.cinematics);
    this.opened();
    for (const item of definition.items) {
      await UiRuntime.cacheWindowCinematic(this.options, item.window, this.cinematics);
      this.opened();
    }
    if (this.activeMenuCount !== index) throw new Error("UI menu publication was interrupted by another menu load");
    const allocateItem = (item: UiItemDefinition): ItemState => this.allocateItem(item);
    let menu = this.menus[index];
    if (menu === undefined) {
      menu = makeMenu(definition, allocateItem);
      this.menus.push(menu); this.capturedMenus.set(menu.captureHandle, menu);
    } else populateMenu(menu, definition);
    if (memory.kind === "unaccounted") for (const item of definition.items) this.allocateItem(item);
    this.activeMenuCount++;
    this.definitions = { ...this.definitions, menus: this.activeMenus().map(active => active.definition) };
  }

  assertMenuMemory(nextMemory: UiMenuMemoryOwnership): void {
    this.opened();
    const previousMemory = this.definitions.memory;
    if (previousMemory.kind !== nextMemory.kind || previousMemory.kind === "qvm32" && nextMemory.kind === "qvm32"
      && previousMemory.memory !== nextMemory.memory) throw new Error("UI reload cannot replace its source memory owner");
  }

  async reloadDefinitions(definitions: UiMenuDefinitions): Promise<void> {
    this.opened();
    this.assertMenuMemory(definitions.memory);
    const completed = definitions.registration.kind === "completed";
    for (const event of definitions.registration.events) {
      await UiRuntime.resolveRegistration(this.options, completed, event, this.pictures, this.sounds, this.models);
    }
    for (const definition of definitions.menus) {
      await UiRuntime.cacheWindowCinematic(this.options, definition.window, this.cinematics);
      for (const item of definition.items) {
        await UiRuntime.cacheWindowCinematic(this.options, item.window, this.cinematics);
      }
    }
    const allocateItem = (definition: UiItemDefinition): ItemState => this.allocateItem(definition);
    this.definitions = definitions;
    for (let index = 0; index < definitions.menus.length; index++) {
      const definition = definitions.menus[index];
      if (definition === undefined) continue;
      const existing = this.menus[index];
      if (existing === undefined) {
        const menu = makeMenu(definition, allocateItem);
        this.menus.push(menu);
        this.capturedMenus.set(menu.captureHandle, menu);
      } else {
        populateMenu(existing, definition);
      }
      if (definitions.memory.kind === "unaccounted") for (const item of definition.items) this.allocateItem(item);
    }
    this.activeMenuCount = definitions.menus.length;
  }

  async activate(name: string | null | (() => string)): Promise<boolean> {
    this.opened();
    const focus = this.focusedMenu();
    let activated: MenuState | undefined;
    for (const menu of this.liveMenus()) {
      // Q_stricmp does not read its second buffer when the menu name is NULL.
      const requested = menu.definition.window.name === undefined || name === null
        ? null : quakeString(typeof name === "function" ? name() : name);
      if (requested !== null && equalName(menu.definition.window.name, requested)) {
        activated = menu;
        await this.activateMenu(menu);
        if (focus !== undefined && this.openStack.length < MAX_OPEN_MENUS) this.openStack.push(focus);
      } else {
        menu.window.flags &= ~UiWindowFlag.HasFocus;
      }
    }
    this.closeCinematics();
    return activated !== undefined;
  }

  async show(name: string): Promise<boolean> {
    this.opened();
    const menu = this.findMenu(name);
    if (menu === undefined) return false;
    await this.activateMenu(menu);
    return true;
  }

  async close(name: string): Promise<boolean> {
    this.opened();
    const menu = this.findMenu(name);
    if (menu === undefined) return false;
    await this.closeMenu(menu);
    return true;
  }

  async closeAll(): Promise<void> {
    this.opened();
    for (const menu of this.liveMenus()) await this.closeMenu(menu);
  }

  anyFullScreenVisible(): boolean {
    this.opened();
    return this.activeMenus().some(menu => (menu.window.flags & UiWindowFlag.Visible) !== 0 && menu.definition.fullScreen !== 0);
  }

  async pointerMove(x: number, y: number): Promise<boolean> {
    this.opened();
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError("UI pointer coordinates must be finite");
    const pointerX = f(x);
    const pointerY = f(y);
    const focused = this.focusedMenu();
    if (focused !== undefined && (focused.window.flags & UiWindowFlag.Popup) !== 0) {
      await this.mouseMoveMenu(focused, pointerX, pointerY);
      return true;
    }
    for (const menu of this.liveMenus()) await this.mouseMoveMenu(menu, pointerX, pointerY);
    return true;
  }

  setDisplayCursor(x: number, y: number): void {
    this.opened();
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError("UI display cursor coordinates must be finite");
    this.displayCursorX = f(x);
    this.displayCursorY = f(y);
  }

  async handleKey(event: UiKeyEvent, x: number, y: number): Promise<boolean> {
    this.opened();
    const key = event.code;
    if (!Number.isInteger(key) || key < 0 || key > 0x7fff) throw new RangeError("UI key code must be an integer in 0..32767");
    if (event.kind === "character" && key > 255) throw new RangeError("UI character code must fit one byte");
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError("UI key coordinates must be finite");
    const menu = this.menuAt(f(x), f(y)) ?? this.focusedMenu();
    if (menu === undefined) return false;
    return this.handleMenuKey(menu, event.kind === "character" ? key | KEY_CHAR_FLAG : key, event.kind === "character" || event.down);
  }

  focusedMenuHandle(): UiCapturedMenu | undefined {
    this.opened();
    return this.focusedMenu()?.captureHandle;
  }

  async handleCapturedKey(handle: UiCapturedMenu, event: UiKeyEvent): Promise<boolean> {
    this.opened();
    const menu = this.capturedMenu(handle), key = event.code;
    if (!Number.isInteger(key) || key < 0 || key > 0x7fff) throw new RangeError("UI key code must be an integer in 0..32767");
    if (event.kind === "character" && key > 255) throw new RangeError("UI character code must fit one byte");
    return this.handleMenuKey(menu, event.kind === "character" ? key | KEY_CHAR_FLAG : key, event.kind === "character" || event.down);
  }

  async frame(frame: UiRuntimeFrame, framesPerSecond = 0): Promise<void> {
    this.opened();
    this.setFrameTime(frame);
    await this.runCapture();
    for (const menu of this.liveMenus()) await this.paintMenu(menu, frame.draw, false);
    if (this.debug) textPaint(frame.draw, this.options.fonts, { x: 5, y: 25, scale: 0.5,
      color: { x: 1, y: 1, z: 1, w: 1 }, text: gameFormat("fps: %f", [f(framesPerSecond)]), adjust: 0, limit: 0, style: 0 });
  }

  /** Display_CacheAll registers reached sounds and plays/stops each window movie without changing its state. */
  async cacheAll(): Promise<void> {
    this.opened();
    const cacheWindow = async (definition: UiWindowDefinition): Promise<void> => {
      const path = definition.cinematic;
      if (path === undefined) return;
      const asset = await this.cinematicAsset(path); this.opened();
      const instance = this.options.cinematics.play(asset, { x: 0, y: 0, width: 0, height: 0 }); this.opened();
      this.options.cinematics.stop(instance?.handle.index ?? -1); this.opened();
    };
    for (const menu of this.liveMenus()) {
      await cacheWindow(menu.definition.window); this.opened();
      for (const item of menuItems(menu)) { await cacheWindow(item.definition.window); this.opened(); }
      const sound = menu.definition.soundLoop;
      if (sound !== undefined && sound.path !== null && quakeString(sound.path).length > 0) {
        await this.options.resources.registerSound(sound.path); this.opened();
      }
    }
  }

  setDisplayTime(time: number): void {
    this.opened();
    if (!Number.isInteger(time) || time < -0x8000_0000 || time > 0x7fff_ffff) throw new RangeError("UI time must be a signed 32-bit millisecond value");
    this.realTime = time;
  }

  async paintNamed(name: string, frame: UiRuntimeFrame, force: boolean): Promise<boolean> {
    this.opened();
    this.setFrameTime(frame);
    const menu = this.findMenu(name);
    if (menu === undefined) return false;
    await this.paintMenu(menu, frame.draw, force);
    return true;
  }

  async paintCaptured(handle: UiCapturedMenu, frame: UiRuntimeFrame, force: boolean): Promise<void> {
    this.opened();
    this.setFrameTime(frame);
    await this.paintMenu(this.capturedMenu(handle), frame.draw, force);
  }

  clearForced(name: string): boolean {
    this.opened();
    const menu = this.findMenu(name);
    if (menu === undefined) return false;
    menu.window.flags &= ~UiWindowFlag.Forced;
    return true;
  }

  clearCapturedForced(handle: UiCapturedMenu): void {
    this.opened();
    this.capturedMenu(handle).window.flags &= ~UiWindowFlag.Forced;
  }

  menuHandle(name: string): UiCapturedMenu | undefined {
    this.opened();
    return this.findMenu(name)?.captureHandle;
  }

  captureMenu(x: number, y: number): UiCapturedMenu | undefined {
    this.opened();
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError("UI capture coordinates must be finite");
    return this.menuAt(f(x), f(y))?.captureHandle;
  }

  hitTestMenu(handle: UiCapturedMenu, x: number, y: number): UiItemDefinition | undefined {
    this.opened();
    const menu = this.capturedMenu(handle);
    return findMenuItem(menu, item => rectContains(item.window.rect, f(x), f(y)))?.definition;
  }

  setItemMouseOver(item: UiItemDefinition | null, focused: boolean): void {
    this.opened();
    if (item === null) return;
    if (focused) item.window.flags |= UiWindowFlag.MouseOver;
    else item.window.flags &= ~UiWindowFlag.MouseOver;
  }

  paintItemImage(item: UiItemDefinition | null, draw: Draw2D): void {
    this.opened();
    if (item === null) return;
    const rect = item.window.rect, handle = item.assetHandle;
    let picture: PictureAsset | (() => PictureAsset) = this.options.zeroPicture;
    if (handle !== undefined && handle !== 0) picture = () => this.sourceHandles().pictureForHandle(handle) ?? this.options.zeroPicture;
    else if (handle === undefined && item.asset !== undefined) {
      if (item.asset.kind !== "shader") throw new Error("Item_Image_Paint needs the source numeric handle for a model asset");
      picture = this.picture(item.asset.path) ?? this.options.zeroPicture;
    }
    draw.drawHandlePic({ x: f(rect.x + 1), y: f(rect.y + 1), width: f(rect.width - 2), height: f(rect.height - 2) }, picture);
  }

  moveCapturedMenu(handle: UiCapturedMenu, deltaX: number, deltaY: number): void {
    this.opened();
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new RangeError("UI captured-menu delta must be finite");
    const menu = this.capturedMenu(handle);
    menu.window.rect.x = f(menu.window.rect.x + f(deltaX));
    menu.window.rect.y = f(menu.window.rect.y + f(deltaY));
    let x = menu.window.rect.x, y = menu.window.rect.y;
    if (menu.definition.window.border !== 0) {
      x = f(x + menu.definition.window.borderSize);
      y = f(y + menu.definition.window.borderSize);
    }
    for (let index = 0; index < menu.itemCount; index++) {
      const item = menu.itemAt(index);
      if (item !== undefined) setItemScreenCoords(item, x, y);
    }
  }

  async setFeederSelection(feeder: number, index: number, menuName?: string): Promise<void> {
    this.opened();
    if (!Number.isFinite(feeder) || !Number.isInteger(index)) throw new RangeError("Invalid feeder selection");
    const menu = menuName === undefined ? this.focusedMenu() : this.findMenu(menuName);
    if (menu === undefined) return;
    await this.selectFeeder(menu, feeder, index);
  }

  async setCapturedFeederSelection(handle: UiCapturedMenu, feeder: number, index: number): Promise<void> {
    this.opened();
    if (!Number.isFinite(feeder) || !Number.isInteger(index)) throw new RangeError("Invalid feeder selection");
    await this.selectFeeder(this.capturedMenu(handle), feeder, index);
  }

  private async selectFeeder(menu: MenuState, feeder: number, index: number): Promise<void> {
    const item = findMenuItem(menu, candidate => candidate.special === f(feeder));
    if (item === undefined) return;
    if (index === 0) {
      const list = item.definition.listData();
      if (list === undefined) throw new Error("Menu_SetFeederSelection dereferences NULL list data");
      list.cursorPosition = 0;
      list.startPosition = 0;
    }
    item.cursorPosition = index | 0;
    await this.options.feeder.select(item.special, item.cursorPosition); this.opened();
  }

  async scrollFeeder(feeder: number, down: boolean, menuName?: string): Promise<void> {
    this.opened();
    const menu = menuName === undefined ? this.focusedMenu() : this.findMenu(menuName);
    if (menu === undefined) return;
    const item = findMenuItem(menu, candidate => candidate.special === f(feeder));
    if (item !== undefined) await this.handleListKey(item, down ? KeyCode.Down : KeyCode.Up, true);
  }

  async scrollCapturedFeeder(handle: UiCapturedMenu, feeder: number, down: boolean): Promise<void> {
    this.opened();
    const item = findMenuItem(this.capturedMenu(handle), candidate => candidate.special === f(feeder));
    if (item !== undefined) await this.handleListKey(item, down ? KeyCode.Down : KeyCode.Up, true);
  }

  bindingPending(): boolean { this.opened(); return this.waitingForKey; }

  reloadBindings(): void {
    this.opened();
    const loaded = loadBindings(this.bindingHost("reload bindings"));
    for (let index = 0; index < this.bindings.length; index++) {
      const target = this.bindings[index], source = loaded[index];
      if (target !== undefined && source !== undefined) { target.first = source.first; target.second = source.second; }
    }
  }

  resetBindings(): void {
    this.opened();
    for (const binding of this.bindings) { binding.first = -1; binding.second = -1; }
  }

  applyBindings(): void { this.opened(); this.writeBindings(); }

  cursorType(x: number, y: number): "arrow" | "sizer" {
    this.opened();
    for (const menu of this.activeMenus()) {
      if (rectContains({ x: f(menu.window.rect.x - 3), y: f(menu.window.rect.y - 3), width: 7, height: 7 }, x, y)) return "sizer";
    }
    return "arrow";
  }

  async runMenuScript(menuName: string, script: UiScript): Promise<void> {
    this.opened();
    const menu = this.findMenu(menuName);
    if (menu === undefined) throw new Error(`Unknown UI menu ${menuName}`);
    await this.runScript({ menu, item: undefined }, script);
  }

  async runItemScript(menuName: string, itemName: string, script: UiScript): Promise<void> {
    this.opened();
    const menu = this.findMenu(menuName);
    if (menu === undefined) throw new Error(`Unknown UI menu ${menuName}`);
    const item = findMenuItem(menu, candidate => equalName(candidate.definition.window.name, itemName));
    if (item === undefined) throw new Error(`Unknown UI item ${itemName} in ${menuName}`);
    await this.runScript({ menu, item }, script);
  }

  menuCount(): number {
    this.opened();
    return this.activeMenuCount;
  }

  snapshot(): UiRuntimeSnapshot {
    this.opened();
    const focused = this.focusedMenu();
    return Object.freeze({
      focusedMenu: focused?.definition.window.name,
      openStack: Object.freeze(this.openStack.map(menu => menu.definition.window.name)),
      menus: Object.freeze(this.activeMenus().map(menu => Object.freeze({
        name: menu.definition.window.name,
        flags: menu.window.flags,
        rect: copyRect(menu.window.rect),
        cursorItem: menu.cursorItem,
        items: Object.freeze(Array.from(menuItems(menu), item => Object.freeze({
          name: item.definition.window.name,
          group: item.definition.window.group,
          flags: item.window.flags,
          rect: copyRect(item.window.rect),
          clientRect: copyRect(item.window.clientRect),
          foreColor: copyColor(item.window.foreColor),
          backColor: copyColor(item.window.backColor),
          borderColor: copyColor(item.window.borderColor),
          background: this.windowPicture(item.window),
          cursorPosition: item.cursorPosition,
          special: item.special,
          enabled: this.itemPassesCvar(item, "enable"),
          shown: this.itemPassesCvar(item, "show"),
          behavior: this.behaviorSnapshot(item),
        }))),
      }))),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.closeCinematics();
    this.retire();
  }

  /** Managed VM release does not call engine-owned cinematic or global music traps. */
  retire(): void {
    this.disposed = true;
    this.capture = { kind: "idle" };
    this.editingItem = undefined;
    this.bindingItem = undefined;
    this.waitingForKey = false;
  }

  private opened(): void {
    if (this.disposed) throw new Error("UI runtime is disposed");
  }

  private activeMenus(): readonly MenuState[] {
    return this.menus.slice(0, this.activeMenuCount);
  }

  private *liveMenus(): Generator<MenuState, undefined, undefined> {
    for (let index = 0; index < this.activeMenuCount; index++) {
      const menu = this.menus[index];
      if (menu === undefined) throw new Error("UI menu traversal reached an uninitialized static slot");
      yield menu;
    }
    return undefined;
  }

  private capturedMenu(handle: UiCapturedMenu): MenuState {
    const menu = this.capturedMenus.get(handle);
    if (menu === undefined) throw new Error("UI captured-menu handle does not belong to this runtime");
    return menu;
  }

  private allocateItem(definition: UiItemDefinition): ItemState {
    const offset = definition.allocationOffset;
    if (offset !== undefined) {
      const previous = this.itemSlots.get(offset);
      if (previous !== undefined) {
        if (previous.definition !== definition) populateItem(previous, definition);
        return previous;
      }
      const item = newItem(definition);
      this.itemArena.push(item);
      this.itemSlots.set(offset, item);
      return item;
    }
    const knownIndex = this.itemArena.findIndex(item => item.definition === definition);
    const known = this.itemArena[knownIndex];
    if (known !== undefined) {
      this.itemAllocationPoint = Math.max(this.itemAllocationPoint, knownIndex + 1);
      return known;
    }
    const allocation = this.itemAllocationPoint++;
    const previous = this.itemArena[allocation];
    if (previous === undefined) {
      const item = newItem(definition);
      this.itemArena.push(item);
      return item;
    }
    populateItem(previous, definition);
    return previous;
  }

  private setFrameTime(frame: UiRuntimeFrame): void {
    if (!Number.isInteger(frame.frameTime) || frame.frameTime < -0x8000_0000 || frame.frameTime > 0x7fff_ffff) throw new RangeError("UI frameTime must be a signed 32-bit value");
    this.setDisplayTime(frame.time);
  }

  private bindingHost(operation: string): UiRuntimeBindings {
    const context = this.options.context;
    if (context.kind === "cgame") throw new Error(`UI ${operation} is unavailable in cgame context`);
    return context.bindings;
  }

  private findMenu(name: string): MenuState | undefined {
    const requested = quakeString(name);
    return this.activeMenus().find(menu => equalName(menu.definition.window.name, requested));
  }

  private focusedMenu(): MenuState | undefined {
    return this.activeMenus().find(menu =>
      (menu.window.flags & UiWindowFlag.HasFocus) !== 0 && (menu.window.flags & UiWindowFlag.Visible) !== 0,
    );
  }

  private async activateMenu(menu: MenuState): Promise<void> {
    menu.window.flags |= UiWindowFlag.HasFocus | UiWindowFlag.Visible;
    if (menu.definition.onOpen !== undefined) await this.runScript({ menu, item: undefined }, menu.definition.onOpen);
    const loop = menu.definition.soundLoop;
    if (loop !== undefined) await this.startBackground(loop.path);
    this.closeCinematics();
  }

  private async closeMenu(menu: MenuState): Promise<void> {
    if ((menu.window.flags & UiWindowFlag.Visible) !== 0 && menu.definition.onClose !== undefined) {
      await this.runScript({ menu, item: undefined }, menu.definition.onClose);
    }
    menu.window.flags &= ~(UiWindowFlag.Visible | UiWindowFlag.HasFocus);
  }

  private closeCinematics(): void {
    for (const menu of this.liveMenus()) {
      if (menu.definition.window.style === 5) this.closeWindowCinematic(menu.window);
      for (const item of menuItems(menu)) {
        if (item.definition.window.style === 5) this.closeWindowCinematic(item.window);
        if (item.definition.behavior.kind === "owner-draw") this.options.ownerDraw.closeCinematic(-item.definition.window.ownerDraw);
      }
    }
  }

  private closeWindowCinematic(window: WindowState): void {
    if (window.cinematicHandle >= 0) {
      this.options.cinematics.stop(window.cinematicHandle);
      window.cinematicHandle = -1;
    }
  }

  private sourceHandles(): Extract<UiRuntimeResources["handles"], { readonly kind: "source" }> {
    const handles = this.options.resources.handles;
    if (handles.kind === "diagnostic") throw new Error("Numeric UI resource use requires the actual source handle owners");
    return handles;
  }

  private windowPicture(window: WindowState): PictureAsset | undefined {
    const handle = window.backgroundHandle;
    if (handle !== undefined) return handle === 0 ? undefined : this.sourceHandles().pictureForHandle(handle);
    const path = window.backgroundPath;
    return path === undefined ? undefined : this.picture(path);
  }

  private hasWindowBackground(window: WindowState): boolean {
    const handle = window.backgroundHandle;
    return handle === undefined ? this.windowPicture(window) !== undefined : handle !== 0;
  }

  private picture(path: string | null): PictureAsset | undefined {
    return this.pictures.get(resourceKey(path));
  }

  private sound(path: string | null): PcmSound | undefined {
    return this.sounds.get(resourceKey(path));
  }

  private async startBackground(path: string | null): Promise<void> {
    await this.options.audio.startBackground(path);
    this.opened();
  }

  private async runScript(owner: ScriptOwner, script: UiScript): Promise<void> {
    if (script.text.length === 0) return;
    const cursor = new RuntimeScriptCursor(script.text, this.sourceParser, this.definitions.memory);
    while (true) {
      const command = cursor.string();
      if (command === undefined) return;
      if (command === null) throw new Error("Item_RunScript dereferences NULL command after String_Alloc");
      if (command === ";") continue;
      if (!await this.runSharedCommand(owner, asciiLower(command), cursor)) {
        await this.options.externalScript.run(cursor, {
          menuName: this.scriptMenu(owner)?.definition.window.name,
          itemName: owner.item?.definition.window.name,
        });
      }
    }
  }

  private async runSharedCommand(owner: ScriptOwner, command: string, cursor: RuntimeScriptCursor): Promise<boolean> {
    switch (command) {
      case "fadein": this.scriptFade(owner, cursor, false); return true;
      case "fadeout": this.scriptFade(owner, cursor, true); return true;
      case "show": this.scriptShow(owner, cursor, true); return true;
      case "hide": this.scriptShow(owner, cursor, false); return true;
      case "setcolor": this.scriptSetColor(owner.item, cursor); return true;
      case "open": await this.scriptOpen(cursor); return true;
      case "conditionalopen": await this.scriptConditionalOpen(cursor); return true;
      case "close": await this.scriptClose(cursor); return true;
      case "setasset": cursor.string(); return true;
      case "setbackground": await this.scriptSetBackground(owner.item, cursor); return true;
      case "setitemcolor": this.scriptSetItemColor(owner, cursor); return true;
      case "setteamcolor": this.scriptSetTeamColor(owner.item); return true;
      case "setfocus": await this.scriptSetFocus(owner, cursor); return true;
      case "setplayermodel": this.scriptSetCvar(cursor, "team_model"); return true;
      case "setplayerhead": this.scriptSetCvar(cursor, "team_headmodel"); return true;
      case "transition": this.scriptTransition(owner, cursor); return true;
      case "setcvar": this.scriptSetCvar(cursor); return true;
      case "exec": this.scriptExec(cursor); return true;
      case "play": await this.scriptPlay(cursor); return true;
      case "playlooped": await this.scriptPlayLooped(cursor); return true;
      case "orbit": this.scriptOrbit(owner, cursor); return true;
      default: return false;
    }
  }

  private scriptMenu(owner: ScriptOwner): MenuState | undefined {
    return owner.item === undefined ? owner.menu : this.parentMenu(owner.item);
  }

  private itemsMatchingGroup(menu: MenuState | undefined, name: string | null): number {
    if (menu === undefined) throw new Error("Menu_ItemsMatchingGroup dereferences a NULL parent menu");
    let count = 0;
    for (const item of menuItems(menu)) if (name !== null && matchesItem(item, name)) count++;
    return count;
  }

  private matchingItem(menu: MenuState | undefined, name: string | null, match: number): ItemState | undefined {
    if (menu === undefined) throw new Error("Menu_GetMatchingItemByNumber dereferences a NULL parent menu");
    let index = 0;
    for (const item of menuItems(menu)) {
      if (name === null || !matchesItem(item, name)) continue;
      if (index++ === match) return item;
    }
    return undefined;
  }

  private *matching(menu: MenuState | undefined, name: string | null): Generator<ItemState, undefined, undefined> {
    const count = this.itemsMatchingGroup(menu, name);
    for (let match = 0; match < count; match++) {
      const item = this.matchingItem(menu, name, match);
      if (item !== undefined) yield item;
    }
    return undefined;
  }

  private scriptShow(owner: ScriptOwner, cursor: RuntimeScriptCursor, visible: boolean): void {
    const name = cursor.string();
    if (name === undefined) return;
    for (const item of this.matching(this.scriptMenu(owner), name)) {
      if (visible) item.window.flags |= UiWindowFlag.Visible;
      else { item.window.flags &= ~UiWindowFlag.Visible; this.closeWindowCinematic(item.window); }
    }
  }

  private scriptFade(owner: ScriptOwner, cursor: RuntimeScriptCursor, fadeOut: boolean): void {
    const name = cursor.string();
    if (name === undefined) return;
    for (const item of this.matching(this.scriptMenu(owner), name)) {
      if (fadeOut) {
        item.window.flags |= UiWindowFlag.FadingOut | UiWindowFlag.Visible;
        item.window.flags &= ~UiWindowFlag.FadingIn;
      } else {
        item.window.flags |= UiWindowFlag.Visible | UiWindowFlag.FadingIn;
        item.window.flags &= ~UiWindowFlag.FadingOut;
      }
    }
  }

  private scriptSetColor(item: ItemState | undefined, cursor: RuntimeScriptCursor): void {
    const target = cursor.string();
    if (target === undefined || target === null) return;
    const name = asciiLower(target);
    if (name !== "backcolor" && name !== "forecolor" && name !== "bordercolor") return;
    const field = name === "backcolor" ? "backColor" : name === "forecolor" ? "foreColor" : "borderColor";
    if (item !== undefined) {
      if (name === "backcolor") item.window.flags |= UiWindowFlag.BackColorSet;
      else if (name === "forecolor") item.window.flags |= UiWindowFlag.ForeColorSet;
    }
    const components: readonly (keyof Vec4)[] = ["x", "y", "z", "w"];
    for (const component of components) {
      const value = cursor.rawString(); if (value === undefined) return;
      if (item !== undefined) item.window[field][component] = gameAtof(value);
    }
  }

  private async scriptOpen(cursor: RuntimeScriptCursor): Promise<void> {
    const name = cursor.string();
    if (name !== undefined) await this.activate(name);
  }

  private async scriptConditionalOpen(cursor: RuntimeScriptCursor): Promise<void> {
    const cvar = cursor.string(); if (cvar === undefined) return;
    const first = cursor.string(); if (first === undefined) return;
    const second = cursor.string(); if (second === undefined) return;
    if (cvar === null) throw new Error("Cvar_VariableValue hashes NULL in Cvar_FindVar");
    const value = this.cvarValue(cvar);
    const selected = value === 0 ? second : first;
    await this.activate(selected);
  }

  private async scriptClose(cursor: RuntimeScriptCursor): Promise<void> {
    const name = cursor.string();
    if (name !== undefined && name !== null) await this.close(name);
  }

  private async scriptSetBackground(item: ItemState | undefined, cursor: RuntimeScriptCursor): Promise<void> {
    const path = cursor.string();
    if (path === undefined) return;
    const background = await this.options.resources.registerPicture(path);
    if (item !== undefined) {
      const handles = this.options.resources.handles;
      item.window.setBackground({ kind: "shader", path }, handles.kind === "source" ? handles.pictureHandle(background) : undefined);
    }
    this.pictures.set(resourceKey(path), background);
  }

  private scriptSetItemColor(owner: ScriptOwner, cursor: RuntimeScriptCursor): void {
    const itemName = cursor.string(); if (itemName === undefined) return;
    const target = cursor.string(); if (target === undefined) return;
    const count = this.itemsMatchingGroup(this.scriptMenu(owner), itemName);
    const x = cursor.rawString(); if (x === undefined) return;
    const y = cursor.rawString(); if (y === undefined) return;
    const z = cursor.rawString(); if (z === undefined) return;
    const w = cursor.rawString(); if (w === undefined) return;
    const color = { x: gameAtof(x), y: gameAtof(y), z: gameAtof(z), w: gameAtof(w) };
    if (target === null) return;
    const name = asciiLower(target);
    for (let match = 0; match < count; match++) {
      const item = this.matchingItem(this.scriptMenu(owner), itemName, match);
      if (item === undefined) continue;
      if (name === "backcolor") item.window.backColor = copyColor(color);
      else if (name === "forecolor") {
        item.window.flags |= UiWindowFlag.ForeColorSet;
        item.window.foreColor = copyColor(color);
      } else if (name === "bordercolor") item.window.borderColor = copyColor(color);
    }
  }

  private scriptSetTeamColor(item: ItemState | undefined): void {
    const color = this.options.getTeamColor();
    if (item !== undefined) item.window.backColor = copyColor(color);
  }

  private async clearFocus(menu: MenuState | undefined): Promise<ItemState | undefined> {
    if (menu === undefined) return undefined;
    let previous: ItemState | undefined;
    for (const item of menuItems(menu)) {
      if ((item.window.flags & UiWindowFlag.HasFocus) !== 0) previous = item;
      item.window.flags &= ~UiWindowFlag.HasFocus;
      if (item.definition.leaveFocus !== undefined) await this.runScript({ menu, item }, item.definition.leaveFocus);
    }
    return previous;
  }

  private async scriptSetFocus(owner: ScriptOwner, cursor: RuntimeScriptCursor): Promise<void> {
    const name = cursor.string();
    if (name === undefined || name === null) return;
    const menu = this.scriptMenu(owner);
    if (menu === undefined) return;
    const item = findMenuItem(menu, candidate => equalName(candidate.definition.window.name, name));
    if (item === undefined || (item.window.flags & UiWindowFlag.Decoration) !== 0 || (item.window.flags & UiWindowFlag.HasFocus) !== 0) return;
    await this.clearFocus(this.scriptMenu(owner));
    item.window.flags |= UiWindowFlag.HasFocus;
    if (item.definition.onFocus !== undefined) await this.runScript({ menu, item }, item.definition.onFocus);
    const globalPath = this.definitions.assets.itemFocusSound?.path;
    const globalSound = globalPath === undefined ? undefined : this.sound(globalPath);
    if (globalSound !== undefined) this.options.audio.playLocal(globalSound);
  }

  private scriptSetCvar(cursor: RuntimeScriptCursor, fixedName?: string): void {
    const name = fixedName ?? cursor.string();
    if (name === undefined) return;
    const value = cursor.string();
    if (value === undefined) return;
    if (value === null) this.options.cvars.set2(name, null, true);
    else this.options.cvars.set2(name, value, true);
  }

  private scriptExec(cursor: RuntimeScriptCursor): void {
    const value = cursor.string();
    if (value !== undefined) this.executeText(gameFormat("%s ; ", [value]));
  }

  private async scriptPlay(cursor: RuntimeScriptCursor): Promise<void> {
    const path = cursor.string();
    if (path !== undefined) {
      const sound = await this.options.resources.registerSound(path);
      this.sounds.set(resourceKey(path), sound);
      this.options.audio.playLocal(sound);
    }
  }

  private async scriptPlayLooped(cursor: RuntimeScriptCursor): Promise<void> {
    const path = cursor.string();
    if (path === undefined) return;
    this.options.audio.stopBackground();
    this.opened();
    await this.startBackground(path);
  }

  private scriptTransition(owner: ScriptOwner, cursor: RuntimeScriptCursor): void {
    const name = cursor.string();
    if (name === undefined) return;
    const from = parsedRect(cursor); if (from === undefined) return;
    const to = parsedRect(cursor); if (to === undefined) return;
    const timeText = cursor.rawString(); if (timeText === undefined) return;
    const amountText = cursor.rawString(); if (amountText === undefined) return;
    const amount = gameAtof(amountText);
    const step = (start: number, end: number): number => {
      const difference = qvmFloatToInt(f(end - start));
      const absolute = difference < 0 ? (-difference) | 0 : difference;
      return f(f(absolute) / amount);
    };
    for (const item of this.matching(this.scriptMenu(owner), name)) {
      item.window.flags |= UiWindowFlag.InTransition | UiWindowFlag.Visible;
      item.window.offsetTime = gameAtoi(timeText);
      item.window.clientRect = copyRect(from);
      item.window.rectEffects = copyRect(to);
      item.window.rectEffects2 = {
        x: step(from.x, to.x),
        y: step(from.y, to.y),
        width: step(from.width, to.width),
        height: step(from.height, to.height),
      };
      updateItemPosition(item);
    }
  }

  private scriptOrbit(owner: ScriptOwner, cursor: RuntimeScriptCursor): void {
    const name = cursor.string(); if (name === undefined) return;
    const x = cursor.rawString(); if (x === undefined) return;
    const y = cursor.rawString(); if (y === undefined) return;
    const cx = cursor.rawString(); if (cx === undefined) return;
    const cy = cursor.rawString(); if (cy === undefined) return;
    const time = cursor.rawString(); if (time === undefined) return;
    for (const item of this.matching(this.scriptMenu(owner), name)) {
      item.window.flags |= UiWindowFlag.Orbiting | UiWindowFlag.Visible;
      item.window.offsetTime = gameAtoi(time);
      item.window.rectEffects.x = gameAtof(cx);
      item.window.rectEffects.y = gameAtof(cy);
      item.window.clientRect.x = gameAtof(x);
      item.window.clientRect.y = gameAtof(y);
      updateItemPosition(item);
    }
  }

  private behaviorSnapshot(item: ItemState): UiRuntimeItemBehaviorSnapshot {
    const behavior = item.definition.behavior;
    if (behavior.kind === "list-box") return Object.freeze({
      kind: "list-box",
      startPosition: behavior.list.startPosition,
      endPosition: behavior.list.endPosition,
      cursorPosition: behavior.list.cursorPosition,
      drawPadding: behavior.list.drawPadding,
    });
    if (behavior.kind === "edit-field" || behavior.kind === "numeric-field" || behavior.kind === "slider"
      || behavior.kind === "yes-no" || behavior.kind === "bind" || behavior.kind === "text") {
      const edit = behavior.edit;
      if (edit !== undefined) return Object.freeze({ kind: "edit", paintOffset: edit.paintOffset });
    }
    return Object.freeze({ kind: "other" });
  }

  private menuAt(x: number, y: number): MenuState | undefined {
    return this.activeMenus().find(menu => rectContains(menu.window.rect, x, y));
  }

  private async mouseMoveMenu(menu: MenuState, x: number, y: number): Promise<void> {
    if ((menu.window.flags & (UiWindowFlag.Visible | UiWindowFlag.Forced)) === 0) return;
    if (this.capture.kind !== "idle" || this.waitingForKey || this.editingItem !== undefined) return;
    let focusSet = false;
    for (let pass = 0; pass < 2; pass++) {
      for (const item of menuItems(menu)) {
        if ((item.window.flags & (UiWindowFlag.Visible | UiWindowFlag.Forced)) === 0) continue;
        if (!this.itemPassesCvar(item, "enable") || !this.itemPassesCvar(item, "show")) continue;
        if (rectContains(item.window.rect, x, y)) {
          if (pass !== 1) continue;
          if (item.definition.behavior.kind === "text" && item.definition.text !== undefined && !rectContains(this.correctedTextRect(item), x, y)) continue;
          if ((item.window.flags & UiWindowFlag.Visible) !== 0 && (item.window.flags & UiWindowFlag.FadingOut) === 0) {
            await this.mouseEnter(menu, item, x, y);
            if (!focusSet) focusSet = await this.setItemFocus(menu, item, x, y);
          }
        } else if ((item.window.flags & UiWindowFlag.MouseOver) !== 0) {
          await this.mouseLeave(menu, item);
          this.setItemMouseOver(item.definition, false);
        }
      }
    }
  }

  private correctedTextRect(item: ItemState): UiRect {
    return item.textRect.width === 0
      ? copyRect(item.textRect)
      : { ...item.textRect, y: f(item.textRect.y - item.textRect.height) };
  }

  private async mouseEnter(menu: MenuState, item: ItemState, x: number, y: number): Promise<void> {
    if (!this.itemPassesCvar(item, "enable") || !this.itemPassesCvar(item, "show")) return;
    if (rectContains({ ...item.textRect, y: f(item.textRect.y - item.textRect.height) }, x, y)) {
      if ((item.window.flags & UiWindowFlag.MouseOverText) === 0) {
        if (item.definition.mouseEnterText !== undefined) await this.runScript({ menu, item }, item.definition.mouseEnterText);
        item.window.flags |= UiWindowFlag.MouseOverText;
      }
      if ((item.window.flags & UiWindowFlag.MouseOver) === 0) {
        if (item.definition.mouseEnter !== undefined) await this.runScript({ menu, item }, item.definition.mouseEnter);
        item.window.flags |= UiWindowFlag.MouseOver;
      }
    } else {
      if ((item.window.flags & UiWindowFlag.MouseOverText) !== 0) {
        if (item.definition.mouseExitText !== undefined) await this.runScript({ menu, item }, item.definition.mouseExitText);
        item.window.flags &= ~UiWindowFlag.MouseOverText;
      }
      if ((item.window.flags & UiWindowFlag.MouseOver) === 0) {
        if (item.definition.mouseEnter !== undefined) await this.runScript({ menu, item }, item.definition.mouseEnter);
        item.window.flags |= UiWindowFlag.MouseOver;
      }
      if (item.definition.type === 6) this.listMouseEnter(item, x, y);
    }
  }

  private async mouseLeave(menu: MenuState, item: ItemState): Promise<void> {
    if ((item.window.flags & UiWindowFlag.MouseOverText) !== 0) {
      if (item.definition.mouseExitText !== undefined) await this.runScript({ menu, item }, item.definition.mouseExitText);
      item.window.flags &= ~UiWindowFlag.MouseOverText;
    }
    if (item.definition.mouseExit !== undefined) await this.runScript({ menu, item }, item.definition.mouseExit);
    item.window.flags &= ~(UiWindowFlag.ListRightArrow | UiWindowFlag.ListLeftArrow);
  }

  private async setItemFocus(menu: MenuState, item: ItemState, x: number, y: number): Promise<boolean> {
    if (
      (item.window.flags & (UiWindowFlag.Decoration | UiWindowFlag.HasFocus)) !== 0
      || (item.window.flags & UiWindowFlag.Visible) === 0
    ) return false;
    const parent = this.parentMenu(item);
    if (!this.itemPassesCvar(item, "enable") || !this.itemPassesCvar(item, "show")) return false;
    const oldFocus = await this.clearFocus(this.parentMenu(item));
    let playSound = false;
    if (item.definition.behavior.kind === "text") {
      if (rectContains(this.correctedTextRect(item), x, y)) {
        item.window.flags |= UiWindowFlag.HasFocus;
        playSound = true;
      }
      else if (oldFocus !== undefined) {
        oldFocus.window.flags |= UiWindowFlag.HasFocus;
        if (oldFocus.definition.onFocus !== undefined) await this.runScript({ menu, item: oldFocus }, oldFocus.definition.onFocus);
      }
    } else {
      item.window.flags |= UiWindowFlag.HasFocus;
      if (item.definition.onFocus !== undefined) await this.runScript({ menu, item }, item.definition.onFocus);
      playSound = true;
    }
    if (playSound) {
      const itemHandle = item.definition.focusSoundHandle;
      if (itemHandle !== undefined && itemHandle !== 0) this.options.audio.playLocal(itemHandle);
      else {
        const itemPath = itemHandle === undefined ? item.definition.focusSound?.path : undefined;
        const itemSound = itemPath === undefined ? undefined : this.sound(itemPath);
        const globalPath = this.definitions.assets.itemFocusSound?.path;
        const globalSound = globalPath === undefined ? undefined : this.sound(globalPath);
        this.options.audio.playLocal(itemSound ?? globalSound);
      }
    }
    if (parent === undefined) throw new Error("Item_SetFocus dereferences a NULL parent menu at itemCount");
    for (let index = 0; index < parent.itemCount; index++) {
      if (parent.itemAt(index) === item) { parent.cursorItem = index; break; }
    }
    return true;
  }

  private async focusRelative(menu: MenuState, direction: -1 | 1): Promise<ItemState | undefined> {
    const original = menu.cursorItem;
    let wrapped = false;
    if (direction < 0 && menu.cursorItem < 0) {
      menu.cursorItem = menu.itemCount - 1;
      wrapped = true;
    } else if (direction > 0 && menu.cursorItem === -1) {
      menu.cursorItem = 0;
      wrapped = true;
    }
    while (direction < 0 ? menu.cursorItem > -1 : menu.cursorItem < menu.itemCount) {
      menu.cursorItem += direction;
      if ((direction < 0 ? menu.cursorItem < 0 : menu.cursorItem >= menu.itemCount) && !wrapped) {
        wrapped = true;
        menu.cursorItem = direction < 0 ? menu.itemCount - 1 : 0;
      }
      const item = menu.itemAt(menu.cursorItem);
      if (item !== undefined && await this.setItemFocus(menu, item, this.displayCursorX, this.displayCursorY)) {
        await this.mouseMoveMenu(menu, f(item.window.rect.x + 1), f(item.window.rect.y + 1));
        return menu.itemAt(menu.cursorItem);
      }
    }
    menu.cursorItem = original;
    return undefined;
  }

  private async handleMenuKey(menu: MenuState, key: number, down: boolean): Promise<boolean> {
    if (this.waitingForKey && down) {
      const item = this.bindingItem;
      return item === undefined ? true : this.handleBindKey(item, key, down);
    }
    if (this.editingItem !== undefined && down) {
      const editing = this.editingItem;
      if (!await this.handleTextKey(editing, key)) {
        this.editingItem = undefined;
        return true;
      }
      if (isMouseKey(key)) {
        this.editingItem = undefined;
        await this.pointerMove(this.displayCursorX, this.displayCursorY);
      } else if (key === KeyCode.Tab || key === KeyCode.Up || key === KeyCode.Down) return true;
    }
    if (down && (menu.window.flags & UiWindowFlag.Popup) === 0 && !rectContains(menu.window.rect, this.displayCursorX, this.displayCursorY) && isMouseKey(key)) {
      await this.handleOutOfBounds(menu, key, down);
      return true;
    }
    let item: ItemState | undefined;
    for (const candidate of menuItems(menu)) if ((candidate.window.flags & UiWindowFlag.HasFocus) !== 0) item = candidate;
    if (item !== undefined && await this.handleItemKey(item, key, down)) {
      if (item.definition.action !== undefined) await this.runScript({ menu, item }, item.definition.action);
      return true;
    }
    if (!down) return false;
    if (key === KeyCode.F11) {
      if (this.cvarValue("developer") !== 0) this.debug = !this.debug;
      return true;
    }
    if (key === KeyCode.F12) {
      if (this.cvarValue("developer") !== 0) this.executeText("screenshot\n");
      return true;
    }
    if (key === KeyCode.Up || key === KeyCode.KeypadUp) { await this.focusRelative(menu, -1); return true; }
    if (key === KeyCode.Down || key === KeyCode.KeypadDown || key === KeyCode.Tab) { await this.focusRelative(menu, 1); return true; }
    if (key === KeyCode.Escape) {
      if (!this.waitingForKey && menu.definition.onEscape !== undefined) await this.runScript({ menu, item: undefined }, menu.definition.onEscape);
      return true;
    }
    if ((key === KeyCode.Mouse1 || key === KeyCode.Mouse2) && item !== undefined) {
      if (item.definition.behavior.kind === "text") {
        if (rectContains(this.correctedTextRect(item), this.displayCursorX, this.displayCursorY) && item.definition.action !== undefined) await this.runScript({ menu, item }, item.definition.action);
      } else if (item.definition.behavior.kind === "edit-field" || item.definition.behavior.kind === "numeric-field") {
        if (rectContains(item.window.rect, this.displayCursorX, this.displayCursorY)) this.beginEditing(item);
      } else if (rectContains(item.window.rect, this.displayCursorX, this.displayCursorY) && item.definition.action !== undefined) {
        await this.runScript({ menu, item }, item.definition.action);
      }
      return true;
    }
    if ((key === KeyCode.Enter || key === KeyCode.KeypadEnter) && item !== undefined) {
      if (item.definition.behavior.kind === "edit-field" || item.definition.behavior.kind === "numeric-field") this.beginEditing(item);
      else if (item.definition.action !== undefined) await this.runScript({ menu, item }, item.definition.action);
      return true;
    }
    return false;
  }

  private beginEditing(item: ItemState): void {
    item.cursorPosition = 0;
    this.editingItem = item;
    this.bindingHost("edit overstrike").setOverstrike(true);
  }

  private async handleOutOfBounds(menu: MenuState, key: number, down: boolean): Promise<void> {
    if (down && (menu.window.flags & UiWindowFlag.OutOfBoundsClick) !== 0) await this.closeMenu(menu);
    for (const candidate of this.liveMenus()) {
      if (!this.menuOverActiveItem(candidate, this.displayCursorX, this.displayCursorY)) continue;
      await this.closeMenu(menu);
      await this.activateMenu(candidate);
      await this.mouseMoveMenu(candidate, this.displayCursorX, this.displayCursorY);
      await this.handleMenuKey(candidate, key, down);
    }
    const context = this.options.context;
    if (!this.activeMenus().some(candidate => (candidate.window.flags & (UiWindowFlag.Forced | UiWindowFlag.Visible)) !== 0) && context.kind === "ui") {
      await context.pause(false); this.opened();
    }
    this.closeCinematics();
  }

  private menuOverActiveItem(menu: MenuState, x: number, y: number): boolean {
    if ((menu.window.flags & (UiWindowFlag.Visible | UiWindowFlag.Forced)) === 0 || !rectContains(menu.window.rect, x, y)) return false;
    for (const item of menuItems(menu)) {
      if ((item.window.flags & (UiWindowFlag.Visible | UiWindowFlag.Forced)) === 0 || (item.window.flags & UiWindowFlag.Decoration) !== 0) continue;
      if (!rectContains(item.window.rect, x, y)) continue;
      if (item.definition.behavior.kind !== "text" || item.definition.text === undefined || rectContains(this.correctedTextRect(item), x, y)) return true;
    }
    return false;
  }

  private async handleItemKey(item: ItemState, key: number, down: boolean): Promise<boolean> {
    if (this.capture.kind !== "idle") this.capture = { kind: "idle" };
    else if (down && isMouseKey(key)) this.startCapture(item, key);
    if (!down) return false;
    switch (item.definition.behavior.kind) {
      case "list-box": return this.handleListKey(item, key, false);
      case "yes-no": return this.handleYesNoKey(item, key);
      case "multi": return this.handleMultiKey(item, key);
      case "owner-draw": {
        const result = await this.options.ownerDraw.handleKey(item.definition.window.ownerDraw, item.definition.window.ownerDrawFlags, item.special, key);
        this.opened();
        item.special = f(result.special);
        return result.handled;
      }
      case "bind": return this.handleBindKey(item, key, down);
      case "slider": return this.handleSliderKey(item, key);
      default: return false;
    }
  }

  private handleYesNoKey(item: ItemState, key: number): boolean {
    const cvar = item.definition.cvar;
    if (cvar === undefined || (item.window.flags & UiWindowFlag.HasFocus) === 0 || !rectContains(item.window.rect, this.displayCursorX, this.displayCursorY) || !isActivateKey(key)) return false;
    const value = this.cvarValue(cvar);
    this.options.cvars.set(cvar, value === 0 ? "1" : "0", true);
    return true;
  }

  private handleMultiKey(item: ItemState, key: number): boolean {
    const cvar = item.definition.cvar, behavior = item.definition.behavior;
    if (behavior.kind !== "multi" || cvar === undefined || (item.window.flags & UiWindowFlag.HasFocus) === 0 || !rectContains(item.window.rect, this.displayCursorX, this.displayCursorY) || !isActivateKey(key)) return false;
    const multi = behavior.multi;
    if (multi === undefined) return false;
    const count = multi.count;
    let current = 0;
    if (multi.stringDefinition) {
      const value = this.cvarBuffer(cvar);
      for (let index = 0; index < count; index++) {
        if (equalName(multi.stringValue(index), value)) { current = index; break; }
      }
    } else {
      const value = this.cvarValue(cvar);
      for (let index = 0; index < count; index++) {
        if (multi.numberValue(index) === value) { current = index; break; }
      }
    }
    current++;
    if (current < 0 || current >= count) current = 0;
    if (multi.stringDefinition) {
      const value = multi.stringValue(current);
      if (value === undefined) this.options.cvars.set2(cvar, null, true);
      else this.options.cvars.set2(cvar, value, true);
    } else {
      const value = multi.numberValue(current);
      const integer = qvmFloatToInt(value);
      this.options.cvars.set(cvar, f(integer) === value ? gameFormat("%i", [integer]) : gameFormat("%f", [value]), true);
    }
    return true;
  }

  private cvarBuffer(name: string): string {
    const value = quakeString(this.options.cvars.get(name)?.value ?? "");
    return value.length > 1023 ? value.slice(0, 1023) : value;
  }

  private async handleTextKey(item: ItemState, key: number): Promise<boolean> {
    const edit = item.definition.editData(), cvar = item.definition.cvar;
    if (cvar === undefined) return false;
    const value = this.cvarBuffer(cvar);
    const buffer = new Uint8Array(1024);
    for (let index = 0; index < value.length; index++) buffer[index] = value.charCodeAt(index);
    const move = (destination: number, source: number, count: number): void => {
      if (destination < 0 || source < 0 || count < 0 || destination + count > buffer.length || source + count > buffer.length) {
        throw new RangeError("Item_TextField_HandleKey memmove exceeds local char[1024]");
      }
      buffer.copyWithin(destination, source, source + count);
    };
    const publish = (): void => {
      const end = buffer.indexOf(0);
      if (end === -1) throw new RangeError("Item_TextField_HandleKey passes unterminated local char[1024]");
      let text = "";
      for (const byte of buffer.subarray(0, end)) text += String.fromCharCode(byte);
      this.options.cvars.set2(item.definition.cvar ?? null, text, true);
    };
    let length = value.length;
    if (edit === undefined) throw new Error("Item_TextField_HandleKey dereferences NULL typeData at maxChars");
    if (edit.maxChars !== 0 && length > edit.maxChars) length = edit.maxChars;
    if ((key & KEY_CHAR_FLAG) !== 0) {
      key &= ~KEY_CHAR_FLAG;
      if (key === 8) {
        if (item.cursorPosition > 0) {
          move(item.cursorPosition - 1, item.cursorPosition, length + 1 - item.cursorPosition);
          item.cursorPosition--;
          if (item.cursorPosition < edit.paintOffset) edit.paintOffset--;
        }
        publish();
        return true;
      }
      if (key < 32 || item.definition.cvar === undefined) return true;
      if (item.definition.behavior.kind === "numeric-field" && (key < 48 || key > 57)) return false;
      if (!this.bindingHost("edit overstrike").getOverstrike()) {
        if (length === 255 || (edit.maxChars !== 0 && length >= edit.maxChars)) return true;
        move(item.cursorPosition + 1, item.cursorPosition, length + 1 - item.cursorPosition);
      } else {
        if (edit.maxChars !== 0 && item.cursorPosition >= edit.maxChars) return true;
      }
      if (item.cursorPosition < 0 || item.cursorPosition >= buffer.length) throw new RangeError("Item_TextField_HandleKey writes outside local char[1024]");
      buffer[item.cursorPosition] = key;
      publish();
      if (item.cursorPosition < length + 1) {
        item.cursorPosition++;
        if (edit.maxPaintChars !== 0 && item.cursorPosition > edit.maxPaintChars) edit.paintOffset++;
      }
    } else if (key === KeyCode.Delete || key === KeyCode.KeypadDelete) {
      if (item.cursorPosition < length) {
        move(item.cursorPosition, item.cursorPosition + 1, length - item.cursorPosition);
        publish();
      }
      return true;
    } else if (key === KeyCode.Right || key === KeyCode.KeypadRight) {
      if (edit.maxPaintChars !== 0 && item.cursorPosition >= edit.maxPaintChars && item.cursorPosition < length) {
        item.cursorPosition++; edit.paintOffset++; return true;
      }
      if (item.cursorPosition < length) item.cursorPosition++;
      return true;
    } else if (key === KeyCode.Left || key === KeyCode.KeypadLeft) {
      if (item.cursorPosition > 0) item.cursorPosition--;
      if (item.cursorPosition < edit.paintOffset) edit.paintOffset--;
      return true;
    } else if (key === KeyCode.Home || key === KeyCode.KeypadHome) {
      item.cursorPosition = 0; edit.paintOffset = 0; return true;
    } else if (key === KeyCode.End || key === KeyCode.KeypadEnd) {
      item.cursorPosition = length;
      if (item.cursorPosition > edit.maxPaintChars) edit.paintOffset = length - edit.maxPaintChars;
      return true;
    } else if (key === KeyCode.Insert || key === KeyCode.KeypadInsert) {
      const bindings = this.bindingHost("edit overstrike");
      bindings.setOverstrike(!bindings.getOverstrike());
      return true;
    }
    if (key === KeyCode.Tab || key === KeyCode.Down || key === KeyCode.KeypadDown) {
      const next = await this.focusRelative(this.menuFor(item), 1);
      if (next?.definition.behavior.kind === "edit-field" || next?.definition.behavior.kind === "numeric-field") this.editingItem = next;
    }
    if (key === KeyCode.Up || key === KeyCode.KeypadUp) {
      const previous = await this.focusRelative(this.menuFor(item), -1);
      if (previous?.definition.behavior.kind === "edit-field" || previous?.definition.behavior.kind === "numeric-field") this.editingItem = previous;
    }
    return key !== KeyCode.Enter && key !== KeyCode.KeypadEnter && key !== KeyCode.Escape;
  }

  private listMaximum(item: ItemState): number {
    const list = item.definition.listData();
    const count = this.options.feeder.count(item.special);
    const horizontal = (item.window.flags & UiWindowFlag.Horizontal) !== 0;
    if (list === undefined) throw new Error("Item_ListBox_MaxScroll dereferences NULL list data");
    const elementSize = horizontal ? list.elementWidth : list.elementHeight;
    if (!Number.isInteger(count) || count < -2147483648 || count > 2147483647) throw new RangeError("UI feeder count must be a signed 32-bit integer");
    const extent = horizontal ? item.window.rect.width : item.window.rect.height;
    return Math.max(0, qvmFloatToInt(f(f(f(count) - f(extent / elementSize)) + 1)));
  }

  private async handleListKey(item: ItemState, key: number, force: boolean): Promise<boolean> {
    const list = item.definition.listData();
    const count = this.options.feeder.count(item.special);
    if (!force && (!rectContains(item.window.rect, this.displayCursorX, this.displayCursorY) || (item.window.flags & UiWindowFlag.HasFocus) === 0)) return false;
    const maximum = this.listMaximum(item);
    const horizontal = (item.window.flags & UiWindowFlag.Horizontal) !== 0;
    if (list === undefined) throw new Error("Item_ListBox_HandleKey dereferences NULL list data");
    const view = qvmFloatToInt(f(horizontal ? item.window.rect.width / list.elementWidth : item.window.rect.height / list.elementHeight));
    const backward = horizontal
      ? key === KeyCode.Left || key === KeyCode.KeypadLeft
      : key === KeyCode.Up || key === KeyCode.KeypadUp;
    const forward = horizontal
      ? key === KeyCode.Right || key === KeyCode.KeypadRight
      : key === KeyCode.Down || key === KeyCode.KeypadDown;
    if (backward) {
      if (!list.notSelectable) {
        list.cursorPosition--;
        if (list.cursorPosition < 0) list.cursorPosition = 0;
        if (list.cursorPosition < list.startPosition) list.startPosition = list.cursorPosition;
        if (list.cursorPosition >= ((list.startPosition + view) | 0)) list.startPosition = list.cursorPosition - view + 1;
        await this.selectList(item, list);
      } else {
        list.startPosition--;
        if (list.startPosition < 0) list.startPosition = 0;
      }
      return true;
    }
    if (forward) {
      if (!list.notSelectable) {
        list.cursorPosition++;
        if (list.cursorPosition < list.startPosition) list.startPosition = list.cursorPosition;
        if (list.cursorPosition >= count) list.cursorPosition = count - 1;
        if (list.cursorPosition >= ((list.startPosition + view) | 0)) list.startPosition = list.cursorPosition - view + 1;
        await this.selectList(item, list);
      } else {
        list.startPosition++;
        const limit = horizontal ? (count - 1) | 0 : maximum;
        if (list.startPosition > limit) list.startPosition = limit;
      }
      return true;
    }
    if (key === KeyCode.Mouse1 || key === KeyCode.Mouse2) {
      if ((item.window.flags & UiWindowFlag.ListLeftArrow) !== 0) {
        list.startPosition--;
        if (list.startPosition < 0) list.startPosition = 0;
      } else if ((item.window.flags & UiWindowFlag.ListRightArrow) !== 0) {
        list.startPosition++;
        if (list.startPosition > maximum) list.startPosition = maximum;
      } else if ((item.window.flags & UiWindowFlag.ListPageUp) !== 0) {
        list.startPosition -= view;
        if (list.startPosition < 0) list.startPosition = 0;
      } else if ((item.window.flags & UiWindowFlag.ListPageDown) !== 0) {
        list.startPosition += view;
        if (list.startPosition > maximum) list.startPosition = maximum;
      } else if ((item.window.flags & UiWindowFlag.ListThumb) === 0) {
        if (this.realTime < this.lastListBoxClickTime && list.doubleClick !== undefined) {
          await this.runScript({ menu: this.menuFor(item), item }, list.doubleClick);
        }
        this.lastListBoxClickTime = (this.realTime + DOUBLE_CLICK_DELAY) | 0;
        if (item.cursorPosition !== list.cursorPosition) await this.selectList(item, list);
      }
      return true;
    }
    if (key === KeyCode.Home || key === KeyCode.KeypadHome) { list.startPosition = 0; return true; }
    if (key === KeyCode.End || key === KeyCode.KeypadEnd) { list.startPosition = maximum; return true; }
    const pageUp = key === KeyCode.PageUp || key === KeyCode.KeypadPageUp;
    const pageDown = key === KeyCode.PageDown || key === KeyCode.KeypadPageDown;
    if (pageUp || pageDown) {
      const amount = pageUp ? -view : view;
      if (!list.notSelectable) {
        list.cursorPosition += amount;
        if (pageUp && list.cursorPosition < 0) list.cursorPosition = 0;
        if (list.cursorPosition < list.startPosition) list.startPosition = list.cursorPosition;
        if (pageDown && list.cursorPosition >= count) list.cursorPosition = count - 1;
        if (list.cursorPosition >= ((list.startPosition + view) | 0)) list.startPosition = list.cursorPosition - view + 1;
        await this.selectList(item, list);
      } else {
        list.startPosition += amount;
        if (pageUp && list.startPosition < 0) list.startPosition = 0;
        if (pageDown && list.startPosition > maximum) list.startPosition = maximum;
      }
      return true;
    }
    return false;
  }

  private async selectList(item: ItemState, list: UiListBoxDefinition): Promise<void> {
    item.cursorPosition = list.cursorPosition;
    await this.options.feeder.select(item.special, item.cursorPosition); this.opened();
  }

  private parentMenu(item: ItemState): MenuState | undefined {
    const parent = item.definition.parent;
    if (parent === undefined) return undefined;
    const menu = this.menus[parent.sourceIndex];
    if (menu === undefined) throw new Error("UI item belongs to a missing menu");
    return menu;
  }

  private menuFor(item: ItemState): MenuState {
    const menu = this.parentMenu(item);
    if (menu === undefined) throw new Error("UI item dereferences a NULL parent menu");
    return menu;
  }

  private listThumbPosition(item: ItemState): number {
    const list = item.definition.listData();
    const maximum = this.listMaximum(item);
    const horizontal = (item.window.flags & UiWindowFlag.Horizontal) !== 0;
    const size = f(f((horizontal ? item.window.rect.width : item.window.rect.height) - SCROLLBAR_SIZE * 2) - 2);
    const step = maximum > 0 ? f(f(size - SCROLLBAR_SIZE) / f(maximum)) : 0;
    if (list === undefined) throw new Error("Item_ListBox_ThumbPosition dereferences NULL list data");
    const base = horizontal ? item.window.rect.x : item.window.rect.y;
    return qvmFloatToInt(f(f(f(base + 1) + SCROLLBAR_SIZE) + f(step * f(list.startPosition))));
  }

  private listThumbDrawPosition(item: ItemState): number {
    if (this.capture.kind !== "idle" && this.capture.item === item) {
      const horizontal = (item.window.flags & UiWindowFlag.Horizontal) !== 0;
      const start = horizontal ? item.window.rect.x : item.window.rect.y;
      const extent = horizontal ? item.window.rect.width : item.window.rect.height;
      const minimum = qvmFloatToInt(f(f(start + SCROLLBAR_SIZE) + 1));
      const maximum = qvmFloatToInt(f(f(f(start + extent) - 2 * SCROLLBAR_SIZE) - 1));
      const cursor = horizontal ? this.displayCursorX : this.displayCursorY;
      if (cursor >= f(f(minimum) + SCROLLBAR_SIZE / 2) && cursor <= f(f(maximum) + SCROLLBAR_SIZE / 2)) {
        return qvmFloatToInt(f(cursor - SCROLLBAR_SIZE / 2));
      }
    }
    return this.listThumbPosition(item);
  }

  private listHit(item: ItemState, x: number, y: number): number {
    this.options.feeder.count(item.special);
    let rect: UiRect;
    if ((item.window.flags & UiWindowFlag.Horizontal) !== 0) {
      rect = { x: item.window.rect.x, y: f(f(item.window.rect.y + item.window.rect.height) - SCROLLBAR_SIZE), width: SCROLLBAR_SIZE, height: SCROLLBAR_SIZE };
      if (rectContains(rect, x, y)) return UiWindowFlag.ListLeftArrow;
      rect = { ...rect, x: f(f(item.window.rect.x + item.window.rect.width) - SCROLLBAR_SIZE) };
      if (rectContains(rect, x, y)) return UiWindowFlag.ListRightArrow;
      const thumb = this.listThumbPosition(item);
      rect = { ...rect, x: thumb };
      if (rectContains(rect, x, y)) return UiWindowFlag.ListThumb;
      rect = { ...rect, x: f(item.window.rect.x + SCROLLBAR_SIZE), width: f(f(thumb) - f(item.window.rect.x + SCROLLBAR_SIZE)) };
      if (rectContains(rect, x, y)) return UiWindowFlag.ListPageUp;
      rect = { ...rect, x: f(f(thumb) + SCROLLBAR_SIZE), width: f(f(item.window.rect.x + item.window.rect.width) - SCROLLBAR_SIZE) };
      if (rectContains(rect, x, y)) return UiWindowFlag.ListPageDown;
    } else {
      rect = { x: f(f(item.window.rect.x + item.window.rect.width) - SCROLLBAR_SIZE), y: item.window.rect.y, width: SCROLLBAR_SIZE, height: SCROLLBAR_SIZE };
      if (rectContains(rect, x, y)) return UiWindowFlag.ListLeftArrow;
      rect = { ...rect, y: f(f(item.window.rect.y + item.window.rect.height) - SCROLLBAR_SIZE) };
      if (rectContains(rect, x, y)) return UiWindowFlag.ListRightArrow;
      const thumb = this.listThumbPosition(item);
      rect = { ...rect, y: thumb };
      if (rectContains(rect, x, y)) return UiWindowFlag.ListThumb;
      rect = { ...rect, y: f(item.window.rect.y + SCROLLBAR_SIZE), height: f(f(thumb) - f(item.window.rect.y + SCROLLBAR_SIZE)) };
      if (rectContains(rect, x, y)) return UiWindowFlag.ListPageUp;
      rect = { ...rect, y: f(f(thumb) + SCROLLBAR_SIZE), height: f(f(item.window.rect.y + item.window.rect.height) - SCROLLBAR_SIZE) };
      if (rectContains(rect, x, y)) return UiWindowFlag.ListPageDown;
    }
    return 0;
  }

  private listMouseEnter(item: ItemState, x: number, y: number): void {
    const list = item.definition.listData();
    item.window.flags &= ~(UiWindowFlag.ListLeftArrow | UiWindowFlag.ListRightArrow | UiWindowFlag.ListThumb | UiWindowFlag.ListPageUp | UiWindowFlag.ListPageDown);
    item.window.flags |= this.listHit(item, x, y);
    const controls = UiWindowFlag.ListLeftArrow | UiWindowFlag.ListRightArrow | UiWindowFlag.ListThumb | UiWindowFlag.ListPageUp | UiWindowFlag.ListPageDown;
    if ((item.window.flags & controls) !== 0) return;
    if (list === undefined) throw new Error("Item_ListBox_MouseEnter dereferences NULL list data");
    if ((item.window.flags & UiWindowFlag.Horizontal) !== 0) {
      if (list.elementStyle !== 1) return;
      const rect = { x: item.window.rect.x, y: item.window.rect.y, width: f(item.window.rect.width - list.drawPadding), height: f(item.window.rect.height - SCROLLBAR_SIZE) };
      if (rectContains(rect, x, y)) list.cursorPosition = Math.min(list.endPosition, (qvmFloatToInt(f(f(x - rect.x) / list.elementWidth)) + list.startPosition) | 0);
    } else {
      const rect = { x: item.window.rect.x, y: item.window.rect.y, width: f(item.window.rect.width - SCROLLBAR_SIZE), height: f(item.window.rect.height - list.drawPadding) };
      if (rectContains(rect, x, y)) list.cursorPosition = Math.min(list.endPosition, (qvmFloatToInt(f(f(f(y - 2) - rect.y) / list.elementHeight)) + list.startPosition) | 0);
    }
  }

  private sliderX(item: ItemState): number {
    return item.definition.text === undefined ? item.window.rect.x : f(f(item.textRect.x + item.textRect.width) + 8);
  }

  private sliderThumbPosition(item: ItemState): number {
    const edit = item.definition.editData();
    const x = this.sliderX(item), cvar = item.definition.cvar;
    if (edit === undefined && cvar !== undefined) return x;
    if (cvar === undefined) throw new Error("Item_Slider_ThumbPosition hashes NULL cvar in Cvar_FindVar");
    let value = this.cvarValue(cvar);
    if (edit === undefined) throw new Error("Item_Slider_ThumbPosition dereferences NULL edit data");
    if (value < edit.minimum) value = edit.minimum;
    else if (value > edit.maximum) value = edit.maximum;
    const range = f(edit.maximum - edit.minimum);
    value = f(value - edit.minimum);
    value = f(value / range);
    value = f(value * SLIDER_WIDTH);
    return f(x + value);
  }

  private handleSliderKey(item: ItemState, key: number): boolean {
    const cvar = item.definition.cvar;
    if (cvar !== undefined && (item.window.flags & UiWindowFlag.HasFocus) !== 0 && rectContains(item.window.rect, this.displayCursorX, this.displayCursorY) && isActivateKey(key)) {
      const edit = item.definition.editData();
      if (edit !== undefined) {
        const x = this.sliderX(item);
        const test = { ...item.window.rect, x: f(x - SLIDER_THUMB_WIDTH / 2), width: f(SLIDER_WIDTH + SLIDER_THUMB_WIDTH / 2) };
        if (rectContains(test, this.displayCursorX, this.displayCursorY)) {
          const work = f(this.displayCursorX - x);
          const value = f(f(f(work / SLIDER_WIDTH) * f(edit.maximum - edit.minimum)) + edit.minimum);
          this.options.cvars.set(cvar, gameFormat("%f", [value]), true);
          return true;
        }
      }
    }
    this.options.print?.("slider handle key exit\n");
    return false;
  }

  private startCapture(item: ItemState, key: number): void {
    const kind = item.definition.behavior.kind;
    if (kind === "list-box" || kind === "edit-field" || kind === "numeric-field") {
      const flags = this.listHit(item, this.displayCursorX, this.displayCursorY);
      if ((flags & (UiWindowFlag.ListLeftArrow | UiWindowFlag.ListRightArrow)) !== 0) {
        this.nextScrollTime = (this.realTime + 500) | 0;
        this.nextScrollAdjustTime = (this.realTime + 150) | 0;
        this.scrollAdjustValue = 500;
        this.capture = { kind: "list-auto", item, key, xStart: this.displayCursorX, yStart: this.displayCursorY };
      } else if ((flags & UiWindowFlag.ListThumb) !== 0) {
        this.capture = { kind: "list-thumb", item, key, xStart: this.displayCursorX, yStart: this.displayCursorY };
      }
    } else if (item.definition.behavior.kind === "slider") {
      const thumb = this.sliderThumbPosition(item);
      if (rectContains({ x: f(thumb - SLIDER_THUMB_WIDTH / 2), y: f(item.window.rect.y - 2), width: SLIDER_THUMB_WIDTH, height: 20 }, this.displayCursorX, this.displayCursorY)) {
        this.capture = { kind: "slider-thumb", item, key, xStart: this.displayCursorX, yStart: this.displayCursorY };
      }
    }
  }

  private bindingByName(name: string | undefined): BindingState | undefined {
    return name === undefined ? undefined : this.bindings.find(binding => equalName(binding.command, name));
  }

  private writeBindings(): void {
    const host = this.bindingHost("write bindings");
    for (const binding of this.bindings) {
      if (binding.first !== -1) {
        host.setBinding(binding.first, binding.command);
        if (binding.second !== -1) host.setBinding(binding.second, binding.command);
      }
    }
    this.options.commands.append("in_restart\n");
  }

  private executeText(text: string): void {
    if (this.options.context.kind === "cgame") throw new Error("UI executeText is unavailable in cgame context");
    this.options.commands.append(text);
  }

  private handleBindKey(item: ItemState, key: number, down: boolean): boolean {
    if (rectContains(item.window.rect, this.displayCursorX, this.displayCursorY) && !this.waitingForKey) {
      if (down && (key === KeyCode.Mouse1 || key === KeyCode.Enter)) {
        this.waitingForKey = true;
        this.bindingItem = item;
      }
      return true;
    }
    if (!this.waitingForKey || this.bindingItem === undefined) return true;
    if ((key & KEY_CHAR_FLAG) !== 0) return true;
    if (key === KeyCode.Escape) { this.waitingForKey = false; return true; }
    const target = this.bindingByName(item.definition.cvar);
    if (key === KeyCode.Backspace) {
      if (target !== undefined) { target.first = -1; target.second = -1; }
      this.writeBindings();
      this.waitingForKey = false;
      this.bindingItem = undefined;
      return true;
    }
    if (key === 96) return true;
    if (key !== -1) {
      for (const binding of this.bindings) {
        if (binding.second === key) binding.second = -1;
        if (binding.first === key) { binding.first = binding.second; binding.second = -1; }
      }
    }
    if (target !== undefined) {
      if (key === -1) {
        const host = this.bindingHost("clear binding");
        if (target.first !== -1) { host.setBinding(target.first, ""); target.first = -1; }
        if (target.second !== -1) { host.setBinding(target.second, ""); target.second = -1; }
      } else if (target.first === -1) target.first = key;
      else if (target.first !== key && target.second === -1) target.second = key;
      else {
        const host = this.bindingHost("replace binding");
        host.setBinding(target.first, "");
        host.setBinding(target.second, "");
        target.first = key;
        target.second = -1;
      }
    }
    this.writeBindings();
    this.waitingForKey = false;
    return true;
  }

  private async runCapture(): Promise<void> {
    const capture = this.capture;
    if (capture.kind === "idle") return;
    if (capture.kind === "slider-thumb") {
      const edit = capture.item.definition.editData();
      const x = this.sliderX(capture.item);
      const cursor = Math.max(x, Math.min(f(x + SLIDER_WIDTH), this.displayCursorX));
      if (edit === undefined) throw new Error("Scroll_Slider_ThumbFunc dereferences NULL edit data");
      const value = f(f(f(f(cursor - x) / SLIDER_WIDTH) * f(edit.maximum - edit.minimum)) + edit.minimum);
      this.options.cvars.set2(capture.item.definition.cvar ?? null, gameFormat("%f", [value]), true);
      return;
    }
    if (capture.kind === "list-thumb") {
      const list = capture.item.definition.listData();
      const horizontal = (capture.item.window.flags & UiWindowFlag.Horizontal) !== 0;
      if (horizontal) {
        if (this.displayCursorX === capture.xStart) return;
        const width = f(f(capture.item.window.rect.width - SCROLLBAR_SIZE * 2) - 2);
        const start = f(f(capture.item.window.rect.x + SCROLLBAR_SIZE) + 1);
        const maximum = this.listMaximum(capture.item);
        const denominator = f(width - SCROLLBAR_SIZE);
        if (list === undefined) throw new Error("Scroll_ListBox_ThumbFunc dereferences NULL list data");
        list.startPosition = Math.max(0, Math.min(maximum,
          qvmFloatToInt(f(f(f(f(this.displayCursorX - start) - SCROLLBAR_SIZE / 2) * f(maximum)) / denominator))));
        capture.xStart = this.displayCursorX;
      } else if (this.displayCursorY !== capture.yStart) {
        const height = f(f(capture.item.window.rect.height - SCROLLBAR_SIZE * 2) - 2);
        const start = f(f(capture.item.window.rect.y + SCROLLBAR_SIZE) + 1);
        const maximum = this.listMaximum(capture.item);
        const denominator = f(height - SCROLLBAR_SIZE);
        if (list === undefined) throw new Error("Scroll_ListBox_ThumbFunc dereferences NULL list data");
        list.startPosition = Math.max(0, Math.min(maximum,
          qvmFloatToInt(f(f(f(f(this.displayCursorY - start) - SCROLLBAR_SIZE / 2) * f(maximum)) / denominator))));
        capture.yStart = this.displayCursorY;
      }
    }
    if (this.realTime > this.nextScrollTime) {
      await this.handleListKey(capture.item, capture.key, false);
      this.nextScrollTime = (this.realTime + this.scrollAdjustValue) | 0;
    }
    if (this.realTime > this.nextScrollAdjustTime) {
      this.nextScrollAdjustTime = (this.realTime + 150) | 0;
      if (this.scrollAdjustValue > 20) this.scrollAdjustValue -= 40;
    }
  }

  private async paintMenu(menu: MenuState, draw: Draw2D, force: boolean): Promise<void> {
    if ((menu.window.flags & UiWindowFlag.Visible) === 0 && !force) return;
    if (menu.definition.window.ownerDrawFlags !== 0 && !this.options.ownerDraw.visible(menu.definition.window.ownerDrawFlags)) return;
    if (force) menu.window.flags |= UiWindowFlag.Forced;
    if (menu.definition.fullScreen !== 0) draw.drawHandlePic({ x: 0, y: 0, width: 640, height: 480 }, this.backgroundOrZero(menu.window));
    await this.paintWindow(menu.window, menu.definition.window, menu.definition.fadeAmount, menu.definition.fadeClamp, menu.definition.fadeCycle, draw); this.opened();
    for (const item of menuItems(menu)) await this.paintItem(item, draw);
    if (this.debug) this.drawRect(draw, menu.window.rect, 1, { x: 1, y: 0, z: 1, w: 1 });
  }

  private async paintWindow(window: WindowState, definition: UiWindowDefinition, fadeAmount: number, fadeClamp: number, fadeCycle: number, draw: Draw2D): Promise<void> {
    if (this.debug) this.drawRect(draw, window.rect, 1, { x: 1, y: 1, z: 1, w: 1 });
    if (definition.style === 0 && definition.border === 0) return;
    let fill = copyRect(window.rect);
    if (definition.border !== 0) fill = {
      x: f(fill.x + definition.borderSize), y: f(fill.y + definition.borderSize),
      width: f(fill.width - f(definition.borderSize + 1)), height: f(fill.height - f(definition.borderSize + 1)),
    };
    let teamColor: Vec4 | undefined;
    if (definition.style === 1) {
      if (this.hasWindowBackground(window)) {
        this.fade(window, "back", fadeClamp, fadeCycle, true, fadeAmount);
        draw.setColor(window.backColor); draw.drawHandlePic(fill, this.backgroundOrZero(window)); draw.setColor(null);
      } else draw.fillRect(fill, window.backColor, this.options.widgetAssets.whiteShader);
    } else if (definition.style === 2) this.gradient(draw, fill, window.backColor);
    else if (definition.style === 3) {
      if ((window.flags & UiWindowFlag.ForeColorSet) !== 0) draw.setColor(window.foreColor);
      draw.drawHandlePic(fill, this.backgroundOrZero(window)); draw.setColor(null);
    } else if (definition.style === 4) {
      teamColor = copyColor(this.options.getTeamColor()); draw.fillRect(fill, teamColor, this.options.widgetAssets.whiteShader);
    } else if (definition.style === 5) { await this.paintCinematic(window, definition, fill, draw); this.opened(); }

    if (definition.border === 1) {
      if (definition.style === 4 && teamColor !== undefined) {
        const color = teamColor.x > 0
          ? { x: 1, y: .5, z: .5, w: 1 }
          : { x: .5, y: .5, z: 1, w: 1 };
        this.drawRect(draw, window.rect, definition.borderSize, color);
      } else this.drawRect(draw, window.rect, definition.borderSize, window.borderColor);
    } else if (definition.border === 2) {
      draw.setColor(window.borderColor);
      draw.drawCgTopBottom(window.rect, definition.borderSize, this.options.widgetAssets.whiteShader);
      draw.setColor(null);
    } else if (definition.border === 3) {
      draw.setColor(window.borderColor);
      draw.drawCgSides(window.rect, definition.borderSize, this.options.widgetAssets.whiteShader);
      draw.setColor(null);
    } else if (definition.border === 4) {
      this.gradient(draw, { ...window.rect, height: definition.borderSize }, window.borderColor);
      this.gradient(draw, { ...window.rect, y: f(f(window.rect.y + window.rect.height) - 1), height: definition.borderSize }, window.borderColor);
    }
  }

  private backgroundOrZero(window: WindowState): PictureAsset | (() => PictureAsset) {
    return this.windowBackground(window) ?? this.options.zeroPicture;
  }

  private windowBackground(window: WindowState): PictureAsset | (() => PictureAsset) | undefined {
    const handle = window.backgroundHandle;
    if (handle === undefined || handle === 0) return this.windowPicture(window);
    return () => this.sourceHandles().pictureForHandle(handle) ?? this.options.zeroPicture;
  }

  private widgetPicture(picture: PictureAsset): PictureAsset | (() => PictureAsset) {
    const handles = this.options.resources.handles;
    if (handles.kind === "diagnostic") return picture;
    const handle = handles.pictureHandle(picture);
    return () => handles.pictureForHandle(handle) ?? this.options.zeroPicture;
  }

  private drawRect(draw: Draw2D, rect: UiRect, size: number, color: Vec4): void {
    draw.drawCgRect(rect, size, color, this.options.widgetAssets.whiteShader);
  }

  private gradient(draw: Draw2D, rect: UiRect, color: Vec4): void {
    draw.setColor(color); draw.drawHandlePic(rect, this.options.widgetAssets.gradientBar); draw.setColor(null);
  }

  private async cinematicAsset(path: string): Promise<UiCinematicAsset> {
    const cached = this.cinematics.get(path);
    if (cached !== undefined) return cached;
    const asset = await this.options.resources.prepareCinematic(path); this.opened();
    this.cinematics.set(path, asset);
    return asset;
  }

  private async paintCinematic(window: WindowState, definition: UiWindowDefinition, rect: UiRect, draw: Draw2D): Promise<void> {
    if (window.cinematicHandle === -1) {
      const path = definition.cinematic;
      if (path === undefined) throw new Error("cinematic window has no cinematic path");
      const asset = await this.cinematicAsset(path); this.opened();
      const instance = this.options.cinematics.play(asset, rect);
      window.cinematicHandle = instance === undefined ? -2 : instance.handle.index;
    }
    if (window.cinematicHandle >= 0) {
      this.options.cinematics.run(window.cinematicHandle, this.realTime);
      this.options.cinematics.draw(window.cinematicHandle, rect, draw);
    }
  }

  private fade(window: WindowState, target: "fore" | "back", clamp: number, cycle: number, clearFlags: boolean, amount: number): void {
    if ((window.flags & (UiWindowFlag.FadingOut | UiWindowFlag.FadingIn)) === 0 || this.realTime <= window.nextTime) return;
    window.nextTime = (this.realTime + (cycle | 0)) | 0;
    const color = target === "fore" ? window.foreColor : window.backColor;
    if ((window.flags & UiWindowFlag.FadingOut) !== 0) {
      color.w = f(color.w - amount);
      if (clearFlags && color.w <= 0) window.flags &= ~(UiWindowFlag.FadingOut | UiWindowFlag.Visible);
    } else {
      color.w = f(color.w + amount);
      if (color.w >= clamp) {
        color.w = f(clamp);
        if (clearFlags) window.flags &= ~UiWindowFlag.FadingIn;
      }
    }
  }

  private async paintItem(item: ItemState, draw: Draw2D): Promise<void> {
    const menu = this.parentMenu(item);
    this.advanceItemAnimation(item);
    if (item.definition.window.ownerDrawFlags !== 0) {
      if (this.options.ownerDraw.visible(item.definition.window.ownerDrawFlags)) item.window.flags |= UiWindowFlag.Visible;
      else item.window.flags &= ~UiWindowFlag.Visible;
    }
    if (!this.itemPassesCvar(item, "show") || (item.window.flags & UiWindowFlag.Visible) === 0) return;
    if (menu === undefined) throw new Error("Item_Paint dereferences a NULL parent menu at fadeAmount");
    await this.paintWindow(item.window, item.definition.window, menu.definition.fadeAmount, menu.definition.fadeClamp, menu.definition.fadeCycle, draw); this.opened();
    if (this.debug) this.drawRect(draw, this.correctedTextRect(item), 1, { x: 0, y: 1, z: 0, w: 1 });
    switch (item.definition.behavior.kind) {
      case "owner-draw": await this.paintOwnerDraw(item, draw); break;
      case "text": case "button": this.paintText(item, draw); break;
      case "edit-field": case "numeric-field": this.paintTextField(item, draw); break;
      case "list-box": await this.paintList(item, draw); break;
      case "model": this.paintModel(item, draw); break;
      case "yes-no": this.paintYesNo(item, draw); break;
      case "multi": this.paintMulti(item, draw); break;
      case "bind": this.paintBind(item, draw); break;
      case "slider": this.paintSlider(item, draw); break;
      case "radio-button": case "check-box": case "combo": case "unknown": break;
    }
  }

  private advanceItemAnimation(item: ItemState): void {
    if ((item.window.flags & UiWindowFlag.Orbiting) !== 0 && this.realTime > item.window.nextTime) {
      item.window.nextTime = (this.realTime + item.window.offsetTime) | 0;
      const halfWidth = f(item.window.clientRect.width / 2), halfHeight = f(item.window.clientRect.height / 2);
      const rx = f(f(item.window.clientRect.x + halfWidth) - item.window.rectEffects.x);
      const ry = f(f(item.window.clientRect.y + halfHeight) - item.window.rectEffects.y);
      const angle = f(3 * Math.PI / 180), cosine = f(Math.cos(angle)), sine = f(Math.sin(angle));
      item.window.clientRect.x = f(f(f(f(rx * cosine) - f(ry * sine)) + item.window.rectEffects.x) - halfWidth);
      item.window.clientRect.y = f(f(f(f(rx * sine) + f(ry * cosine)) + item.window.rectEffects.y) - halfHeight);
      updateItemPosition(item);
    }
    if ((item.window.flags & UiWindowFlag.InTransition) !== 0 && this.realTime > item.window.nextTime) {
      item.window.nextTime = (this.realTime + item.window.offsetTime) | 0;
      let done = 0;
      const components: readonly (keyof UiRect)[] = ["x", "y", "width", "height"];
      for (const component of components) {
        const current = item.window.clientRect[component], target = item.window.rectEffects[component];
        if (current === target) { done++; continue; }
        const stepped = this.transitionValue(current, target, item.window.rectEffects2[component]);
        item.window.clientRect[component] = stepped.value;
        if (stepped.done) done++;
      }
      updateItemPosition(item);
      if (done === 4) item.window.flags &= ~UiWindowFlag.InTransition;
    }
  }

  private transitionValue(current: number, target: number, amount: number): { readonly value: number; readonly done: boolean } {
    if (current === target) return { value: current, done: true };
    const next = current < target ? f(current + amount) : f(current - amount);
    if ((current < target && next > target) || (current > target && next < target)) return { value: target, done: true };
    return { value: next, done: false };
  }

  private textValue(item: ItemState): string | undefined {
    if (item.definition.text !== undefined) return quakeString(item.definition.text);
    return item.definition.cvar === undefined ? undefined : this.cvarBuffer(item.definition.cvar);
  }

  private textExtents(item: ItemState, text: string): void {
    if (qvmFloatToInt(item.textRect.width) !== 0 && !(item.definition.behavior.kind === "owner-draw" && item.definition.textAlignment === 1)) return;
    let originalWidth = textWidth(this.options.fonts, item.definition.text ?? "", item.definition.textScale, 0);
    if (item.definition.behavior.kind === "owner-draw" && (item.definition.textAlignment === 1 || item.definition.textAlignment === 2)) {
      originalWidth = (originalWidth + this.options.ownerDraw.width(item.definition.window.ownerDraw, item.definition.textScale)) | 0;
    } else if (item.definition.behavior.kind === "edit-field" && item.definition.textAlignment === 1 && item.definition.cvar !== undefined) {
      originalWidth = (originalWidth + textWidth(this.options.fonts, this.cvarBuffer(item.definition.cvar).slice(0, 255), item.definition.textScale, 0)) | 0;
    }
    const width = textWidth(this.options.fonts, text, item.definition.textScale, 0);
    const height = textHeight(this.options.fonts, text, item.definition.textScale, 0);
    item.textRect.width = f(width);
    item.textRect.height = f(height);
    item.textRect.x = item.definition.textAlignX;
    item.textRect.y = item.definition.textAlignY;
    if (item.definition.textAlignment === 2) item.textRect.x = f(item.definition.textAlignX - originalWidth);
    else if (item.definition.textAlignment === 1) item.textRect.x = f(item.definition.textAlignX - Math.trunc(originalWidth / 2));
    if (item.definition.window.border !== 0) {
      item.textRect.x = f(item.textRect.x + item.definition.window.borderSize);
      item.textRect.y = f(item.textRect.y + item.definition.window.borderSize);
    }
    item.textRect.x = f(item.textRect.x + item.window.rect.x);
    item.textRect.y = f(item.textRect.y + item.window.rect.y);
  }

  private itemTextColor(item: ItemState): Vec4 {
    const menu = this.menuFor(item);
    this.fade(item.window, "fore", menu.definition.fadeClamp, menu.definition.fadeCycle, true, menu.definition.fadeAmount);
    let color = copyColor(item.window.foreColor);
    if ((item.window.flags & UiWindowFlag.HasFocus) !== 0) color = this.pulse(menu.definition.focusColor);
    else if (item.definition.textStyle === 1 && (Math.trunc(this.realTime / BLINK_DIVISOR) & 1) === 0) color = this.pulse(item.window.foreColor);
    if (!this.itemPassesCvar(item, "enable")) return copyColor(menu.definition.disableColor);
    return color;
  }

  private pulse(color: Vec4): Vec4 {
    return this.lerpColor(color, { x: f(f(.8) * color.x), y: f(f(.8) * color.y),
      z: f(f(.8) * color.z), w: f(f(.8) * color.w) });
  }

  private lerpColor(color: Vec4, lowLight: Vec4): Vec4 {
    const amount = f(.5 + f(.5 * f(Math.sin(f(Math.trunc(this.realTime / PULSE_DIVISOR))))));
    const component = (from: number, to: number): number => Math.max(0, Math.min(1, f(from + f(amount * f(to - from)))));
    return {
      x: component(color.x, lowLight.x), y: component(color.y, lowLight.y),
      z: component(color.z, lowLight.z), w: component(color.w, lowLight.w),
    };
  }

  private paintText(item: ItemState, draw: Draw2D): void {
    const value = this.textValue(item);
    if (value === undefined) return;
    const text = value;
    let color: Vec4;
    if ((item.window.flags & (UiWindowFlag.Wrapped | UiWindowFlag.AutoWrapped)) !== 0) {
      if (text.length === 0) return;
      color = this.itemTextColor(item);
      this.textExtents(item, text);
    } else {
      this.textExtents(item, text);
      if (text.length === 0) return;
      color = this.itemTextColor(item);
    }
    if ((item.window.flags & UiWindowFlag.Wrapped) !== 0) {
      let y = item.textRect.y;
      const lines = text.split("\r");
      for (const [index, line] of lines.entries()) {
        if (index < lines.length - 1 && line.length >= 1024) throw new RangeError("Item_Text_Wrapped_Paint writes outside local char[1024]");
        textPaint(draw, this.options.fonts, { x: item.textRect.x, y, scale: item.definition.textScale, color, text: line, adjust: 0, limit: 0, style: item.definition.textStyle });
        y = f(y + f((qvmFloatToInt(item.textRect.height) + 5) | 0));
      }
      return;
    }
    if ((item.window.flags & UiWindowFlag.AutoWrapped) !== 0) {
      this.paintAutoWrapped(item, draw, text, color);
      return;
    }
    textPaint(draw, this.options.fonts, { x: item.textRect.x, y: item.textRect.y, scale: item.definition.textScale, color, text, adjust: 0, limit: 0, style: item.definition.textStyle });
  }

  private paintAutoWrapped(item: ItemState, draw: Draw2D, text: string, color: Vec4): void {
    let buffer = "", length = 0, position = 0, width = 0;
    let lineBreak = 0, nextLine = 0, lineWidth = 0;
    let y = item.definition.textAlignY;
    while (true) {
      const character = text.charAt(position);
      if (character === " " || character === "\t" || character === "\n" || character === "") {
        lineBreak = length;
        nextLine = position + 1;
        lineWidth = width;
      }
      width = textWidth(this.options.fonts, buffer, item.definition.textScale, 0);
      if ((lineBreak !== 0 && width > item.window.rect.width) || character === "\n" || character === "") {
        if (length !== 0) {
          let x = item.textRect.x;
          if (item.definition.textAlignment === 0) x = item.definition.textAlignX;
          else if (item.definition.textAlignment === 2) x = f(item.definition.textAlignX - lineWidth);
          else if (item.definition.textAlignment === 1) x = f(item.definition.textAlignX - Math.trunc(lineWidth / 2));
          let baseline = y;
          if (item.definition.window.border !== 0) {
            x = f(x + item.definition.window.borderSize);
            baseline = f(baseline + item.definition.window.borderSize);
          }
          item.textRect.x = f(x + item.window.rect.x);
          item.textRect.y = f(baseline + item.window.rect.y);
          buffer = buffer.slice(0, lineBreak);
          textPaint(draw, this.options.fonts, { x: item.textRect.x, y: item.textRect.y, scale: item.definition.textScale,
            color, text: buffer, adjust: 0, limit: 0, style: item.definition.textStyle });
        }
        if (character === "") return;
        y = f(y + f((qvmFloatToInt(item.textRect.height) + 5) | 0));
        position = nextLine;
        length = 0;
        lineBreak = 0;
        lineWidth = 0;
      } else {
        if (length >= 1023) throw new RangeError("Item_Text_AutoWrapped_Paint writes outside local char[1024]");
        buffer = buffer.slice(0, length) + character;
        length++;
        position++;
      }
    }
  }

  private valueColor(item: ItemState): Vec4 {
    return (item.window.flags & UiWindowFlag.HasFocus) !== 0 ? this.pulse(this.menuFor(item).definition.focusColor) : copyColor(item.window.foreColor);
  }

  private paintTextField(item: ItemState, draw: Draw2D): void {
    const edit = item.definition.editData();
    this.paintText(item, draw);
    const cvar = item.definition.cvar;
    const value = cvar === undefined ? "" : this.cvarBuffer(cvar);
    const color = this.valueColor(item);
    const offset = item.definition.text !== undefined && item.definition.text.length > 0 ? 8 : 0;
    if (edit === undefined) throw new Error("Item_TextField_Paint dereferences NULL edit data");
    const options = { x: f(f(item.textRect.x + item.textRect.width) + offset), y: item.textRect.y, scale: item.definition.textScale,
      color, text: value.slice(edit.paintOffset), limit: edit.maxPaintChars, style: item.definition.textStyle };
    if ((item.window.flags & UiWindowFlag.HasFocus) !== 0 && this.editingItem !== undefined) {
      textPaintWithCursor(draw, this.options.fonts, options, {
        position: (item.cursorPosition - edit.paintOffset) | 0,
        character: this.bindingHost("paint edit cursor").getOverstrike() ? 95 : 124,
        time: this.realTime,
      });
    } else textPaint(draw, this.options.fonts, { ...options, adjust: 0 });
  }

  private paintYesNo(item: ItemState, draw: Draw2D): void {
    const value = item.definition.cvar === undefined ? 0 : this.cvarValue(item.definition.cvar);
    const color = this.valueColor(item);
    let x = item.textRect.x;
    if (item.definition.text !== undefined) {
      this.paintText(item, draw);
      x = f(f(item.textRect.x + item.textRect.width) + 8);
    }
    textPaint(draw, this.options.fonts, { x, y: item.textRect.y, scale: item.definition.textScale, color,
      text: value !== 0 ? "Yes" : "No", adjust: 0, limit: 0, style: item.definition.textStyle });
  }

  private multiSetting(item: ItemState): string | undefined {
    const cvar = item.definition.cvar, behavior = item.definition.behavior;
    if (cvar === undefined || behavior.kind !== "multi" || behavior.multi === undefined) return "";
    const multi = behavior.multi;
    if (multi.stringDefinition) {
      const current = this.cvarBuffer(cvar);
      for (let index = 0; index < multi.count; index++) {
        if (equalName(multi.stringValue(index), current)) return multi.label(index);
      }
    } else {
      const current = this.cvarValue(cvar);
      for (let index = 0; index < multi.count; index++) {
        if (multi.numberValue(index) === current) return multi.label(index);
      }
    }
    return "";
  }

  private paintMulti(item: ItemState, draw: Draw2D): void {
    const color = this.valueColor(item);
    const text = this.multiSetting(item);
    let x = item.textRect.x;
    if (item.definition.text !== undefined) {
      this.paintText(item, draw);
      x = f(f(item.textRect.x + item.textRect.width) + 8);
    }
    if (text === undefined) return;
    textPaint(draw, this.options.fonts, { x, y: item.textRect.y, scale: item.definition.textScale, color,
      text, adjust: 0, limit: 0, style: item.definition.textStyle });
  }

  private bindingText(item: ItemState): string {
    const host = this.bindingHost("paint binding");
    const binding = this.bindingByName(item.definition.cvar);
    if (binding === undefined || binding.first === -1) return "???";
    const first = quakeString(host.keyName(binding.first)).toUpperCase().slice(0, 31);
    if (binding.second === -1) return first;
    const second = quakeString(host.keyName(binding.second)).toUpperCase().slice(0, 31);
    return `${first} or ${second}`.slice(0, 31);
  }

  private paintBind(item: ItemState, draw: Draw2D): void {
    const edit = item.definition.editData();
    const maxChars = edit?.maxPaintChars ?? 0;
    const cvar = item.definition.cvar;
    if (cvar !== undefined) this.cvarValue(cvar);
    let color = this.valueColor(item);
    if ((item.window.flags & UiWindowFlag.HasFocus) !== 0 && this.bindingItem === item) {
      const menu = this.menuFor(item);
      color = this.lerpColor(menu.definition.focusColor, { x: f(.8), y: 0, z: 0, w: f(.8) });
    }
    let x = item.textRect.x, text = "FIXME";
    if (item.definition.text !== undefined) {
      this.paintText(item, draw);
      text = this.bindingText(item);
      x = f(f(item.textRect.x + item.textRect.width) + 8);
    }
    textPaint(draw, this.options.fonts, { x, y: item.textRect.y, scale: item.definition.textScale, color,
      text, adjust: 0, limit: maxChars, style: item.definition.textStyle });
  }

  private paintSlider(item: ItemState, draw: Draw2D): void {
    const cvar = item.definition.cvar;
    if (cvar !== undefined) this.cvarValue(cvar);
    const color = this.valueColor(item), y = item.window.rect.y;
    let x: number;
    if (item.definition.text !== undefined) {
      this.paintText(item, draw);
      x = f(f(item.textRect.x + item.textRect.width) + 8);
    } else x = item.window.rect.x;
    draw.setColor(color);
    draw.drawHandlePic({ x, y, width: SLIDER_WIDTH, height: 16 }, this.widgetPicture(this.options.widgetAssets.sliderBar));
    x = this.sliderThumbPosition(item);
    draw.drawHandlePic({ x: f(x - SLIDER_THUMB_WIDTH / 2), y: f(y - 2), width: SLIDER_THUMB_WIDTH, height: 20 }, this.widgetPicture(this.options.widgetAssets.sliderThumb));
  }

  private paintModel(item: ItemState, draw: Draw2D): void {
    const modelData = item.definition.modelData();
    if (modelData === undefined) return;
    if (modelData.rotationSpeed !== 0 && this.realTime > item.window.nextTime) {
      item.window.nextTime = (this.realTime + modelData.rotationSpeed) | 0;
      modelData.angle = ((modelData.angle + 1) | 0) % 360;
    }
    const handle = item.definition.assetHandle, asset = handle === undefined ? item.definition.asset : undefined;
    const model = handle === undefined ? asset?.kind === "model" ? this.models.get(resourceKey(asset.path)) : undefined
      : handle === 0 && this.options.resources.handles.kind === "diagnostic" ? DEFAULT_MODEL : this.sourceHandles().modelForHandle(handle);
    if (model === undefined) throw new Error(`UI model ${asset?.path ?? "NULL"} was not resolved before runtime use`);
    this.options.paintModel({
      draw, model,
      rect: { x: f(item.window.rect.x + 1), y: f(item.window.rect.y + 1), width: f(item.window.rect.width - 2), height: f(item.window.rect.height - 2) },
      time: this.realTime, angle: modelData.angle,
      fieldOfViewX: modelData.fieldOfViewX,
      fieldOfViewY: modelData.fieldOfViewY,
    });
  }

  private async paintOwnerDraw(item: ItemState, draw: Draw2D): Promise<void> {
    const menu = this.menuFor(item);
    this.fade(item.window, "fore", menu.definition.fadeClamp, menu.definition.fadeCycle, true, menu.definition.fadeAmount);
    let color = copyColor(item.window.foreColor);
    if (item.definition.colorRanges.length > 0) {
      const value = this.options.ownerDraw.value(item.definition.window.ownerDraw);
      for (const range of item.definition.colorRanges) if (value >= range.low && value <= range.high) { color = copyColor(range.color); break; }
    }
    if ((item.window.flags & UiWindowFlag.HasFocus) !== 0) color = this.pulse(menu.definition.focusColor);
    else if (item.definition.textStyle === 1 && (Math.trunc(this.realTime / BLINK_DIVISOR) & 1) === 0) color = this.pulse(item.window.foreColor);
    if (!this.itemPassesCvar(item, "enable")) color = copyColor(menu.definition.disableColor);
    let rect = copyRect(item.window.rect), textX = item.definition.textAlignX;
    if (item.definition.text !== undefined) {
      this.paintText(item, draw);
      rect = { ...rect, x: f(f(item.textRect.x + item.textRect.width) + (item.definition.text.length > 0 ? 8 : 0)) };
      textX = 0;
    }
    await this.options.ownerDraw.paint({ draw, rect, textX, textY: item.definition.textAlignY,
      ownerDraw: item.definition.window.ownerDraw, ownerDrawFlags: item.definition.window.ownerDrawFlags,
      alignment: item.definition.alignment, special: item.special, textScale: item.definition.textScale,
      color, background: this.windowBackground(item.window), textStyle: item.definition.textStyle });
  }

  private async paintList(item: ItemState, draw: Draw2D): Promise<void> {
    const list = item.definition.listData();
    const count = f(this.options.feeder.count(item.special));
    let x: number, y: number, size: number;
    if ((item.window.flags & UiWindowFlag.Horizontal) !== 0) {
      x = f(item.window.rect.x + 1); y = f(f(f(item.window.rect.y + item.window.rect.height) - SCROLLBAR_SIZE) - 1);
      draw.drawHandlePic({ x, y, width: SCROLLBAR_SIZE, height: SCROLLBAR_SIZE }, this.options.widgetAssets.scrollBarArrowLeft);
      x = f(x + SCROLLBAR_SIZE - 1); size = f(item.window.rect.width - SCROLLBAR_SIZE * 2);
      draw.drawHandlePic({ x, y, width: f(size + 1), height: SCROLLBAR_SIZE }, this.options.widgetAssets.scrollBar);
      x = f(x + f(size - 1)); draw.drawHandlePic({ x, y, width: SCROLLBAR_SIZE, height: SCROLLBAR_SIZE }, this.options.widgetAssets.scrollBarArrowRight);
      const thumb = Math.min(f(this.listThumbDrawPosition(item)), f(f(x - SCROLLBAR_SIZE) - 1));
      draw.drawHandlePic({ x: thumb, y, width: SCROLLBAR_SIZE, height: SCROLLBAR_SIZE }, this.options.widgetAssets.scrollBarThumb);
      if (list === undefined) throw new Error("Item_ListBox_Paint dereferences NULL list data");
      list.endPosition = list.startPosition; size = f(item.window.rect.width - 2);
      if (list.elementStyle !== 1) return;
      x = f(item.window.rect.x + 1); y = f(item.window.rect.y + 1);
      for (let i = f(list.startPosition); i < count; i = f(i + 1)) {
        const picture = await this.options.feeder.image(item.special, qvmFloatToInt(i)); this.opened();
        if (picture !== undefined) draw.drawHandlePic({ x: f(x + 1), y: f(y + 1), width: f(list.elementWidth - 2), height: f(list.elementHeight - 2) }, picture);
        if (i === f(item.cursorPosition)) this.drawRect(draw, { x, y, width: f(list.elementWidth - 1), height: f(list.elementHeight - 1) }, item.definition.window.borderSize, item.window.borderColor);
        size = f(size - list.elementWidth);
        if (size < list.elementWidth) { list.drawPadding = qvmFloatToInt(size); break; }
        x = f(x + list.elementWidth); list.endPosition++;
      }
      return;
    }
    x = f(f(f(item.window.rect.x + item.window.rect.width) - SCROLLBAR_SIZE) - 1); y = f(item.window.rect.y + 1);
    draw.drawHandlePic({ x, y, width: SCROLLBAR_SIZE, height: SCROLLBAR_SIZE }, this.options.widgetAssets.scrollBarArrowUp);
    y = f(y + SCROLLBAR_SIZE - 1);
    if (list === undefined) throw new Error("Item_ListBox_Paint dereferences NULL list data");
    list.endPosition = list.startPosition;
    size = f(item.window.rect.height - SCROLLBAR_SIZE * 2);
    draw.drawHandlePic({ x, y, width: SCROLLBAR_SIZE, height: f(size + 1) }, this.options.widgetAssets.scrollBar);
    y = f(y + f(size - 1)); draw.drawHandlePic({ x, y, width: SCROLLBAR_SIZE, height: SCROLLBAR_SIZE }, this.options.widgetAssets.scrollBarArrowDown);
    const thumb = Math.min(f(this.listThumbDrawPosition(item)), f(f(y - SCROLLBAR_SIZE) - 1));
    draw.drawHandlePic({ x, y: thumb, width: SCROLLBAR_SIZE, height: SCROLLBAR_SIZE }, this.options.widgetAssets.scrollBarThumb);
    size = f(item.window.rect.height - 2); x = f(item.window.rect.x + 1); y = f(item.window.rect.y + 1);
    const imageStyle = list.elementStyle === 1;
    for (let i = f(list.startPosition); i < count; i = f(i + 1)) {
      if (imageStyle) {
        const picture = await this.options.feeder.image(item.special, qvmFloatToInt(i)); this.opened();
        if (picture !== undefined) draw.drawHandlePic({ x: f(x + 1), y: f(y + 1), width: f(list.elementWidth - 2), height: f(list.elementHeight - 2) }, picture);
        if (i === f(item.cursorPosition)) this.drawRect(draw, { x, y, width: f(list.elementWidth - 1), height: f(list.elementHeight - 1) }, item.definition.window.borderSize, item.window.borderColor);
        list.endPosition++;
        size = f(size - list.elementWidth);
      } else {
        if (list.columns.length > 0) {
          for (let columnIndex = 0; columnIndex < list.columns.length; columnIndex++) {
            const column = list.columns[columnIndex], entry = await this.options.feeder.item(item.special, qvmFloatToInt(i), columnIndex);
            this.opened();
            if (column === undefined || entry === undefined) continue;
            if (entry.picture !== undefined) draw.drawHandlePic({ x: f(f(x + 4) + f(column.position)), y: f(f(y - 1) + f(list.elementHeight / 2)), width: f(column.width), height: f(column.width) }, entry.picture);
            else if (entry.text !== null) textPaint(draw, this.options.fonts, { x: f(f(x + 4) + f(column.position)), y: f(y + list.elementHeight), scale: item.definition.textScale,
              color: item.window.foreColor, text: quakeString(entry.text), adjust: 0, limit: column.maxChars, style: item.definition.textStyle });
          }
        } else {
          const entry = await this.options.feeder.item(item.special, qvmFloatToInt(i), 0); this.opened();
          if (entry !== undefined && entry.picture === undefined && entry.text !== null) textPaint(draw, this.options.fonts, { x: f(x + 4), y: f(y + list.elementHeight), scale: item.definition.textScale,
            color: item.window.foreColor, text: quakeString(entry.text), adjust: 0, limit: 0, style: item.definition.textStyle });
        }
        if (i === f(item.cursorPosition)) draw.fillRect({ x: f(x + 2), y: f(y + 2), width: f(f(item.window.rect.width - SCROLLBAR_SIZE) - 4), height: list.elementHeight }, item.definition.window.outlineColor, this.options.widgetAssets.whiteShader);
        size = f(size - list.elementHeight);
      }
      const exhausted = size < list.elementHeight;
      if (exhausted) { list.drawPadding = qvmFloatToInt(f(list.elementHeight - size)); break; }
      if (!imageStyle) list.endPosition++;
      y = f(y + list.elementHeight);
    }
  }

  private cvarValue(name: string): number {
    return this.options.cvarValue === undefined ? this.options.cvars.get(name)?.numericValue ?? 0 : this.options.cvarValue(name);
  }

  private itemPassesCvar(item: ItemState, purpose: "enable" | "show"): boolean {
    const flag = purpose === "enable" ? 1 : 4;
    if ((item.definition.cvarFlags & (flag | flag << 1)) === 0) return true;
    const script = item.definition.cvarScript;
    if (script === undefined || script.text.length === 0 || item.definition.cvarTest === undefined
      || item.definition.cvarTest.length === 0) return true;
    const current = this.cvarBuffer(item.definition.cvarTest);
    const cursor = new RuntimeScriptCursor(script.text, this.sourceParser, this.definitions.memory);
    while (true) {
      const value = cursor.string();
      if (value === undefined) break;
      if (value === null) throw new Error("Item_EnableShowViaCvar dereferences NULL token after String_Alloc");
      if (value !== ";" && equalName(value, current)) return (item.definition.cvarFlags & flag) !== 0;
    }
    return (item.definition.cvarFlags & flag) === 0;
  }
}
