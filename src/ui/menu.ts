/*
 * Team Arena menu definition parsing translated from id Software's
 * code/ui/ui_shared.c, ui_shared.h, ui_main.c, and code/cgame/cg_main.c.
 * Copyright (C) 1999-2005 Id Software, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { Vec3, Vec4 } from "../core/math.ts";
import type { BotScriptSources } from "../botlib/script-sources.ts";
import { CommonParseCursor, CommonParseState, compressCommonText } from "../core/common-parse.ts";
import { TeamArenaUiMemory, UiStringReference, type UiMemoryAllocation } from "./team-arena/memory.ts";
import {
  ScriptLanguageError,
  type ScriptDiagnostic,
  type ScriptToken,
  type SourceLocation,
} from "../script/lexer.ts";
import {
  ScriptSourceReader,
  type IncludeResolver,
  type ScriptPreprocessorOptions,
  type ScriptSource,
  type ScriptSourcePosition,
  type ScriptTokenRecord,
} from "../script/preprocessor.ts";

export const MAX_UI_MENUS = 64;
export const MAX_UI_MENU_ITEMS = 96;
export const MAX_UI_COLOR_RANGES = 10;
export const MAX_UI_LIST_COLUMNS = 16;
export const MAX_UI_MULTI_CHOICES = 31;
export const MAX_UI_SCRIPT_BYTES = 1023;
export const MAX_HUD_MENU_SET_BYTES = 4095;

export enum UiWindowFlag {
  MouseOver = 0x0000_0001,
  HasFocus = 0x0000_0002,
  Visible = 0x0000_0004,
  Grey = 0x0000_0008,
  Decoration = 0x0000_0010,
  FadingOut = 0x0000_0020,
  FadingIn = 0x0000_0040,
  MouseOverText = 0x0000_0080,
  InTransition = 0x0000_0100,
  ForeColorSet = 0x0000_0200,
  Horizontal = 0x0000_0400,
  ListLeftArrow = 0x0000_0800,
  ListRightArrow = 0x0000_1000,
  ListThumb = 0x0000_2000,
  ListPageUp = 0x0000_4000,
  ListPageDown = 0x0000_8000,
  Orbiting = 0x0001_0000,
  OutOfBoundsClick = 0x0002_0000,
  Wrapped = 0x0004_0000,
  AutoWrapped = 0x0008_0000,
  Forced = 0x0010_0000,
  Popup = 0x0020_0000,
  BackColorSet = 0x0040_0000,
  TimedVisible = 0x0080_0000,
}

export enum UiItemTypeCode {
  Text = 0,
  Button = 1,
  RadioButton = 2,
  CheckBox = 3,
  EditField = 4,
  Combo = 5,
  ListBox = 6,
  Model = 7,
  OwnerDraw = 8,
  NumericField = 9,
  Slider = 10,
  YesNo = 11,
  Multi = 12,
  Bind = 13,
}

export interface UiRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type UiMutableRect = { -readonly [Field in keyof UiRect]: UiRect[Field] };
export type UiMutableColor = { -readonly [Field in keyof Vec4]: Vec4[Field] };

export interface UiShaderReference {
  readonly kind: "shader";
  readonly path: string | null;
}

export interface UiModelReference {
  readonly kind: "model";
  readonly path: string | null;
}

export interface UiSoundReference {
  readonly kind: "sound";
  readonly path: string | null;
}

export interface UiFontReference {
  readonly kind: "font";
  readonly path: string | null;
  readonly pointSize: number;
}

export interface UiScriptToken {
  readonly text: string;
  readonly location: SourceLocation;
}

export interface UiScript {
  readonly text: string;
  readonly tokens: readonly UiScriptToken[];
  readonly truncated: boolean;
}

export interface UiWindowDefinition {
  rect: UiMutableRect;
  clientRect: UiMutableRect;
  rectEffects: UiMutableRect;
  rectEffects2: UiMutableRect;
  readonly name: string | undefined;
  readonly group: string | undefined;
  readonly cinematic: string | undefined;
  readonly style: number;
  readonly border: number;
  readonly ownerDraw: number;
  readonly ownerDrawFlags: number;
  readonly borderSize: number;
  flags: number;
  nextTime: number;
  offsetTime: number;
  cinematicHandle: number;
  foreColor: UiMutableColor;
  backColor: UiMutableColor;
  borderColor: UiMutableColor;
  outlineColor: UiMutableColor;
  readonly background: UiShaderReference | undefined;
  readonly backgroundHandle: number | undefined;
  setBackground(value: UiShaderReference, handle: number | undefined): void;
}

export interface UiColorRange {
  readonly low: number;
  readonly high: number;
  readonly color: Vec4;
}

export interface UiEditFieldDefinition {
  readonly minimum: number;
  readonly maximum: number;
  readonly defaultValue: number;
  readonly range: number;
  readonly maxChars: number;
  readonly maxPaintChars: number;
  paintOffset: number;
}

export interface UiListColumn {
  readonly position: number;
  readonly width: number;
  readonly maxChars: number;
}

export interface UiListBoxDefinition {
  startPosition: number;
  endPosition: number;
  drawPadding: number;
  cursorPosition: number;
  readonly elementWidth: number;
  readonly elementHeight: number;
  readonly elementStyle: number;
  readonly columns: readonly UiListColumn[];
  readonly doubleClick: UiScript | undefined;
  readonly notSelectable: boolean;
}

export interface UiMultiDefinition {
  readonly count: number;
  readonly stringDefinition: boolean;
  label(index: number): string | undefined;
  stringValue(index: number): string | undefined;
  numberValue(index: number): number;
}

export interface UiModelDefinition {
  angle: number;
  readonly origin: Vec3;
  readonly fieldOfViewX: number;
  readonly fieldOfViewY: number;
  readonly rotationSpeed: number;
}

export type UiItemBehavior =
  | { readonly kind: "text"; readonly type: UiItemTypeCode.Text; readonly edit: UiEditFieldDefinition | undefined }
  | { readonly kind: "button"; readonly type: UiItemTypeCode.Button }
  | { readonly kind: "radio-button"; readonly type: UiItemTypeCode.RadioButton }
  | { readonly kind: "check-box"; readonly type: UiItemTypeCode.CheckBox }
  | { readonly kind: "edit-field"; readonly type: UiItemTypeCode.EditField; readonly edit: UiEditFieldDefinition }
  | { readonly kind: "combo"; readonly type: UiItemTypeCode.Combo }
  | { readonly kind: "list-box"; readonly type: UiItemTypeCode.ListBox; readonly list: UiListBoxDefinition }
  | { readonly kind: "model"; readonly type: UiItemTypeCode.Model; readonly model: UiModelDefinition | undefined }
  | { readonly kind: "owner-draw"; readonly type: UiItemTypeCode.OwnerDraw }
  | { readonly kind: "numeric-field"; readonly type: UiItemTypeCode.NumericField; readonly edit: UiEditFieldDefinition }
  | { readonly kind: "slider"; readonly type: UiItemTypeCode.Slider; readonly edit: UiEditFieldDefinition }
  | { readonly kind: "yes-no"; readonly type: UiItemTypeCode.YesNo; readonly edit: UiEditFieldDefinition }
  | { readonly kind: "multi"; readonly type: UiItemTypeCode.Multi; readonly multi: UiMultiDefinition | undefined }
  | { readonly kind: "bind"; readonly type: UiItemTypeCode.Bind; readonly edit: UiEditFieldDefinition }
  | { readonly kind: "unknown"; readonly type: number };

export type UiCvarRule =
  | { readonly kind: "enable"; readonly script: UiScript | undefined }
  | { readonly kind: "disable"; readonly script: UiScript | undefined }
  | { readonly kind: "show"; readonly script: UiScript | undefined }
  | { readonly kind: "hide"; readonly script: UiScript | undefined };

export interface UiItemDefinition {
  readonly location: SourceLocation;
  readonly allocationOffset: number | undefined;
  readonly window: UiWindowDefinition;
  readonly type: number;
  parent: UiMenuDefinition | undefined;
  textRect: UiMutableRect;
  readonly behavior: UiItemBehavior;
  readonly alignment: number;
  readonly textAlignment: number;
  readonly textAlignX: number;
  readonly textAlignY: number;
  readonly textScale: number;
  readonly textStyle: number;
  readonly text: string | undefined;
  readonly asset: UiShaderReference | UiModelReference | undefined;
  readonly assetHandle: number | undefined;
  readonly mouseEnterText: UiScript | undefined;
  readonly mouseExitText: UiScript | undefined;
  readonly mouseEnter: UiScript | undefined;
  readonly mouseExit: UiScript | undefined;
  readonly action: UiScript | undefined;
  readonly onFocus: UiScript | undefined;
  readonly leaveFocus: UiScript | undefined;
  readonly cvar: string | undefined;
  readonly cvarTest: string | undefined;
  readonly cvarRule: UiCvarRule | undefined;
  readonly cvarFlags: number;
  readonly cvarScript: UiScript | undefined;
  readonly focusSound: UiSoundReference | undefined;
  readonly focusSoundHandle: number | undefined;
  readonly colorRanges: readonly UiColorRange[];
  special: number;
  cursorPosition: number;
  editData(): UiEditFieldDefinition | undefined;
  listData(): UiListBoxDefinition | undefined;
  modelData(): UiModelDefinition | undefined;
  multiData(): UiMultiDefinition | undefined;
}

export interface UiMenuDefinition {
  readonly location: SourceLocation;
  readonly sourceIndex: number;
  readonly window: UiWindowDefinition;
  readonly font: string | undefined;
  readonly fullScreen: number;
  cursorItem: number;
  readonly fontIndex: number;
  readonly fadeCycle: number;
  readonly fadeClamp: number;
  readonly fadeAmount: number;
  readonly onOpen: UiScript | undefined;
  readonly onClose: UiScript | undefined;
  readonly onEscape: UiScript | undefined;
  readonly soundLoop: UiSoundReference | undefined;
  readonly focusColor: Vec4;
  readonly disableColor: Vec4;
  readonly items: readonly UiItemDefinition[];
  readonly itemCount: number;
  itemAt(index: number): UiItemDefinition | undefined;
}

export interface UiGlobalAssets {
  readonly textFont: UiFontReference | undefined;
  readonly smallFont: UiFontReference | undefined;
  readonly bigFont: UiFontReference | undefined;
  readonly cursor: UiShaderReference | undefined;
  readonly gradientBar: UiShaderReference | undefined;
  readonly menuEnterSound: UiSoundReference | undefined;
  readonly menuExitSound: UiSoundReference | undefined;
  readonly menuBuzzSound: UiSoundReference | undefined;
  readonly itemFocusSound: UiSoundReference | undefined;
  readonly fadeClamp: number;
  readonly fadeCycle: number;
  readonly fadeAmount: number;
  readonly shadowX: number;
  readonly shadowY: number;
  readonly shadowColor: Vec4;
  readonly shadowFadeClamp: number;
}

export type UiMenuRegistrationEvent =
  | { readonly kind: "font"; readonly reference: UiFontReference; readonly location: SourceLocation }
  | { readonly kind: "picture"; readonly reference: UiShaderReference; readonly location: SourceLocation }
  | { readonly kind: "sound"; readonly reference: UiSoundReference; readonly location: SourceLocation }
  | { readonly kind: "model"; readonly reference: UiModelReference; readonly location: SourceLocation };

export interface UiMenuRegistrationSink {
  register(event: UiMenuRegistrationEvent): Promise<UiMenuRegistrationResult>;
}

export type UiMenuRegistrationResult = void | { readonly handle: number };

export type UiMenuAssetPublication = {
  [Field in Exclude<keyof UiGlobalAssets, "shadowColor">]: { readonly field: Field; readonly value: Exclude<UiGlobalAssets[Field], undefined> }
}[Exclude<keyof UiGlobalAssets, "shadowColor">]
  | { readonly field: "shadowColorComponent"; readonly component: keyof Vec4; readonly value: number }
  | { readonly field: "fontRegistered"; readonly value: boolean }
  | { readonly field: "cursorStr"; readonly value: UiStringReference | null };

export interface UiMenuAssetSink {
  publish(event: UiMenuAssetPublication): void;
}

export type UiMenuRegistrationState =
  | { readonly kind: "deferred"; readonly events: readonly UiMenuRegistrationEvent[] }
  | { readonly kind: "completed"; readonly events: readonly UiMenuRegistrationEvent[] };

export interface UiMenuDefinitions {
  readonly memory: UiMenuMemoryOwnership;
  readonly menus: readonly UiMenuDefinition[];
  readonly assets: UiGlobalAssets;
  readonly loadedFiles: readonly string[];
  readonly diagnostics: readonly ScriptDiagnostic[];
  readonly registration: UiMenuRegistrationState;
  readonly fontRegistered: boolean;
}

export interface UiMenuResolver extends IncludeResolver {
  resolveRoot(path: string): ScriptSource | undefined;
}

export interface UiMenuRandom {
  /** Return the QVM rand() result in the inclusive range 0..32767. */
  nextInt(): number;
}

export interface UiMenuResolvedParseHost {
  readonly resolver: UiMenuResolver;
  readonly random: UiMenuRandom;
}

export type UiMenuParseHost = UiMenuResolvedParseHost | {
  readonly random: UiMenuRandom;
  scriptSources(): BotScriptSources;
  assertCurrentOperation(): void;
};

export interface UiMenuMemory {
  allocate(size: number): number | null;
  borrow(offset: number, size: number): UiMemoryAllocation;
  menuRecord(index: number): UiMemoryAllocation;
  stringAlloc(text: string | null): string | null;
  stringAllocReference(text: string | null): UiStringReference | null;
}

export type UiMenuMemoryOwnership =
  | { readonly kind: "unaccounted" }
  | { readonly kind: "qvm32"; readonly memory: UiMenuMemory };

export interface UiMenuParseOptions {
  readonly memory?: UiMenuMemoryOwnership;
  readonly registrationSink?: UiMenuRegistrationSink;
  readonly assetSink?: UiMenuAssetSink;
  readonly initialAssets?: UiGlobalAssets;
  readonly initialFontRegistered?: boolean;
  readonly menuSink?: UiMenuDefinitionSink;
  readonly reportDiagnostic?: (diagnostic: ScriptDiagnostic) => void;
}

export interface UiMenuDefinitionSink {
  menuCount(): number;
  publish(menu: UiMenuDefinition): Promise<void>;
}

export type UiMenuLoadPlan =
  | { readonly kind: "ui"; readonly setPaths: readonly string[] }
  | { readonly kind: "hud"; readonly setPath: string };

export function defaultUiMenuPlan(): UiMenuLoadPlan {
  return Object.freeze({ kind: "ui", setPaths: Object.freeze(["ui/menus.txt", "ui/ingame.txt"]) });
}

export function defaultHudMenuPlan(): UiMenuLoadPlan {
  return Object.freeze({ kind: "hud", setPath: "ui/hud.txt" });
}

function retainedRect(allocation: UiMemoryAllocation, offset: number): UiMutableRect {
  return Object.freeze({
    get x(): number { return allocation.getFloat32(offset); },
    set x(value: number) { allocation.setFloat32(offset, value); },
    get y(): number { return allocation.getFloat32(offset + 4); },
    set y(value: number) { allocation.setFloat32(offset + 4, value); },
    get width(): number { return allocation.getFloat32(offset + 8); },
    set width(value: number) { allocation.setFloat32(offset + 8, value); },
    get height(): number { return allocation.getFloat32(offset + 12); },
    set height(value: number) { allocation.setFloat32(offset + 12, value); },
  });
}

function retainedColor(allocation: UiMemoryAllocation, offset: number): UiMutableColor {
  return Object.freeze({
    get x(): number { return allocation.getFloat32(offset); },
    set x(value: number) { allocation.setFloat32(offset, value); },
    get y(): number { return allocation.getFloat32(offset + 4); },
    set y(value: number) { allocation.setFloat32(offset + 4, value); },
    get z(): number { return allocation.getFloat32(offset + 8); },
    set z(value: number) { allocation.setFloat32(offset + 8, value); },
    get w(): number { return allocation.getFloat32(offset + 12); },
    set w(value: number) { allocation.setFloat32(offset + 12, value); },
  });
}

function writeRect(destination: UiMutableRect, value: UiRect): void {
  destination.x = value.x; destination.y = value.y; destination.width = value.width; destination.height = value.height;
}

function writeColor(destination: UiMutableColor, value: Vec4): void {
  destination.x = value.x; destination.y = value.y; destination.z = value.z; destination.w = value.w;
}

class MutableWindow implements UiWindowDefinition {
  private readonly rectView: UiMutableRect;
  private readonly clientView: UiMutableRect;
  private readonly effectsView: UiMutableRect;
  private readonly effects2View: UiMutableRect;
  private readonly foreView: UiMutableColor;
  private readonly backView: UiMutableColor;
  private readonly borderView: UiMutableColor;
  private readonly outlineView: UiMutableColor;

  constructor(private readonly allocation: UiMemoryAllocation) {
    this.rectView = retainedRect(allocation, 0); this.clientView = retainedRect(allocation, 16);
    this.effectsView = retainedRect(allocation, 72); this.effects2View = retainedRect(allocation, 88);
    this.foreView = retainedColor(allocation, 112); this.backView = retainedColor(allocation, 128);
    this.borderView = retainedColor(allocation, 144); this.outlineView = retainedColor(allocation, 160);
  }

  initialize(): void {
    this.allocation.clear();
    this.borderSize = 1;
    this.foreColor = color(1, 1, 1, 1);
    this.allocation.setInt32(44, -1);
  }

  get rect(): UiMutableRect { return this.rectView; }
  set rect(value: UiRect) { writeRect(this.rectView, value); }
  get clientRect(): UiMutableRect { return this.clientView; }
  set clientRect(value: UiRect) { writeRect(this.clientView, value); }
  get rectEffects(): UiMutableRect { return this.effectsView; }
  set rectEffects(value: UiRect) { writeRect(this.effectsView, value); }
  get rectEffects2(): UiMutableRect { return this.effects2View; }
  set rectEffects2(value: UiRect) { writeRect(this.effects2View, value); }
  get foreColor(): UiMutableColor { return this.foreView; }
  set foreColor(value: Vec4) { writeColor(this.foreView, value); }
  get backColor(): UiMutableColor { return this.backView; }
  set backColor(value: Vec4) { writeColor(this.backView, value); }
  get borderColor(): UiMutableColor { return this.borderView; }
  set borderColor(value: Vec4) { writeColor(this.borderView, value); }
  get outlineColor(): UiMutableColor { return this.outlineView; }
  set outlineColor(value: Vec4) { writeColor(this.outlineView, value); }
  get name(): string | undefined { return this.allocation.getString(32); }
  set name(value: string | undefined) { this.allocation.setString(32, value); }
  get group(): string | undefined { return this.allocation.getString(36); }
  set group(value: string | undefined) { this.allocation.setString(36, value); }
  get cinematic(): string | undefined { return this.allocation.getString(40); }
  set cinematic(value: string | undefined) { this.allocation.setString(40, value); }
  get style(): number { return this.allocation.getInt32(48); }
  set style(value: number) { this.allocation.setInt32(48, value); }
  get border(): number { return this.allocation.getInt32(52); }
  set border(value: number) { this.allocation.setInt32(52, value); }
  get ownerDraw(): number { return this.allocation.getInt32(56); }
  set ownerDraw(value: number) { this.allocation.setInt32(56, value); }
  get ownerDrawFlags(): number { return this.allocation.getInt32(60); }
  set ownerDrawFlags(value: number) { this.allocation.setInt32(60, value); }
  get borderSize(): number { return this.allocation.getFloat32(64); }
  set borderSize(value: number) { this.allocation.setFloat32(64, value); }
  get flags(): number { return this.allocation.getInt32(68); }
  set flags(value: number) { this.allocation.setInt32(68, value); }
  get offsetTime(): number { return this.allocation.getInt32(104); }
  set offsetTime(value: number) { this.allocation.setInt32(104, value); }
  get nextTime(): number { return this.allocation.getInt32(108); }
  set nextTime(value: number) { this.allocation.setInt32(108, value); }
  get cinematicHandle(): number { return this.allocation.getInt32(44); }
  set cinematicHandle(value: number) { this.allocation.setInt32(44, value); }
  get background(): UiShaderReference | undefined {
    const value = this.allocation.getResource(176);
    if (value === undefined || value.kind === "shader") return value;
    throw new Error("UI window background aliases a different resource kind");
  }
  get backgroundHandle(): number | undefined { return this.allocation.getResourceHandle(176); }
  setBackground(value: UiShaderReference, handle: number | undefined): void { this.allocation.setResource(176, value, handle); }
}

class MutableEditField implements UiEditFieldDefinition {
  constructor(private readonly allocation: UiMemoryAllocation) {}

  get minimum(): number { return this.allocation.getFloat32(0); }
  set minimum(value: number) { this.allocation.setFloat32(0, value); }
  get maximum(): number { return this.allocation.getFloat32(4); }
  set maximum(value: number) { this.allocation.setFloat32(4, value); }
  get defaultValue(): number { return this.allocation.getFloat32(8); }
  set defaultValue(value: number) { this.allocation.setFloat32(8, value); }
  get range(): number { return this.allocation.getFloat32(12); }
  set range(value: number) { this.allocation.setFloat32(12, value); }
  get maxChars(): number { return this.allocation.getInt32(16); }
  set maxChars(value: number) { this.allocation.setInt32(16, value); }
  get maxPaintChars(): number { return this.allocation.getInt32(20); }
  set maxPaintChars(value: number) { this.allocation.setInt32(20, value); }
  get paintOffset(): number { return this.allocation.getInt32(24); }
  set paintOffset(value: number) { this.allocation.setInt32(24, value); }
}

class MutableListBox implements UiListBoxDefinition {
  private readonly columnViews: readonly UiListColumn[];

  constructor(private readonly allocation: UiMemoryAllocation) {
    this.columnViews = Array.from({ length: MAX_UI_LIST_COLUMNS }, (_, index) => {
      const offset = 32 + index * 12;
      return Object.freeze({
        get position(): number { return allocation.getInt32(offset); },
        get width(): number { return allocation.getInt32(offset + 4); },
        get maxChars(): number { return allocation.getInt32(offset + 8); },
      });
    });
  }

  get startPosition(): number { return this.allocation.getInt32(0); }
  set startPosition(value: number) { this.allocation.setInt32(0, value); }
  get endPosition(): number { return this.allocation.getInt32(4); }
  set endPosition(value: number) { this.allocation.setInt32(4, value); }
  get drawPadding(): number { return this.allocation.getInt32(8); }
  set drawPadding(value: number) { this.allocation.setInt32(8, value); }
  get cursorPosition(): number { return this.allocation.getInt32(12); }
  set cursorPosition(value: number) { this.allocation.setInt32(12, value); }
  get elementWidth(): number { return this.allocation.getFloat32(16); }
  set elementWidth(value: number) { this.allocation.setFloat32(16, value); }
  get elementHeight(): number { return this.allocation.getFloat32(20); }
  set elementHeight(value: number) { this.allocation.setFloat32(20, value); }
  get elementStyle(): number { return this.allocation.getInt32(24); }
  set elementStyle(value: number) { this.allocation.setInt32(24, value); }
  get columnCount(): number { return this.allocation.getInt32(28); }
  set columnCount(value: number) { this.allocation.setInt32(28, value); }
  get notSelectable(): boolean { return this.allocation.getInt32(228) !== 0; }
  set notSelectable(value: boolean) { this.allocation.setInt32(228, value ? 1 : 0); }
  get doubleClick(): UiScript | undefined { return this.allocation.getScript(224); }
  set doubleClick(value: UiScript | undefined) { this.allocation.setScript(224, value); }

  get columns(): readonly UiListColumn[] {
    const count = this.columnCount;
    if (count > MAX_UI_LIST_COLUMNS) throw new RangeError("listBoxDef_t columns exceed the source 16-slot array");
    return Object.freeze(this.columnViews.slice(0, Math.max(0, count)));
  }

  setColumn(index: number, column: UiListColumn): void {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_UI_LIST_COLUMNS) {
      throw new RangeError("listBoxDef_t column index exceeds the source 16-slot array");
    }
    const offset = 32 + index * 12;
    this.allocation.setInt32(offset, column.position);
    this.allocation.setInt32(offset + 4, column.width);
    this.allocation.setInt32(offset + 8, column.maxChars);
  }
}

class MutableMulti implements UiMultiDefinition {
  constructor(private readonly allocation: UiMemoryAllocation) {}

  get count(): number { return this.allocation.getInt32(384); }
  set count(value: number) { this.allocation.setInt32(384, value); }
  get stringDefinition(): boolean { return this.allocation.getInt32(388) !== 0; }
  set stringDefinition(value: boolean) { this.allocation.setInt32(388, value ? 1 : 0); }
  label(index: number): string | undefined { return this.allocation.getString(this.slot(index)); }
  stringValue(index: number): string | undefined { return this.allocation.getString(128 + this.slot(index)); }
  numberValue(index: number): number { return this.allocation.getFloat32(256 + this.slot(index)); }
  setLabel(index: number, value: string | UiStringReference | undefined): void { this.allocation.setString(this.slot(index), value); }
  setStringValue(index: number, value: string | UiStringReference | undefined): void { this.allocation.setString(128 + this.slot(index), value); }
  setNumberValue(index: number, value: number): void { this.allocation.setFloat32(256 + this.slot(index), value); }

  private slot(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= 32) throw new RangeError("multiDef_t index exceeds the source 32-slot arrays");
    return index * 4;
  }
}

class MutableModel implements UiModelDefinition {
  readonly origin: { x: number; y: number; z: number };

  constructor(private readonly allocation: UiMemoryAllocation) {
    this.origin = Object.freeze({
      get x(): number { return allocation.getFloat32(4); },
      set x(value: number) { allocation.setFloat32(4, value); },
      get y(): number { return allocation.getFloat32(8); },
      set y(value: number) { allocation.setFloat32(8, value); },
      get z(): number { return allocation.getFloat32(12); },
      set z(value: number) { allocation.setFloat32(12, value); },
    });
  }

  get angle(): number { return this.allocation.getInt32(0); }
  set angle(value: number) { this.allocation.setInt32(0, value); }
  get fieldOfViewX(): number { return this.allocation.getFloat32(16); }
  set fieldOfViewX(value: number) { this.allocation.setFloat32(16, value); }
  get fieldOfViewY(): number { return this.allocation.getFloat32(20); }
  set fieldOfViewY(value: number) { this.allocation.setFloat32(20, value); }
  get rotationSpeed(): number { return this.allocation.getInt32(24); }
  set rotationSpeed(value: number) { this.allocation.setInt32(24, value); }
}

type MutableItemBehavior =
  | { kind: "text"; type: UiItemTypeCode.Text; edit: MutableEditField | undefined }
  | { kind: "button"; type: UiItemTypeCode.Button }
  | { kind: "radio-button"; type: UiItemTypeCode.RadioButton }
  | { kind: "check-box"; type: UiItemTypeCode.CheckBox }
  | { kind: "edit-field"; type: UiItemTypeCode.EditField; edit: MutableEditField }
  | { kind: "combo"; type: UiItemTypeCode.Combo }
  | { kind: "list-box"; type: UiItemTypeCode.ListBox; list: MutableListBox }
  | { kind: "model"; type: UiItemTypeCode.Model; model: MutableModel | undefined }
  | { kind: "owner-draw"; type: UiItemTypeCode.OwnerDraw }
  | { kind: "numeric-field"; type: UiItemTypeCode.NumericField; edit: MutableEditField }
  | { kind: "slider"; type: UiItemTypeCode.Slider; edit: MutableEditField }
  | { kind: "yes-no"; type: UiItemTypeCode.YesNo; edit: MutableEditField }
  | { kind: "multi"; type: UiItemTypeCode.Multi; multi: MutableMulti | undefined }
  | { kind: "bind"; type: UiItemTypeCode.Bind; edit: MutableEditField }
  | { kind: "unknown"; type: number };

class MutableItem {
  readonly window: MutableWindow;
  readonly definition: UiItemDefinition;
  private readonly textView: UiMutableRect;
  private readonly colors: readonly UiColorRange[];
  private readonly editViews = new WeakMap<UiMemoryAllocation, MutableEditField>();
  private readonly listViews = new WeakMap<UiMemoryAllocation, MutableListBox>();
  private readonly modelViews = new WeakMap<UiMemoryAllocation, MutableModel>();
  private readonly multiViews = new WeakMap<UiMemoryAllocation, MutableMulti>();

  constructor(readonly allocation: UiMemoryAllocation, readonly location: SourceLocation, readonly allocationOffset: number | undefined) {
    this.window = new MutableWindow(allocation.subrecord(0, 180));
    this.textView = retainedRect(allocation, 180);
    this.colors = Array.from({ length: MAX_UI_COLOR_RANGES }, (_, index) => {
      const offset = 288 + index * 24, colorView = retainedColor(allocation, offset);
      return Object.freeze({
        color: colorView,
        get low(): number { return allocation.getFloat32(offset + 16); },
        get high(): number { return allocation.getFloat32(offset + 20); },
      });
    });
    this.definition = freezeItem(this);
  }

  initialize(): void {
    this.allocation.clear(); this.textScale = .55; this.window.initialize();
  }
  get textRect(): UiMutableRect { return this.textView; }
  set textRect(value: UiRect) { writeRect(this.textView, value); }
  get type(): number { return this.allocation.getInt32(196); }
  set type(value: number) { this.allocation.setInt32(196, value); }
  get alignment(): number { return this.allocation.getInt32(200); }
  set alignment(value: number) { this.allocation.setInt32(200, value); }
  get textAlignment(): number { return this.allocation.getInt32(204); }
  set textAlignment(value: number) { this.allocation.setInt32(204, value); }
  get textAlignX(): number { return this.allocation.getFloat32(208); }
  set textAlignX(value: number) { this.allocation.setFloat32(208, value); }
  get textAlignY(): number { return this.allocation.getFloat32(212); }
  set textAlignY(value: number) { this.allocation.setFloat32(212, value); }
  get textScale(): number { return this.allocation.getFloat32(216); }
  set textScale(value: number) { this.allocation.setFloat32(216, value); }
  get textStyle(): number { return this.allocation.getInt32(220); }
  set textStyle(value: number) { this.allocation.setInt32(220, value); }
  get text(): string | undefined { return this.allocation.getString(224); }
  set text(value: string | undefined) { this.allocation.setString(224, value); }
  get parent(): UiMenuDefinition | undefined { return this.allocation.getMenu(228); }
  set parent(value: UiMenuDefinition | undefined) { this.allocation.setMenu(228, value); }
  get asset(): UiShaderReference | UiModelReference | undefined {
    const value = this.allocation.getResource(232);
    if (value === undefined || value.kind === "shader" || value.kind === "model") return value;
    throw new Error("UI item asset aliases a sound handle");
  }
  get assetHandle(): number | undefined { return this.allocation.getResourceHandle(232); }
  setAsset(value: UiShaderReference | UiModelReference, handle: number | undefined): void { this.allocation.setResource(232, value, handle); }
  get mouseEnterText(): UiScript | undefined { return this.allocation.getScript(236); }
  set mouseEnterText(value: UiScript | undefined) { this.allocation.setScript(236, value); }
  get mouseExitText(): UiScript | undefined { return this.allocation.getScript(240); }
  set mouseExitText(value: UiScript | undefined) { this.allocation.setScript(240, value); }
  get mouseEnter(): UiScript | undefined { return this.allocation.getScript(244); }
  set mouseEnter(value: UiScript | undefined) { this.allocation.setScript(244, value); }
  get mouseExit(): UiScript | undefined { return this.allocation.getScript(248); }
  set mouseExit(value: UiScript | undefined) { this.allocation.setScript(248, value); }
  get action(): UiScript | undefined { return this.allocation.getScript(252); }
  set action(value: UiScript | undefined) { this.allocation.setScript(252, value); }
  get onFocus(): UiScript | undefined { return this.allocation.getScript(256); }
  set onFocus(value: UiScript | undefined) { this.allocation.setScript(256, value); }
  get leaveFocus(): UiScript | undefined { return this.allocation.getScript(260); }
  set leaveFocus(value: UiScript | undefined) { this.allocation.setScript(260, value); }
  get cvar(): string | undefined { return this.allocation.getString(264); }
  set cvar(value: string | undefined) { this.allocation.setString(264, value); }
  get cvarTest(): string | undefined { return this.allocation.getString(268); }
  set cvarTest(value: string | undefined) { this.allocation.setString(268, value); }
  get cvarScript(): UiScript | undefined { return this.allocation.getScript(272); }
  get cvarFlags(): number { return this.allocation.getInt32(276); }
  get cvarRule(): UiCvarRule | undefined {
    const flags = this.cvarFlags;
    if ((flags & 15) === 0) return undefined;
    const script = this.cvarScript;
    if ((flags & 1) !== 0) return { kind: "enable", script };
    if ((flags & 2) !== 0) return { kind: "disable", script };
    if ((flags & 4) !== 0) return { kind: "show", script };
    if ((flags & 8) !== 0) return { kind: "hide", script };
    return undefined;
  }
  set cvarRule(value: UiCvarRule | undefined) {
    this.allocation.setScript(272, value?.script);
    this.allocation.setInt32(276, value === undefined ? 0 : value.kind === "enable" ? 1 : value.kind === "disable" ? 2 : value.kind === "show" ? 4 : 8);
  }
  get focusSound(): UiSoundReference | undefined {
    const value = this.allocation.getResource(280);
    if (value === undefined || value.kind === "sound") return value;
    throw new Error("UI focus sound aliases a different resource kind");
  }
  get focusSoundHandle(): number | undefined { return this.allocation.getResourceHandle(280); }
  setFocusSound(value: UiSoundReference, handle: number | undefined): void { this.allocation.setResource(280, value, handle); }
  get colorCount(): number { return this.allocation.getInt32(284); }
  set colorCount(value: number) { this.allocation.setInt32(284, value); }
  get colorRanges(): readonly UiColorRange[] {
    const count = this.colorCount;
    if (count > MAX_UI_COLOR_RANGES) throw new RangeError("UI color ranges exceed the source array");
    return Object.freeze(this.colors.slice(0, Math.max(0, count)));
  }
  addColorRange(value: UiColorRange): void {
    const index = this.colorCount;
    if (index >= MAX_UI_COLOR_RANGES) return;
    if (index < 0) throw new RangeError("UI color range index is negative");
    const offset = 288 + index * 24;
    writeColor(retainedColor(this.allocation, offset), value.color);
    this.allocation.setFloat32(offset + 16, value.low); this.allocation.setFloat32(offset + 20, value.high);
    this.colorCount = index + 1;
  }
  get special(): number { return this.allocation.getFloat32(528); }
  set special(value: number) { this.allocation.setFloat32(528, value); }
  get cursorPosition(): number { return this.allocation.getInt32(532); }
  set cursorPosition(value: number) { this.allocation.setInt32(532, value); }
  get typeData(): UiMemoryAllocation | undefined { return this.allocation.getAllocationPointer(536); }
  set typeData(value: UiMemoryAllocation | undefined) { this.allocation.setAllocationPointer(536, value); }
  get hasTypeData(): boolean { return !this.allocation.isNullPointer(536); }

  editData(): MutableEditField | undefined {
    const data = this.typeData;
    if (data === undefined) return undefined;
    let view = this.editViews.get(data);
    if (view === undefined) { view = new MutableEditField(data.dereference(28)); this.editViews.set(data, view); }
    return view;
  }
  listData(): MutableListBox | undefined {
    const data = this.typeData;
    if (data === undefined) return undefined;
    let view = this.listViews.get(data);
    if (view === undefined) { view = new MutableListBox(data.dereference(232)); this.listViews.set(data, view); }
    return view;
  }
  modelData(): MutableModel | undefined {
    const data = this.typeData;
    if (data === undefined) return undefined;
    let view = this.modelViews.get(data);
    if (view === undefined) { view = new MutableModel(data.dereference(28)); this.modelViews.set(data, view); }
    return view;
  }
  multiData(): MutableMulti | undefined {
    const data = this.typeData;
    if (data === undefined) return undefined;
    let view = this.multiViews.get(data);
    if (view === undefined) { view = new MutableMulti(data.dereference(392)); this.multiViews.set(data, view); }
    return view;
  }

  get behavior(): MutableItemBehavior {
    const item = this;
    switch (this.type) {
      case UiItemTypeCode.Text: return { kind: "text", type: UiItemTypeCode.Text, get edit() { return item.editData(); } };
      case UiItemTypeCode.Button: return { kind: "button", type: UiItemTypeCode.Button };
      case UiItemTypeCode.RadioButton: return { kind: "radio-button", type: UiItemTypeCode.RadioButton };
      case UiItemTypeCode.CheckBox: return { kind: "check-box", type: UiItemTypeCode.CheckBox };
      case UiItemTypeCode.EditField: return { kind: "edit-field", type: UiItemTypeCode.EditField, get edit() { return item.requiredEditData(); } };
      case UiItemTypeCode.Combo: return { kind: "combo", type: UiItemTypeCode.Combo };
      case UiItemTypeCode.ListBox: return { kind: "list-box", type: UiItemTypeCode.ListBox, get list() {
        const data = item.listData(); if (data === undefined) throw new Error("UI list operation dereferences NULL typeData"); return data;
      } };
      case UiItemTypeCode.Model: return { kind: "model", type: UiItemTypeCode.Model, get model() { return item.modelData(); } };
      case UiItemTypeCode.OwnerDraw: return { kind: "owner-draw", type: UiItemTypeCode.OwnerDraw };
      case UiItemTypeCode.NumericField: return { kind: "numeric-field", type: UiItemTypeCode.NumericField, get edit() { return item.requiredEditData(); } };
      case UiItemTypeCode.Slider: return { kind: "slider", type: UiItemTypeCode.Slider, get edit() { return item.requiredEditData(); } };
      case UiItemTypeCode.YesNo: return { kind: "yes-no", type: UiItemTypeCode.YesNo, get edit() { return item.requiredEditData(); } };
      case UiItemTypeCode.Multi: return { kind: "multi", type: UiItemTypeCode.Multi, get multi() { return item.multiData(); } };
      case UiItemTypeCode.Bind: return { kind: "bind", type: UiItemTypeCode.Bind, get edit() { return item.requiredEditData(); } };
      default: return { kind: "unknown", type: this.type };
    }
  }

  private requiredEditData(): MutableEditField {
    const data = this.editData();
    if (data === undefined) throw new Error("UI edit operation dereferences NULL typeData");
    return data;
  }
}

class MutableMenu {
  readonly window: MutableWindow;
  readonly definition: UiMenuDefinition;
  private readonly focusView: UiMutableColor;
  private readonly disableView: UiMutableColor;

  constructor(readonly allocation: UiMemoryAllocation, readonly location: SourceLocation) {
    this.window = new MutableWindow(allocation.subrecord(0, 180));
    this.focusView = retainedColor(allocation, 228); this.disableView = retainedColor(allocation, 244);
    this.definition = freezeMenu(this);
  }
  initialize(assets: MutableAssets): void {
    this.allocation.clear(); this.cursorItem = -1;
    this.fadeAmount = assets.fadeAmount; this.fadeClamp = assets.fadeClamp; this.fadeCycle = assets.fadeCycle;
    this.window.initialize();
  }
  get sourceIndex(): number { return this.allocation.offset / 644; }
  get font(): string | undefined { return this.allocation.getString(180); }
  set font(value: string | undefined) { this.allocation.setString(180, value); }
  get fullScreen(): number { return this.allocation.getInt32(184); }
  set fullScreen(value: number) { this.allocation.setInt32(184, value); }
  get itemCount(): number { return this.allocation.getInt32(188); }
  set itemCount(value: number) { this.allocation.setInt32(188, value); }
  get fontIndex(): number { return this.allocation.getInt32(192); }
  get cursorItem(): number { return this.allocation.getInt32(196); }
  set cursorItem(value: number) { this.allocation.setInt32(196, value); }
  get fadeCycle(): number { return this.allocation.getInt32(200); }
  set fadeCycle(value: number) { this.allocation.setInt32(200, value); }
  get fadeClamp(): number { return this.allocation.getFloat32(204); }
  set fadeClamp(value: number) { this.allocation.setFloat32(204, value); }
  get fadeAmount(): number { return this.allocation.getFloat32(208); }
  set fadeAmount(value: number) { this.allocation.setFloat32(208, value); }
  get onOpen(): UiScript | undefined { return this.allocation.getScript(212); }
  set onOpen(value: UiScript | undefined) { this.allocation.setScript(212, value); }
  get onClose(): UiScript | undefined { return this.allocation.getScript(216); }
  set onClose(value: UiScript | undefined) { this.allocation.setScript(216, value); }
  get onEscape(): UiScript | undefined { return this.allocation.getScript(220); }
  set onEscape(value: UiScript | undefined) { this.allocation.setScript(220, value); }
  get soundLoop(): UiSoundReference | undefined {
    const path = this.allocation.getString(224); return path === undefined ? undefined : sound(path);
  }
  set soundLoop(value: UiSoundReference | undefined) { this.allocation.setString(224, value?.path ?? undefined); }
  get focusColor(): UiMutableColor { return this.focusView; }
  set focusColor(value: Vec4) { writeColor(this.focusView, value); }
  get disableColor(): UiMutableColor { return this.disableView; }
  set disableColor(value: Vec4) { writeColor(this.disableView, value); }
  setItem(index: number, item: UiItemDefinition | undefined): void {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_UI_MENU_ITEMS) throw new RangeError("UI menu item slot exceeds the source array");
    this.allocation.setItem(260 + index * 4, item);
  }
  item(index: number): UiItemDefinition | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_UI_MENU_ITEMS) throw new RangeError("UI menu item slot exceeds the source array");
    return this.allocation.getItem(260 + index * 4);
  }
  get items(): readonly UiItemDefinition[] {
    const count = this.itemCount;
    if (count > MAX_UI_MENU_ITEMS) throw new RangeError("UI menu item count exceeds the source array");
    return Object.freeze(Array.from({ length: Math.max(0, count) }, (_, index) => {
      const item = this.allocation.getItem(260 + index * 4);
      if (item === undefined) throw new Error("UI menu dereferences a NULL item pointer");
      return item;
    }));
  }
}

interface MutableAssets {
  textFont: UiFontReference | undefined;
  smallFont: UiFontReference | undefined;
  bigFont: UiFontReference | undefined;
  cursor: UiShaderReference | undefined;
  gradientBar: UiShaderReference | undefined;
  menuEnterSound: UiSoundReference | undefined;
  menuExitSound: UiSoundReference | undefined;
  menuBuzzSound: UiSoundReference | undefined;
  itemFocusSound: UiSoundReference | undefined;
  fadeClamp: number;
  fadeCycle: number;
  fadeAmount: number;
  shadowX: number;
  shadowY: number;
  shadowColor: Vec4;
  shadowFadeClamp: number;
}

function sourceLocation(value: SourceLocation): SourceLocation {
  return Object.freeze({ path: value.path, line: value.line, column: value.column });
}

function color(x = 0, y = 0, z = 0, w = 0): Vec4 {
  return Object.freeze({ x: Math.fround(x), y: Math.fround(y), z: Math.fround(z), w: Math.fround(w) });
}

function shader(path: string | null): UiShaderReference {
  return Object.freeze({ kind: "shader", path });
}

function model(path: string | null): UiModelReference {
  return Object.freeze({ kind: "model", path });
}

function sound(path: string | null): UiSoundReference {
  return Object.freeze({ kind: "sound", path });
}

function font(path: string | null, pointSize: number): UiFontReference {
  return Object.freeze({ kind: "font", path, pointSize });
}

function newAssets(initial: UiGlobalAssets | undefined): MutableAssets {
  if (initial !== undefined) {
    return {
      ...initial,
      shadowColor: color(initial.shadowColor.x, initial.shadowColor.y, initial.shadowColor.z, initial.shadowColor.w),
    };
  }
  return {
    textFont: undefined,
    smallFont: undefined,
    bigFont: undefined,
    cursor: undefined,
    gradientBar: undefined,
    menuEnterSound: undefined,
    menuExitSound: undefined,
    menuBuzzSound: undefined,
    itemFocusSound: undefined,
    fadeClamp: 0,
    fadeCycle: 0,
    fadeAmount: 0,
    shadowX: 0,
    shadowY: 0,
    shadowColor: color(),
    shadowFadeClamp: 0,
  };
}

export interface UiMenuTokenSource {
  readonly path: string;
  next(): ScriptTokenRecord | undefined;
  position(): ScriptSourcePosition;
  dispose(): void;
}

export class UiMenuTokenCursor {
  constructor(private readonly source: UiMenuTokenSource) {}

  static open(source: ScriptSource, resolver: IncludeResolver, options: ScriptPreprocessorOptions = {}): UiMenuTokenCursor {
    const reader = ScriptSourceReader.open(source, resolver, options);
    return new UiMenuTokenCursor({
      path: source.path,
      next: () => {
        try { return reader.next(); }
        catch (error) {
          if (reader.isSourceFailure(error)) return undefined;
          throw error;
        }
      },
      position: () => reader.position,
      dispose: () => reader.dispose(),
    });
  }

  static openHandle(path: string, sources: () => BotScriptSources, current: () => void): UiMenuTokenCursor | undefined {
    current();
    const handle = sources().loadSourceHandle(path);
    current();
    if (handle === 0) return undefined;
    return new UiMenuTokenCursor({
      path,
      next: () => {
        current();
        const token = sources().readTokenHandle(handle);
        current();
        return token;
      },
      position: () => {
        current();
        const position = sources().sourceFileAndLine(handle);
        current();
        return position ?? { filename: "", line: 0 };
      },
      dispose: () => {
        current();
        sources().freeSourceHandle(handle);
        current();
      },
    });
  }

  get path(): string { return this.source.path; }
  get position(): ScriptSourcePosition { return this.source.position(); }
  next(): ScriptToken | undefined { return this.source.next()?.token; }
  dispose(): void { this.source.dispose(); }
}

class MenuParseFailure extends Error {
  constructor(readonly cursor: UiMenuTokenCursor, message: string) { super(message); }
}

function cString(value: string): string {
  const nul = value.indexOf("\0");
  return nul < 0 ? value : value.slice(0, nul);
}

function tokenValue(token: ScriptToken): string {
  return cString(token.kind === "string" ? token.value : token.text);
}

function int32(value: number): number {
  return value | 0;
}

function freezeWindow(window: MutableWindow): UiWindowDefinition {
  return Object.freeze({
    get rect() { return window.rect; }, set rect(value: UiRect) { window.rect = value; },
    get clientRect() { return window.clientRect; }, set clientRect(value: UiRect) { window.clientRect = value; },
    get rectEffects() { return window.rectEffects; }, set rectEffects(value: UiRect) { window.rectEffects = value; },
    get rectEffects2() { return window.rectEffects2; }, set rectEffects2(value: UiRect) { window.rectEffects2 = value; },
    get name() { return window.name; }, get group() { return window.group; }, get cinematic() { return window.cinematic; },
    get style() { return window.style; }, get border() { return window.border; }, get ownerDraw() { return window.ownerDraw; },
    get ownerDrawFlags() { return window.ownerDrawFlags; }, get borderSize() { return window.borderSize; },
    get flags() { return window.flags; }, set flags(value: number) { window.flags = value; },
    get nextTime() { return window.nextTime; }, set nextTime(value: number) { window.nextTime = value; },
    get offsetTime() { return window.offsetTime; }, set offsetTime(value: number) { window.offsetTime = value; },
    get cinematicHandle() { return window.cinematicHandle; }, set cinematicHandle(value: number) { window.cinematicHandle = value; },
    get foreColor() { return window.foreColor; }, set foreColor(value: Vec4) { window.foreColor = value; },
    get backColor() { return window.backColor; }, set backColor(value: Vec4) { window.backColor = value; },
    get borderColor() { return window.borderColor; }, set borderColor(value: Vec4) { window.borderColor = value; },
    get outlineColor() { return window.outlineColor; }, set outlineColor(value: Vec4) { window.outlineColor = value; },
    get background() { return window.background; }, get backgroundHandle() { return window.backgroundHandle; },
    setBackground(value: UiShaderReference, handle: number | undefined) { window.setBackground(value, handle); },
  });
}

function freezeItem(item: MutableItem): UiItemDefinition {
  return Object.freeze({
    location: item.location, allocationOffset: item.allocationOffset, window: freezeWindow(item.window),
    get type() { return item.type; }, get parent() { return item.parent; }, set parent(value: UiMenuDefinition | undefined) { item.parent = value; },
    get behavior() { return freezeBehavior(item.behavior); },
    get textRect() { return item.textRect; }, set textRect(value: UiRect) { item.textRect = value; },
    get alignment() { return item.alignment; }, get textAlignment() { return item.textAlignment; },
    get textAlignX() { return item.textAlignX; }, get textAlignY() { return item.textAlignY; },
    get textScale() { return item.textScale; }, get textStyle() { return item.textStyle; }, get text() { return item.text; },
    get asset() { return item.asset; }, get assetHandle() { return item.assetHandle; },
    get mouseEnterText() { return item.mouseEnterText; }, get mouseExitText() { return item.mouseExitText; },
    get mouseEnter() { return item.mouseEnter; }, get mouseExit() { return item.mouseExit; },
    get action() { return item.action; }, get onFocus() { return item.onFocus; }, get leaveFocus() { return item.leaveFocus; },
    get cvar() { return item.cvar; }, get cvarTest() { return item.cvarTest; }, get cvarRule() { return item.cvarRule; },
    get cvarFlags() { return item.cvarFlags; }, get cvarScript() { return item.cvarScript; },
    get focusSound() { return item.focusSound; }, get focusSoundHandle() { return item.focusSoundHandle; },
    get colorRanges() { return item.colorRanges; },
    get special() { return item.special; }, set special(value: number) { item.special = value; },
    get cursorPosition() { return item.cursorPosition; }, set cursorPosition(value: number) { item.cursorPosition = value; },
    editData() { const data = item.editData(); return data === undefined ? undefined : freezeEdit(data); },
    listData() { const data = item.listData(); return data === undefined ? undefined : freezeList(data); },
    modelData() { const data = item.modelData(); return data === undefined ? undefined : freezeModel(data); },
    multiData() { const data = item.multiData(); return data === undefined ? undefined : freezeMulti(data); },
  });
}

function freezeMenu(menu: MutableMenu): UiMenuDefinition {
  return Object.freeze({
    location: menu.location, sourceIndex: menu.sourceIndex, window: freezeWindow(menu.window),
    get font() { return menu.font; }, get fullScreen() { return menu.fullScreen; }, get fontIndex() { return menu.fontIndex; },
    get cursorItem() { return menu.cursorItem; }, set cursorItem(value: number) { menu.cursorItem = value; },
    get fadeCycle() { return menu.fadeCycle; }, get fadeClamp() { return menu.fadeClamp; }, get fadeAmount() { return menu.fadeAmount; },
    get onOpen() { return menu.onOpen; }, get onClose() { return menu.onClose; }, get onEscape() { return menu.onEscape; },
    get soundLoop() { return menu.soundLoop; }, get focusColor() { return menu.focusColor; }, get disableColor() { return menu.disableColor; },
    get items() { return menu.items; }, get itemCount() { return menu.itemCount; },
    itemAt(index: number) { return menu.item(index); },
  });
}

function freezeEdit(edit: MutableEditField): UiEditFieldDefinition {
  return Object.freeze({
    get minimum(): number { return edit.minimum; },
    get maximum(): number { return edit.maximum; },
    get defaultValue(): number { return edit.defaultValue; },
    get range(): number { return edit.range; },
    get maxChars(): number { return edit.maxChars; },
    get maxPaintChars(): number { return edit.maxPaintChars; },
    get paintOffset(): number { return edit.paintOffset; },
    set paintOffset(value: number) { edit.paintOffset = value; },
  });
}

function freezeList(list: MutableListBox): UiListBoxDefinition {
  return Object.freeze({
    get startPosition(): number { return list.startPosition; },
    set startPosition(value: number) { list.startPosition = value; },
    get endPosition(): number { return list.endPosition; },
    set endPosition(value: number) { list.endPosition = value; },
    get drawPadding(): number { return list.drawPadding; },
    set drawPadding(value: number) { list.drawPadding = value; },
    get cursorPosition(): number { return list.cursorPosition; },
    set cursorPosition(value: number) { list.cursorPosition = value; },
    get elementWidth(): number { return list.elementWidth; },
    get elementHeight(): number { return list.elementHeight; },
    get elementStyle(): number { return list.elementStyle; },
    get columns(): readonly UiListColumn[] { return list.columns; },
    get doubleClick() { return list.doubleClick; },
    get notSelectable(): boolean { return list.notSelectable; },
  });
}

function freezeMulti(multi: MutableMulti): UiMultiDefinition {
  return Object.freeze({
    get count(): number { return multi.count; },
    get stringDefinition(): boolean { return multi.stringDefinition; },
    label(index: number): string | undefined { return multi.label(index); },
    stringValue(index: number): string | undefined { return multi.stringValue(index); },
    numberValue(index: number): number { return multi.numberValue(index); },
  });
}

function freezeModel(value: MutableModel): UiModelDefinition {
  return Object.freeze({
    get angle(): number { return value.angle; },
    set angle(angle: number) { value.angle = angle; },
    origin: value.origin,
    get fieldOfViewX(): number { return value.fieldOfViewX; },
    get fieldOfViewY(): number { return value.fieldOfViewY; },
    get rotationSpeed(): number { return value.rotationSpeed; },
  });
}

function freezeBehavior(behavior: MutableItemBehavior): UiItemBehavior {
  switch (behavior.kind) {
    case "text": return Object.freeze({ kind: "text", type: UiItemTypeCode.Text, get edit() { const data = behavior.edit; return data === undefined ? undefined : freezeEdit(data); } });
    case "button": return Object.freeze({ kind: "button", type: UiItemTypeCode.Button });
    case "radio-button": return Object.freeze({ kind: "radio-button", type: UiItemTypeCode.RadioButton });
    case "check-box": return Object.freeze({ kind: "check-box", type: UiItemTypeCode.CheckBox });
    case "edit-field": return Object.freeze({ kind: "edit-field", type: UiItemTypeCode.EditField, get edit() { return freezeEdit(behavior.edit); } });
    case "combo": return Object.freeze({ kind: "combo", type: UiItemTypeCode.Combo });
    case "list-box": return Object.freeze({ kind: "list-box", type: UiItemTypeCode.ListBox, get list() { return freezeList(behavior.list); } });
    case "model": return Object.freeze({ kind: "model", type: UiItemTypeCode.Model, get model() { const data = behavior.model; return data === undefined ? undefined : freezeModel(data); } });
    case "owner-draw": return Object.freeze({ kind: "owner-draw", type: UiItemTypeCode.OwnerDraw });
    case "numeric-field": return Object.freeze({ kind: "numeric-field", type: UiItemTypeCode.NumericField, get edit() { return freezeEdit(behavior.edit); } });
    case "slider": return Object.freeze({ kind: "slider", type: UiItemTypeCode.Slider, get edit() { return freezeEdit(behavior.edit); } });
    case "yes-no": return Object.freeze({ kind: "yes-no", type: UiItemTypeCode.YesNo, get edit() { return freezeEdit(behavior.edit); } });
    case "multi": return Object.freeze({ kind: "multi", type: UiItemTypeCode.Multi, get multi() { const data = behavior.multi; return data === undefined ? undefined : freezeMulti(data); } });
    case "bind": return Object.freeze({ kind: "bind", type: UiItemTypeCode.Bind, get edit() { return freezeEdit(behavior.edit); } });
    case "unknown": return Object.freeze({ kind: "unknown", type: behavior.type });
  }
}

function freezeAssets(assets: MutableAssets): UiGlobalAssets {
  return Object.freeze({
    ...assets,
    shadowColor: color(assets.shadowColor.x, assets.shadowColor.y, assets.shadowColor.z, assets.shadowColor.w),
  });
}

export class UiMenuSourceParser {
  private readonly memory: UiMenuMemoryOwnership;
  private readonly storage: UiMenuMemory;
  private readonly host: UiMenuParseHost;
  private readonly preprocessorOptions: ScriptPreprocessorOptions;
  private readonly menus: UiMenuDefinition[] = [];
  private readonly loadedFiles: string[] = [];
  private readonly reported: ScriptDiagnostic[] = [];
  private readonly assets: MutableAssets;
  private readonly registrations: UiMenuRegistrationEvent[] = [];
  private fontRegistered: boolean;

  constructor(
    host: UiMenuParseHost,
    preprocessorOptions: ScriptPreprocessorOptions,
    private readonly parseOptions: UiMenuParseOptions,
  ) {
    this.host = host;
    this.memory = parseOptions.memory ?? { kind: "unaccounted" };
    this.storage = this.memory.kind === "qvm32" ? this.memory.memory : new TeamArenaUiMemory("qvm32", () => {});
    this.preprocessorOptions = preprocessorOptions;
    this.assets = newAssets(parseOptions.initialAssets);
    this.fontRegistered = parseOptions.initialFontRegistered ?? false;
  }

  async load(plan: UiMenuLoadPlan): Promise<UiMenuDefinitions> {
    if (plan.kind === "ui") {
      for (const path of plan.setPaths) {
        await this.loadSet(path, false);
      }
    } else {
      await this.loadSet(plan.setPath, true);
    }
    return Object.freeze({
      memory: this.memory,
      menus: Object.freeze([...this.menus]),
      assets: freezeAssets(this.assets),
      loadedFiles: Object.freeze([...this.loadedFiles]),
      diagnostics: Object.freeze([...this.reported]),
      registration: Object.freeze({
        kind: this.parseOptions.registrationSink === undefined ? "deferred" : "completed",
        events: Object.freeze([...this.registrations]),
      }),
      fontRegistered: this.fontRegistered,
    });
  }

  private async register(event: UiMenuRegistrationEvent): Promise<UiMenuRegistrationResult> {
    const frozen = Object.freeze({ ...event, location: sourceLocation(event.location) });
    if (this.parseOptions.menuSink === undefined) this.registrations.push(frozen);
    if (this.parseOptions.registrationSink !== undefined) {
      return this.parseOptions.registrationSink.register(frozen);
    }
    return undefined;
  }

  private async loadSet(path: string, hud: boolean): Promise<void> {
    if (hud && !("resolver" in this.host)) throw new TypeError("HUD menu sets require a bounded COM text resolver");
    const source = this.resolveRoot(path, "menu set");
    this.loadedFiles.push(source.path);
    if (hud && !(source instanceof UiMenuTokenCursor)) {
      if (source.text.length > MAX_HUD_MENU_SET_BYTES) {
        this.fail(`menu file too large: ${source.path}`, sourceLocation({ path: source.path, line: 1, column: 1 }));
      }
      await this.loadHudSet(source);
      return;
    }
    const cursor = this.openSource(source);
    menuSet: while (true) {
      const token = cursor.next();
      if (token === undefined || tokenValue(token).length === 0 || tokenValue(token).startsWith("}")) {
        break;
      }
      if (tokenValue(token).toLowerCase() !== "loadmenu") {
        continue;
      }
      const opening = cursor.next();
      if (opening === undefined || !tokenValue(opening).startsWith("{")) break;
      while (true) {
        const file = cursor.next();
        if (file === undefined) break menuSet;
        const value = tokenValue(file);
        if (value.length === 0) break menuSet;
        if (value.startsWith("}")) {
          break;
        }
        await this.loadMenuFile(value, false);
      }
    }
    cursor.dispose();
  }

  private async loadHudSet(source: ScriptSource): Promise<void> {
    const parser = new CommonParseState();
    const cursor = new CommonParseCursor(compressCommonText(source.text));
    while (true) {
      const token = parser.parse(cursor);
      if (token.length === 0 || token.startsWith("}")) return;
      if (token.toLowerCase() !== "loadmenu") continue;
      if (!parser.parse(cursor).startsWith("{")) return;
      while (true) {
        const path = parser.parse(cursor);
        if (path === "}") break;
        if (path.length === 0) return;
        await this.loadMenuFile(path, true);
      }
    }
  }

  private openSource(source: ScriptSource | UiMenuTokenCursor): UiMenuTokenCursor {
    if (source instanceof UiMenuTokenCursor) return source;
    if (!("resolver" in this.host)) throw new TypeError("Parsed text sources require a diagnostic menu resolver");
    return UiMenuTokenCursor.open(source, this.host.resolver, {
      ...this.preprocessorOptions,
      report: diagnostic => {
        this.preprocessorOptions.report?.(diagnostic);
        this.reportDiagnostic(diagnostic);
      },
    });
  }

  private async loadMenuFile(path: string, hud: boolean): Promise<void> {
    let source = this.openFile(path);
    if (source === undefined && hud && path !== "ui/testhud.menu") {
      source = this.openFile("ui/testhud.menu");
    }
    if (source === undefined) return;
    await this.parseSource(source, hud);
  }

  async parseSource(source: ScriptSource | UiMenuTokenCursor, hud = false): Promise<void> {
    if (source.path.length === 0) this.fail("menu file resolver returned an empty canonical path", sourceLocation({ path: source.path, line: 1, column: 1 }));
    if (this.parseOptions.menuSink === undefined) this.loadedFiles.push(source.path);
    else this.reported.length = 0;
    const cursor = this.openSource(source);
    while (true) {
      const token = cursor.next();
      if (token === undefined || tokenValue(token).startsWith("}")) {
        break;
      }
      const keyword = tokenValue(token).toLowerCase();
      if (keyword === "assetglobaldef") {
        try { await this.parseAssets(cursor, token.location, hud); }
        catch (error) {
          if (!(error instanceof MenuParseFailure) || error.cursor !== cursor) throw error;
          break;
        }
      } else if (keyword === "menudef") {
        const sink = this.parseOptions.menuSink;
        const index = sink === undefined ? this.menus.length : sink.menuCount();
        if (index >= MAX_UI_MENUS) {
          if (sink === undefined) this.fail(`more than ${MAX_UI_MENUS} menus defined`, token.location);
          continue;
        }
        const menu = await this.parseMenu(cursor, token.location, index);
        if (menu === undefined) continue;
        // Menu_New increments the current count after parsing its original slot.
        // A reentrant registration may already have advanced that count.
        const publishedIndex = sink === undefined ? this.menus.length : sink.menuCount();
        const published = publishedIndex === index ? menu
          : new MutableMenu(this.storage.menuRecord(publishedIndex), sourceLocation(token.location)).definition;
        if (sink === undefined) this.menus.push(published);
        else await sink.publish(published);
      }
    }
    cursor.dispose();
  }

  private async parseAssets(cursor: UiMenuTokenCursor, start: SourceLocation, hud: boolean): Promise<void> {
    this.expect(cursor, "{", "expected { after assetGlobalDef", start);
    while (true) {
      const field = this.expectAny(cursor, "end of file inside assetGlobalDef", start);
      const value = tokenValue(field);
      if (value === "}") {
        return;
      }
      switch (value.toLowerCase()) {
        case "font": {
          const reference = this.readFont(cursor, field.location);
          await this.register({ kind: "font", reference, location: field.location });
          this.assets.textFont = reference;
          this.parseOptions.assetSink?.publish({ field: "textFont", value: reference });
          if (!hud) {
            this.fontRegistered = true;
            this.parseOptions.assetSink?.publish({ field: "fontRegistered", value: true });
          }
          break;
        }
        case "smallfont": {
          const reference = this.readFont(cursor, field.location);
          await this.register({ kind: "font", reference, location: field.location });
          this.assets.smallFont = reference;
          this.parseOptions.assetSink?.publish({ field: "smallFont", value: reference });
          break;
        }
        case "bigfont": {
          const reference = this.readFont(cursor, field.location);
          await this.register({ kind: "font", reference, location: field.location });
          this.assets.bigFont = reference;
          this.parseOptions.assetSink?.publish({ field: "bigFont", value: reference });
          break;
        }
        case "gradientbar": {
          const reference = shader(this.readString(cursor, field.location) ?? null);
          await this.register({ kind: "picture", reference, location: field.location });
          this.assets.gradientBar = reference;
          this.parseOptions.assetSink?.publish({ field: "gradientBar", value: reference });
          break;
        }
        case "menuentersound": {
          const reference = sound(this.readString(cursor, field.location) ?? null);
          await this.register({ kind: "sound", reference, location: field.location });
          this.assets.menuEnterSound = reference;
          this.parseOptions.assetSink?.publish({ field: "menuEnterSound", value: reference });
          break;
        }
        case "menuexitsound": {
          const reference = sound(this.readString(cursor, field.location) ?? null);
          await this.register({ kind: "sound", reference, location: field.location });
          this.assets.menuExitSound = reference;
          this.parseOptions.assetSink?.publish({ field: "menuExitSound", value: reference });
          break;
        }
        case "itemfocussound": {
          const reference = sound(this.readString(cursor, field.location) ?? null);
          await this.register({ kind: "sound", reference, location: field.location });
          this.assets.itemFocusSound = reference;
          this.parseOptions.assetSink?.publish({ field: "itemFocusSound", value: reference });
          break;
        }
        case "menubuzzsound": {
          const reference = sound(this.readString(cursor, field.location) ?? null);
          await this.register({ kind: "sound", reference, location: field.location });
          this.assets.menuBuzzSound = reference;
          this.parseOptions.assetSink?.publish({ field: "menuBuzzSound", value: reference });
          break;
        }
        case "cursor": {
          const path = this.readStringReference(cursor, field.location);
          this.parseOptions.assetSink?.publish({ field: "cursorStr", value: path ?? null });
          const reference = shader(path?.read() ?? null);
          await this.register({ kind: "picture", reference, location: field.location });
          this.assets.cursor = reference;
          this.parseOptions.assetSink?.publish({ field: "cursor", value: reference });
          break;
        }
        case "fadeclamp":
          this.assets.fadeClamp = this.readFloat(cursor, field.location);
          this.parseOptions.assetSink?.publish({ field: "fadeClamp", value: this.assets.fadeClamp }); break;
        case "fadecycle":
          this.assets.fadeCycle = this.readInt(cursor, field.location);
          this.parseOptions.assetSink?.publish({ field: "fadeCycle", value: this.assets.fadeCycle }); break;
        case "fadeamount":
          this.assets.fadeAmount = this.readFloat(cursor, field.location);
          this.parseOptions.assetSink?.publish({ field: "fadeAmount", value: this.assets.fadeAmount }); break;
        case "shadowx":
          this.assets.shadowX = this.readFloat(cursor, field.location);
          this.parseOptions.assetSink?.publish({ field: "shadowX", value: this.assets.shadowX }); break;
        case "shadowy":
          this.assets.shadowY = this.readFloat(cursor, field.location);
          this.parseOptions.assetSink?.publish({ field: "shadowY", value: this.assets.shadowY }); break;
        case "shadowcolor": {
          for (const component of ["x", "y", "z", "w"] satisfies readonly (keyof Vec4)[]) {
            const value = this.readFloat(cursor, field.location);
            this.assets.shadowColor = { ...this.assets.shadowColor, [component]: value };
            this.parseOptions.assetSink?.publish({ field: "shadowColorComponent", component, value });
          }
          this.assets.shadowFadeClamp = this.assets.shadowColor.w;
          this.parseOptions.assetSink?.publish({ field: "shadowFadeClamp", value: this.assets.shadowFadeClamp });
          break;
        }
        default: this.warn(`unknown asset keyword ${value}`, field.location);
      }
    }
  }

  private async parseMenu(cursor: UiMenuTokenCursor, start: SourceLocation, index: number): Promise<UiMenuDefinition | undefined> {
    const menu = new MutableMenu(this.storage.menuRecord(index), sourceLocation(start));
    menu.initialize(this.assets);
    const opening = cursor.next();
    if (opening === undefined || !tokenValue(opening).startsWith("{")) return undefined;
    while (true) {
      const field = cursor.next();
      if (field === undefined) {
        this.sourceError("end of file inside menu", start, cursor);
        return undefined;
      }
      const value = tokenValue(field);
      if (value.startsWith("}")) {
        this.postParse(menu);
        return menu.definition;
      }
      try { switch (value.toLowerCase()) {
        case "font": {
          menu.allocation.setString(180, this.readStringReference(cursor, field.location));
          if (!this.fontRegistered) {
            const reference = font(menu.font ?? null, 48);
            await this.register({ kind: "font", reference, location: field.location });
            this.assets.textFont = reference;
            this.parseOptions.assetSink?.publish({ field: "textFont", value: reference });
            this.fontRegistered = true;
            this.parseOptions.assetSink?.publish({ field: "fontRegistered", value: true });
          }
          break;
        }
        case "name": menu.allocation.setString(32, this.readStringReference(cursor, field.location)); break;
        case "fullscreen": menu.fullScreen = this.readInt(cursor, field.location); break;
        case "rect": this.readRectInto(menu.window.rect, cursor, field.location); break;
        case "style": menu.window.style = this.readInt(cursor, field.location); break;
        case "visible": if (this.readInt(cursor, field.location) !== 0) menu.window.flags |= UiWindowFlag.Visible; break;
        case "onopen": menu.onOpen = this.readScript(cursor, field.location); break;
        case "onclose": menu.onClose = this.readScript(cursor, field.location); break;
        case "onesc": menu.onEscape = this.readScript(cursor, field.location); break;
        case "border": menu.window.border = this.readInt(cursor, field.location); break;
        case "bordersize": menu.window.borderSize = this.readFloat(cursor, field.location); break;
        case "backcolor": this.readColorInto(menu.window.backColor, cursor, field.location); break;
        case "forecolor": this.readForeColor(menu.window, cursor, field.location); break;
        case "bordercolor": this.readColorInto(menu.window.borderColor, cursor, field.location); break;
        case "focuscolor": this.readColorInto(menu.focusColor, cursor, field.location); break;
        case "disablecolor": this.readColorInto(menu.disableColor, cursor, field.location); break;
        case "outlinecolor": this.readColorInto(menu.window.outlineColor, cursor, field.location); break;
        case "background": {
          const reference = shader(this.readString(cursor, field.location) ?? null);
          const registration = await this.register({ kind: "picture", reference, location: field.location });
          menu.window.setBackground(reference, registration?.handle);
          break;
        }
        case "ownerdraw": menu.window.ownerDraw = this.readInt(cursor, field.location); break;
        case "ownerdrawflag": menu.window.ownerDrawFlags = int32(menu.window.ownerDrawFlags | this.readInt(cursor, field.location)); break;
        case "outofboundsclick": menu.window.flags |= UiWindowFlag.OutOfBoundsClick; break;
        case "soundloop": {
          menu.allocation.setString(224, this.readStringReference(cursor, field.location)); break;
        }
        case "itemdef": {
          if (menu.itemCount >= MAX_UI_MENU_ITEMS) break;
          if (await this.parseItem(cursor, field.location, menu) === undefined) throw new MenuParseFailure(cursor, "itemDef");
          const item = menu.item(menu.itemCount);
          if (item !== undefined && item.type === UiItemTypeCode.ListBox) {
            const list = item.listData();
            item.cursorPosition = 0;
            if (list !== undefined) { list.cursorPosition = 0; list.startPosition = 0; list.endPosition = 0; list.cursorPosition = 0; }
          }
          const parentItem = menu.item(menu.itemCount);
          menu.itemCount++;
          if (parentItem === undefined) this.fail("MenuParse_itemDef dereferences a NULL retained item parent", field.location);
          parentItem.parent = menu.definition;
          break;
        }
        case "cinematic": menu.allocation.setString(40, this.readStringReference(cursor, field.location)); break;
        case "popup": menu.window.flags |= UiWindowFlag.Popup; break;
        case "fadeclamp": menu.fadeClamp = this.readFloat(cursor, field.location); break;
        case "fadecycle": menu.fadeCycle = this.readInt(cursor, field.location); break;
        case "fadeamount": menu.fadeAmount = this.readFloat(cursor, field.location); break;
        default: this.sourceError(`unknown menu keyword ${value}`, field.location, cursor);
      } } catch (error) {
        if (!(error instanceof MenuParseFailure) || error.cursor !== cursor) throw error;
        this.sourceError(`couldn't parse menu keyword ${value}`, field.location, cursor);
        return undefined;
      }
    }
  }

  private async parseItem(cursor: UiMenuTokenCursor, start: SourceLocation, menu: MutableMenu): Promise<MutableItem | undefined> {
    // ui_shared.h QVM32 itemDef_t is 540 bytes; Menus[] itself is static.
    const allocation = this.allocate(540);
    if (allocation === undefined) {
      menu.setItem(menu.itemCount, undefined);
      this.fail("Item_Init dereferences a failed UI_Alloc itemDef_t", start);
    }
    const item = new MutableItem(allocation, sourceLocation(start), this.memory.kind === "qvm32" ? allocation.offset : undefined);
    menu.setItem(menu.itemCount, item.definition);
    item.initialize();
    const opening = cursor.next();
    if (opening === undefined || !tokenValue(opening).startsWith("{")) return undefined;
    while (true) {
      const field = cursor.next();
      if (field === undefined) {
        this.sourceError("end of file inside menu item", start, cursor);
        return undefined;
      }
      const value = tokenValue(field);
      if (value.startsWith("}")) {
        return item;
      }
      try { await this.parseItemField(item, cursor, value.toLowerCase(), value, field.location); }
      catch (error) {
        if (!(error instanceof MenuParseFailure) || error.cursor !== cursor) throw error;
        this.sourceError(`couldn't parse menu item keyword ${value}`, field.location, cursor);
        return undefined;
      }
    }
  }

  private async parseItemField(
    item: MutableItem,
    cursor: UiMenuTokenCursor,
    keyword: string,
    originalKeyword: string,
    at: SourceLocation,
  ): Promise<void> {
    switch (keyword) {
      case "name": item.allocation.setString(32, this.readStringReference(cursor, at)); break;
      case "text": item.allocation.setString(224, this.readStringReference(cursor, at)); break;
      case "group": item.allocation.setString(36, this.readStringReference(cursor, at)); break;
      case "asset_model": {
        this.validateTypeData(item);
        const data = item.modelData();
        const reference = model(this.readString(cursor, at) ?? null);
        const registration = await this.register({ kind: "model", reference, location: at });
        item.setAsset(reference, registration?.handle);
        const random = this.host.random.nextInt();
        if (!Number.isInteger(random) || random < 0 || random > 0x7fff) {
          this.fail("UI random must return an integer in [0, 32767]", at);
        }
        if (data === undefined) this.fail("ItemParse_asset_model dereferences NULL model typeData", at);
        data.angle = random % 360;
        break;
      }
      case "asset_shader": {
        const reference = shader(this.readString(cursor, at) ?? null);
        const registration = await this.register({ kind: "picture", reference, location: at });
        item.setAsset(reference, registration?.handle);
        break;
      }
      case "model_origin": {
        const data = this.requireModel(item, at);
        data.origin.x = this.readFloat(cursor, at);
        data.origin.y = this.readFloat(cursor, at);
        data.origin.z = this.readFloat(cursor, at);
        break;
      }
      case "model_fovx": this.requireModel(item, at).fieldOfViewX = this.readFloat(cursor, at); break;
      case "model_fovy": this.requireModel(item, at).fieldOfViewY = this.readFloat(cursor, at); break;
      case "model_rotation": this.requireModel(item, at).rotationSpeed = this.readInt(cursor, at); break;
      case "model_angle": this.requireModel(item, at).angle = this.readInt(cursor, at); break;
      case "rect": this.readRectInto(item.window.clientRect, cursor, at); break;
      case "style": item.window.style = this.readInt(cursor, at); break;
      case "decoration": item.window.flags |= UiWindowFlag.Decoration; break;
      case "notselectable": {
        this.validateTypeData(item);
        if (item.type === UiItemTypeCode.ListBox) {
          const list = item.listData();
          if (list !== undefined) list.notSelectable = true;
        }
        break;
      }
      case "wrapped": item.window.flags |= UiWindowFlag.Wrapped; break;
      case "autowrapped": item.window.flags |= UiWindowFlag.AutoWrapped; break;
      case "horizontalscroll": item.window.flags |= UiWindowFlag.Horizontal; break;
      case "type": item.type = this.readInt(cursor, at); this.validateTypeData(item); break;
      case "elementwidth": this.requireList(item, at).elementWidth = this.readFloat(cursor, at); break;
      case "elementheight": this.requireList(item, at).elementHeight = this.readFloat(cursor, at); break;
      case "feeder": item.special = this.readFloat(cursor, at); break;
      case "elementtype": this.checkedList(item, cursor).elementStyle = this.readInt(cursor, at); break;
      case "columns": this.readColumns(this.checkedList(item, cursor), cursor, at); break;
      case "border": item.window.border = this.readInt(cursor, at); break;
      case "bordersize": item.window.borderSize = this.readFloat(cursor, at); break;
      case "visible": if (this.readInt(cursor, at) !== 0) item.window.flags |= UiWindowFlag.Visible; break;
      case "ownerdraw": {
        item.window.ownerDraw = this.readInt(cursor, at);
        // ItemParse_ownerdraw changes type without clearing or validating typeData.
        item.type = UiItemTypeCode.OwnerDraw;
        break;
      }
      case "align": item.alignment = this.readInt(cursor, at); break;
      case "textalign": item.textAlignment = this.readInt(cursor, at); break;
      case "textalignx": item.textAlignX = this.readFloat(cursor, at); break;
      case "textaligny": item.textAlignY = this.readFloat(cursor, at); break;
      case "textscale": item.textScale = this.readFloat(cursor, at); break;
      case "textstyle": item.textStyle = this.readInt(cursor, at); break;
      case "backcolor": this.readColorInto(item.window.backColor, cursor, at); break;
      case "forecolor": this.readForeColor(item.window, cursor, at); break;
      case "bordercolor": this.readColorInto(item.window.borderColor, cursor, at); break;
      case "outlinecolor": this.readColorInto(item.window.outlineColor, cursor, at); break;
      case "background": {
        const reference = shader(this.readString(cursor, at) ?? null);
        const registration = await this.register({ kind: "picture", reference, location: at });
        item.window.setBackground(reference, registration?.handle);
        break;
      }
      case "onfocus": item.onFocus = this.readScript(cursor, at); break;
      case "leavefocus": item.leaveFocus = this.readScript(cursor, at); break;
      case "mouseenter": item.mouseEnter = this.readScript(cursor, at); break;
      case "mouseexit": item.mouseExit = this.readScript(cursor, at); break;
      case "mouseentertext": item.mouseEnterText = this.readScript(cursor, at); break;
      case "mouseexittext": item.mouseExitText = this.readScript(cursor, at); break;
      case "action": item.action = this.readScript(cursor, at); break;
      case "special": item.special = this.readFloat(cursor, at); break;
      case "cvar": {
        this.validateTypeData(item);
        item.allocation.setString(264, this.readStringReference(cursor, at));
        const edit = item.editData();
        if (edit !== undefined) {
          edit.minimum = -1;
          edit.maximum = -1;
          edit.defaultValue = -1;
        }
        break;
      }
      case "maxchars": this.requireEdit(item, cursor).maxChars = this.readInt(cursor, at); break;
      case "maxpaintchars": this.requireEdit(item, cursor).maxPaintChars = this.readInt(cursor, at); break;
      case "focussound": {
        const reference = sound(this.readString(cursor, at) ?? null);
        const registration = await this.register({ kind: "sound", reference, location: at });
        item.setFocusSound(reference, registration?.handle);
        break;
      }
      case "cvarfloat": {
        const edit = this.requireEdit(item, cursor);
        item.allocation.setString(264, this.readStringReference(cursor, at));
        edit.defaultValue = this.readFloat(cursor, at);
        edit.minimum = this.readFloat(cursor, at);
        edit.maximum = this.readFloat(cursor, at);
        break;
      }
      case "cvarstrlist": this.readStringChoices(this.requireMulti(item, cursor), cursor, at); break;
      case "cvarfloatlist": this.readNumberChoices(this.requireMulti(item, cursor), cursor, at); break;
      case "addcolorrange": {
        const range = Object.freeze({ low: this.readFloat(cursor, at), high: this.readFloat(cursor, at), color: this.readColor(cursor, at) });
        item.addColorRange(range);
        break;
      }
      case "ownerdrawflag": item.window.ownerDrawFlags = int32(item.window.ownerDrawFlags | this.readInt(cursor, at)); break;
      case "enablecvar": item.cvarRule = Object.freeze({ kind: "enable", script: this.readScript(cursor, at) }); break;
      case "cvartest": item.allocation.setString(268, this.readStringReference(cursor, at)); break;
      case "disablecvar": item.cvarRule = Object.freeze({ kind: "disable", script: this.readScript(cursor, at) }); break;
      case "showcvar": item.cvarRule = Object.freeze({ kind: "show", script: this.readScript(cursor, at) }); break;
      case "hidecvar": item.cvarRule = Object.freeze({ kind: "hide", script: this.readScript(cursor, at) }); break;
      case "cinematic": item.allocation.setString(40, this.readStringReference(cursor, at)); break;
      case "doubleclick": this.checkedList(item, cursor).doubleClick = this.readScript(cursor, at); break;
      default: this.sourceError(`unknown menu item keyword ${originalKeyword}`, at, cursor);
    }
  }

  private validateTypeData(item: MutableItem): void {
    if (item.hasTypeData) return;
    const type = item.type;
    const kind = type === UiItemTypeCode.ListBox ? "list" : type === UiItemTypeCode.Model ? "model"
      : type === UiItemTypeCode.Multi ? "multi" : isEditType(type) ? "edit" : null;
    if (kind === null) return;
    // Item_ValidateTypeData publishes the pointer before the edit/list memset.
    const allocated = this.allocate(kind === "list" ? 232 : kind === "multi" ? 392 : 28);
    item.typeData = allocated;
    if (kind === "edit" || kind === "list") {
      if (allocated === undefined) this.fail("Item_ValidateTypeData memset dereferences a failed UI_Alloc", item.location);
      allocated.clear();
      if (type === UiItemTypeCode.EditField) allocated.setInt32(20, 256);
    }
  }

  private allocate(size: number): UiMemoryAllocation | undefined {
    const offset = this.storage.allocate(size);
    return offset === null ? undefined : this.storage.borrow(offset, size);
  }

  private requireEdit(item: MutableItem, cursor: UiMenuTokenCursor): MutableEditField {
    this.validateTypeData(item);
    const edit = item.editData();
    if (edit === undefined) throw new MenuParseFailure(cursor, "edit parser rejected NULL typeData");
    return edit;
  }

  private requireList(item: MutableItem, at: SourceLocation): MutableListBox {
    this.validateTypeData(item);
    const list = item.listData();
    if (list === undefined) this.fail("list parser dereferences NULL typeData", at);
    return list;
  }

  private checkedList(item: MutableItem, cursor: UiMenuTokenCursor): MutableListBox {
    this.validateTypeData(item);
    const list = item.listData();
    if (list === undefined) throw new MenuParseFailure(cursor, "list parser rejected NULL typeData");
    return list;
  }

  private requireMulti(item: MutableItem, cursor: UiMenuTokenCursor): MutableMulti {
    this.validateTypeData(item);
    const multi = item.multiData();
    if (multi === undefined) throw new MenuParseFailure(cursor, "multi parser rejected NULL typeData");
    return multi;
  }

  private requireModel(item: MutableItem, at: SourceLocation): MutableModel {
    this.validateTypeData(item);
    const model = item.modelData();
    if (model === undefined) this.fail("model parser dereferences NULL typeData", at);
    return model;
  }

  private readColumns(list: MutableListBox, cursor: UiMenuTokenCursor, at: SourceLocation): void {
    let count = this.readInt(cursor, at);
    if (count > MAX_UI_LIST_COLUMNS) count = MAX_UI_LIST_COLUMNS;
    list.columnCount = count;
    for (let index = 0; index < count; index++) {
      list.setColumn(index, {
        position: this.readInt(cursor, at),
        width: this.readInt(cursor, at),
        maxChars: this.readInt(cursor, at),
      });
    }
  }

  private readStringChoices(multi: MutableMulti, cursor: UiMenuTokenCursor, at: SourceLocation): void {
    multi.count = 0;
    multi.stringDefinition = true;
    this.expectFirst(cursor, "{", "expected { before cvarStrList", at);
    let readingLabel = true;
    while (true) {
      const token = this.expectAny(cursor, "end of file inside menu item", at);
      const value = tokenValue(token);
      if (value.startsWith("}")) return;
      if (value.startsWith(",") || value.startsWith(";")) continue;
      if (readingLabel) {
        multi.setLabel(multi.count, this.allocateStringReference(value)); readingLabel = false;
      } else {
        multi.setStringValue(multi.count, this.allocateStringReference(value));
        readingLabel = true;
        multi.count++;
        if (multi.count >= 32) throw new MenuParseFailure(cursor, "cvarStrList reached the source 32-slot failure");
      }
    }
  }

  private readNumberChoices(multi: MutableMulti, cursor: UiMenuTokenCursor, at: SourceLocation): void {
    multi.count = 0;
    multi.stringDefinition = false;
    this.expectFirst(cursor, "{", "expected { before cvarFloatList", at);
    while (true) {
      const token = this.expectAny(cursor, "end of file inside menu item", at);
      const value = tokenValue(token);
      if (value.startsWith("}")) return;
      if (value.startsWith(",") || value.startsWith(";")) continue;
      multi.setLabel(multi.count, this.allocateStringReference(value));
      multi.setNumberValue(multi.count, this.readFloat(cursor, token.location));
      multi.count++;
      if (multi.count >= 32) throw new MenuParseFailure(cursor, "cvarFloatList reached the source 32-slot failure");
    }
  }

  private postParse(menu: MutableMenu): void {
    if (menu.fullScreen !== 0) {
      menu.window.rect.x = 0; menu.window.rect.y = 0;
      menu.window.rect.width = 640; menu.window.rect.height = 480;
    }
    let x = menu.window.rect.x;
    let y = menu.window.rect.y;
    if (menu.window.border !== 0) {
      x = Math.fround(x + menu.window.borderSize);
      y = Math.fround(y + menu.window.borderSize);
    }
    for (let index = 0; index < menu.itemCount; index++) {
      const item = menu.item(index);
      // Item_SetScreenCoords accepts a NULL member without touching it.
      if (item === undefined) continue;
      let itemX = x, itemY = y;
      if (item.window.border !== 0) {
        itemX = Math.fround(itemX + item.window.borderSize);
        itemY = Math.fround(itemY + item.window.borderSize);
      }
      item.window.rect.x = Math.fround(itemX + item.window.clientRect.x);
      item.window.rect.y = Math.fround(itemY + item.window.clientRect.y);
      item.window.rect.width = item.window.clientRect.width;
      item.window.rect.height = item.window.clientRect.height;
      item.textRect.width = 0; item.textRect.height = 0;
    }
  }

  private readFont(cursor: UiMenuTokenCursor, at: SourceLocation): UiFontReference {
    const path = this.readString(cursor, at), pointSize = this.readInt(cursor, at);
    return font(path ?? null, pointSize);
  }

  private allocateString(text: string): string | undefined {
    return this.allocateStringReference(text)?.read();
  }

  private allocateStringReference(text: string): UiStringReference | undefined {
    return this.memory.kind === "unaccounted" ? UiStringReference.literal(text) : this.memory.memory.stringAllocReference(text) ?? undefined;
  }

  private readStringReference(cursor: UiMenuTokenCursor, at: SourceLocation): UiStringReference | undefined {
    return this.allocateStringReference(tokenValue(this.expectAny(cursor, "expected string", at)));
  }

  private readString(cursor: UiMenuTokenCursor, at: SourceLocation): string | undefined {
    return this.allocateString(tokenValue(this.expectAny(cursor, "expected string", at)));
  }

  private readInt(cursor: UiMenuTokenCursor, at: SourceLocation): number {
    let token = this.expectAny(cursor, "expected integer", at);
    let negative = false;
    if (tokenValue(token).startsWith("-")) {
      negative = true;
      token = this.expectAny(cursor, "expected integer after minus sign", token.location);
    }
    if (token.kind !== "number") {
      this.sourceError(`expected integer but found ${tokenValue(token)}`, token.location, cursor);
      throw new MenuParseFailure(cursor, "expected integer");
    }
    const stored = int32(token.integerValue);
    return negative ? int32(-stored) : stored;
  }

  private readFloat(cursor: UiMenuTokenCursor, at: SourceLocation): number {
    let token = this.expectAny(cursor, "expected float", at);
    let negative = false;
    if (tokenValue(token).startsWith("-")) {
      negative = true;
      token = this.expectAny(cursor, "expected float after minus sign", token.location);
    }
    if (token.kind !== "number") {
      this.sourceError(`expected float but found ${tokenValue(token)}`, token.location, cursor);
      throw new MenuParseFailure(cursor, "expected float");
    }
    const stored = Math.fround(token.floatValue);
    return negative ? Math.fround(-stored) : stored;
  }

  private readRectInto(destination: UiMutableRect, cursor: UiMenuTokenCursor, at: SourceLocation): void {
    destination.x = this.readFloat(cursor, at);
    destination.y = this.readFloat(cursor, at);
    destination.width = this.readFloat(cursor, at);
    destination.height = this.readFloat(cursor, at);
  }

  private readColorInto(destination: UiMutableColor, cursor: UiMenuTokenCursor, at: SourceLocation): void {
    destination.x = this.readFloat(cursor, at);
    destination.y = this.readFloat(cursor, at);
    destination.z = this.readFloat(cursor, at);
    destination.w = this.readFloat(cursor, at);
  }

  private readForeColor(window: MutableWindow, cursor: UiMenuTokenCursor, at: SourceLocation): void {
    for (const component of ["x", "y", "z", "w"] satisfies readonly (keyof Vec4)[]) {
      window.foreColor[component] = this.readFloat(cursor, at);
      window.flags |= UiWindowFlag.ForeColorSet;
    }
  }

  private readColor(cursor: UiMenuTokenCursor, at: SourceLocation): Vec4 {
    return color(
      this.readFloat(cursor, at),
      this.readFloat(cursor, at),
      this.readFloat(cursor, at),
      this.readFloat(cursor, at),
    );
  }

  private readScript(cursor: UiMenuTokenCursor, at: SourceLocation): UiScript | undefined {
    this.expect(cursor, "{", "expected { before script", at);
    let text = "";
    let truncated = false;
    const tokens: UiScriptToken[] = [];
    while (true) {
      const token = this.expectAny(cursor, "end of file inside script", at);
      const value = tokenValue(token);
      if (value === "}") {
        if (truncated) this.warn(`script truncated to ${MAX_UI_SCRIPT_BYTES} bytes`, at);
        const allocated = this.allocateStringReference(text);
        return allocated === undefined ? undefined : Object.freeze({ get text(): string { return allocated.read(); }, tokens: Object.freeze(tokens), truncated });
      }
      for (let index = 0; index < value.length; index++) {
        if (value.charCodeAt(index) > 255) throw new RangeError("PC_Script_Parse requires an 8-bit token string");
      }
      const rendered = value.length > 1 ? `"${value}"` : value;
      const addition = `${rendered} `;
      const remaining = MAX_UI_SCRIPT_BYTES - text.length;
      if (remaining >= addition.length) {
        text += addition;
        tokens.push(Object.freeze({ text: value, location: sourceLocation(token.location) }));
      } else {
        if (remaining > 0) text += addition.slice(0, remaining);
        truncated = true;
      }
    }
  }

  private expect(cursor: UiMenuTokenCursor, expected: string, message: string, at: SourceLocation): void {
    const token = this.expectAny(cursor, message, at);
    if (tokenValue(token).toLowerCase() !== expected.toLowerCase()) throw new MenuParseFailure(cursor, message);
  }

  private expectFirst(cursor: UiMenuTokenCursor, expected: string, message: string, at: SourceLocation): void {
    const token = this.expectAny(cursor, message, at);
    if (!tokenValue(token).toLowerCase().startsWith(expected.toLowerCase())) throw new MenuParseFailure(cursor, message);
  }

  private expectAny(cursor: UiMenuTokenCursor, message: string, at: SourceLocation): ScriptToken {
    const token = cursor.next();
    if (token === undefined) {
      if (message === "end of file inside menu item") this.sourceError(message, at, cursor);
      throw new MenuParseFailure(cursor, message);
    }
    return token;
  }

  private openFile(path: string): ScriptSource | UiMenuTokenCursor | undefined {
    const host = this.host;
    return "resolver" in host ? host.resolver.resolveRoot(path)
      : UiMenuTokenCursor.openHandle(path, () => host.scriptSources(), () => host.assertCurrentOperation());
  }

  private resolveRoot(path: string, label: string): ScriptSource | UiMenuTokenCursor {
    if (path.length === 0) this.fail(`${label} path cannot be empty`, sourceLocation({ path: "<ui>", line: 1, column: 1 }));
    const source = this.openFile(path);
    if (source === undefined) this.fail(`couldn't load ${label} ${path}`, sourceLocation({ path, line: 1, column: 1 }));
    if (source.path.length === 0) this.fail(`${label} resolver returned an empty canonical path`, sourceLocation({ path, line: 1, column: 1 }));
    return source;
  }

  private reportDiagnostic(diagnostic: ScriptDiagnostic): void {
    this.reported.push(diagnostic);
    this.parseOptions.reportDiagnostic?.(diagnostic);
  }

  private sourceError(message: string, at: SourceLocation, cursor: UiMenuTokenCursor): void {
    const position = cursor.position;
    this.reportDiagnostic(Object.freeze({ severity: "error", message,
      location: sourceLocation({ path: position.filename, line: position.line, column: at.column }) }));
  }

  private warn(message: string, at: SourceLocation): void {
    this.reportDiagnostic(Object.freeze({ severity: "warning", message, location: sourceLocation(at) }));
  }

  private fail(message: string, at: SourceLocation): never {
    const diagnostic: ScriptDiagnostic = Object.freeze({ severity: "error", message, location: sourceLocation(at) });
    this.reportDiagnostic(diagnostic);
    throw new ScriptLanguageError(diagnostic, this.reported);
  }
}

function isEditType(type: number): boolean {
  return type === UiItemTypeCode.Text || type === UiItemTypeCode.EditField ||
    type === UiItemTypeCode.NumericField || type === UiItemTypeCode.Slider ||
    type === UiItemTypeCode.YesNo || type === UiItemTypeCode.Bind;
}

export async function loadMenuDefinitions(
  host: UiMenuResolvedParseHost,
  plan: UiMenuLoadPlan,
  preprocessorOptions: ScriptPreprocessorOptions = {},
  parseOptions: UiMenuParseOptions = {},
): Promise<UiMenuDefinitions> {
  return new UiMenuSourceParser(host, preprocessorOptions, parseOptions).load(plan);
}
