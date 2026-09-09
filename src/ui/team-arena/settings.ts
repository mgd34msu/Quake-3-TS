// UI_Update and UI_SetCapFragLimits from id Software code/ui/ui_main.c.
// Copyright (C) 1999-2005 Id Software, Inc. GPL-2.0-or-later.
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import { GameType } from "../../shared/definitions.ts";
import type { TeamArenaUiCvars } from "./cvars.ts";
import { infoSlot } from "./game-info.ts";
import type { TeamArenaGameInfo } from "./game-info.ts";

type Setting = readonly [name: string, value: string];
// Order differs between source presets and is observable through cvar side effects.
const PRESETS: readonly (readonly Setting[])[] = [
  [["r_fullScreen", "1"], ["r_subdivisions", "4"], ["r_vertexlight", "0"], ["r_lodbias", "0"],
    ["r_colorbits", "32"], ["r_depthbits", "24"], ["r_picmip", "0"], ["r_mode", "4"],
    ["r_texturebits", "32"], ["r_fastSky", "0"], ["r_inGameVideo", "1"], ["cg_shadows", "1"],
    ["cg_brassTime", "2500"], ["r_texturemode", "GL_LINEAR_MIPMAP_LINEAR"]],
  [["r_fullScreen", "1"], ["r_subdivisions", "12"], ["r_vertexlight", "0"], ["r_lodbias", "0"],
    ["r_colorbits", "0"], ["r_depthbits", "24"], ["r_picmip", "1"], ["r_mode", "3"],
    ["r_texturebits", "0"], ["r_fastSky", "0"], ["r_inGameVideo", "1"], ["cg_brassTime", "2500"],
    ["r_texturemode", "GL_LINEAR_MIPMAP_LINEAR"], ["cg_shadows", "0"]],
  [["r_fullScreen", "1"], ["r_subdivisions", "8"], ["r_vertexlight", "0"], ["r_lodbias", "1"],
    ["r_colorbits", "0"], ["r_depthbits", "0"], ["r_picmip", "1"], ["r_mode", "3"],
    ["r_texturebits", "0"], ["cg_shadows", "0"], ["r_fastSky", "1"], ["r_inGameVideo", "0"],
    ["cg_brassTime", "0"], ["r_texturemode", "GL_LINEAR_MIPMAP_NEAREST"]],
  [["r_fullScreen", "1"], ["r_subdivisions", "20"], ["r_vertexlight", "1"], ["r_lodbias", "2"],
    ["r_colorbits", "16"], ["r_depthbits", "16"], ["r_mode", "3"], ["r_picmip", "2"],
    ["r_texturebits", "16"], ["cg_shadows", "0"], ["cg_brassTime", "0"], ["r_fastSky", "1"],
    ["r_inGameVideo", "0"], ["r_texturemode", "GL_LINEAR_MIPMAP_NEAREST"]],
];

export class TeamArenaSettings {
  constructor(private readonly cvars: TeamArenaUiCvars, private readonly game: TeamArenaGameInfo,
    private readonly assertActive: () => void) {}

  private value(name: string): number {
    const value = this.cvars.registry.get(name)?.numericValue ?? 0;
    this.assertActive();
    return value;
  }
  private text(name: string): string {
    const text = sourceCommandText(this.cvars.registry.get(name)?.value ?? "").slice(0, 1023);
    this.assertActive();
    return text;
  }
  private set(name: string, value: string): void {
    this.cvars.registry.set(name, value, true);
    this.assertActive();
  }

  setCapFragLimits(uiVars: boolean): void {
    this.assertActive();
    let capture = 5;
    const type = (): number => infoSlot(this.game.gameTypes, this.cvars.get("ui_gameType").integerValue).gtEnum;
    if (type() === GameType.GT_OBELISK) capture = 4;
    else if (type() === GameType.GT_HARVESTER) capture = 15;
    this.set(uiVars ? "ui_captureLimit" : "capturelimit", String(capture));
    this.set(uiVars ? "ui_fragLimit" : "fraglimit", "10");
  }

  update(name: string): void {
    this.assertActive();
    name = sourceCommandText(name);
    const value = qvmFloatToInt(this.value(name));
    const folded = name.replace(/[A-Z]/g, letter => letter.toLowerCase());
    switch (folded) {
      case "ui_setname": this.set("name", this.text("ui_Name")); return;
      case "ui_setrate": {
        const rate = this.value("rate");
        this.set("cl_maxpackets", rate >= 5000 ? "30" : "15");
        this.set("cl_packetdup", rate >= 5000 ? "1" : rate >= 4000 ? "2" : "1");
        return;
      }
      case "ui_getname": this.set("ui_Name", this.text("name")); return;
      case "r_colorbits":
        switch (value) {
          case 0: this.set("r_depthbits", "0"); this.set("r_stencilbits", "0"); return;
          case 16: this.set("r_depthbits", "16"); this.set("r_stencilbits", "0"); return;
          case 32: this.set("r_depthbits", "24"); return;
        }
        return;
      case "r_lodbias":
        switch (value) {
          case 0: this.set("r_subdivisions", "4"); return;
          case 1: this.set("r_subdivisions", "12"); return;
          case 2: this.set("r_subdivisions", "20"); return;
        }
        return;
      case "ui_glcustom": {
        const settings = PRESETS[value];
        if (settings !== undefined) for (const [cvar, setting] of settings) this.set(cvar, setting);
        return;
      }
      case "ui_mousepitch":
        // Cvar_SetValue formats the binary32 +/-0.022f with libc's fixed six digits.
        this.set("m_pitch", value === 0 ? "0.022000" : "-0.022000");
        return;
    }
  }
}
