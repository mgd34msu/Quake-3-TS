// UI_SPArena_Start from id Software q3_ui/ui_sparena.c. GPL-2.0-or-later.
import { infoValueForKey } from "../../core/info-string.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { gameAtoi } from "../../game/numeric.ts";
import type { BaseUiGameInfo } from "./game-info.ts";
import { nativeInt } from "./state.ts";
import type { BaseUiState } from "./state.ts";

export function startSinglePlayerArena(state: BaseUiState, gameInfo: BaseUiGameInfo, arenaInfo: string | null): void {
  state.assertActive();
  const info = arenaInfo === null ? "" : arenaInfo;
  const cvars = state.services.cvars.registry, maxclients = cvars.get("sv_maxclients");
  if (qvmFloatToInt(maxclients === undefined ? 0 : maxclients.numericValue) < 8) cvars.set("sv_maxclients", "8", true);
  let level = gameAtoi(infoValueForKey(info, "num"));
  const special = infoValueForKey(info, "special").replace(/[A-Z]/g, byte => String.fromCharCode(byte.charCodeAt(0) + 32));
  if (special === "training") level = -4;
  else if (special === "final") level = gameInfo.getNumSPTiers() * 4;
  state.assertActive();
  cvars.set("ui_spSelection", String(nativeInt(Math.fround(level))), true);
  const map = infoValueForKey(info, "map");
  state.services.consoleCommands.append(`spmap ${map}\n`);
}
