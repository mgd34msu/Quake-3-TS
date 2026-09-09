// Base UI cvar table from id Software q3_ui/ui_main.c. GPL-2.0-or-later.
import { CvarFlag } from "../../core/cvar.ts";
import type { CvarRegistry, RegisterableVmCvar, VmCvarRead } from "../../core/cvar.ts";
const archive = CvarFlag.Archive, rom = CvarFlag.ReadOnly;
export const BASE_UI_CVARS: readonly (readonly [
  string,
  string,
  number
])[] = [
  ["ui_ffa_fraglimit", "20", archive], ["ui_ffa_timelimit", "0", archive],
  ["ui_tourney_fraglimit", "0", archive], ["ui_tourney_timelimit", "15", archive],
  ["ui_team_fraglimit", "0", archive], ["ui_team_timelimit", "20", archive], ["ui_team_friendly", "1", archive],
  ["ui_ctf_capturelimit", "8", archive], ["ui_ctf_timelimit", "30", archive], ["ui_ctf_friendly", "0", archive],
  ["g_arenasFile", "", CvarFlag.Init | rom], ["g_botsFile", "", CvarFlag.Init | rom],
  ["g_spScores1", "", archive | rom], ["g_spScores2", "", archive | rom], ["g_spScores3", "", archive | rom],
  ["g_spScores4", "", archive | rom], ["g_spScores5", "", archive | rom], ["g_spAwards", "", archive | rom],
  ["g_spVideos", "", archive | rom], ["g_spSkill", "2", archive | CvarFlag.Latch], ["ui_spSelection", "", rom],
  ["ui_browserMaster", "0", archive], ["ui_browserGameType", "0", archive], ["ui_browserSortKey", "4", archive],
  ["ui_browserShowFull", "1", archive], ["ui_browserShowEmpty", "1", archive],
  ["cg_brassTime", "2500", archive], ["cg_drawCrosshair", "4", archive], ["cg_drawCrosshairNames", "1", archive], ["cg_marks", "1", archive],
  ["server1", "", archive], ["server2", "", archive], ["server3", "", archive], ["server4", "", archive],
  ["server5", "", archive], ["server6", "", archive], ["server7", "", archive], ["server8", "", archive],
  ["server9", "", archive], ["server10", "", archive], ["server11", "", archive], ["server12", "", archive],
  ["server13", "", archive], ["server14", "", archive], ["server15", "", archive], ["server16", "", archive],
  ["ui_cdkeychecked", "0", rom],
];
export class BaseUiCvars {
  private readonly mirrors = new Map<string, RegisterableVmCvar>();
  constructor(readonly registry: CvarRegistry, private readonly assertCurrentOperation: () => undefined) {
    for (const [name] of BASE_UI_CVARS) this.mirrors.set(name, registry.createVm());
  }
  register(): void {
    for (const [name, value, flags] of BASE_UI_CVARS) {
      this.assertCurrentOperation();
      const mirror = this.mirrors.get(name);
      if (mirror === undefined) throw new Error(`Unknown base UI VM cvar ${name}`);
      mirror.register(name, value, flags);
    }
  }
  get(name: string): VmCvarRead {
    const value = this.mirrors.get(name);
    if (value === undefined)
      throw new Error(`Unknown base UI VM cvar ${name}`);
    return value;
  }
  update(): void {
    for (const mirror of this.mirrors.values()) {
      this.assertCurrentOperation();
      mirror.update();
    }
  }
}
