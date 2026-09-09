/*
 * UI_BuildPlayerList from id Software's code/ui/ui_main.c and Q_CleanStr
 * from code/game/q_shared.c. Copyright (C) 1999-2005 Id Software, Inc.
 * GPL-2.0-or-later.
 */
import type { CvarRegistry } from "../../core/cvar.ts";
import { infoValueForKey } from "../../core/info-string.ts";
import { qvmFloatToInt } from "../../core/numeric.ts";
import { sourceCommandText } from "../../core/text.ts";
import type { EngineClientSession } from "../../engine/client-session.ts";
import { gameFormat } from "../../game/format.ts";
import { gameAtoi } from "../../game/numeric.ts";
import { infoSlot } from "./game-info.ts";

type TeamArenaPlayerClient = Pick<EngineClientSession, "readSnapshotClientNumber" | "getConfigString">;

function playerName(info: string): string {
  const copied = sourceCommandText(infoValueForKey(info, "n")).slice(0, 31);
  let clean = "";
  for (let index = 0; index < copied.length; index++) {
    const byte = copied.charCodeAt(index), next = copied.charAt(index + 1);
    if (byte === 94 && next !== "" && next !== "^") index++;
    else if (byte >= 32 && byte <= 126) clean += copied.charAt(index);
  }
  return clean;
}

export class TeamArenaPlayerList {
  readonly playerNames: string[] = Array.from({ length: 64 }, () => "");
  readonly teamNames: string[] = Array.from({ length: 64 }, () => "");
  readonly teamClientNums = new Int32Array(64);
  playerCount = 0;
  myTeamCount = 0;
  playerNumber = 0;
  teamLeader = 0;

  constructor(private readonly cvars: CvarRegistry, private readonly assertActive: () => void) {}

  private configString(client: TeamArenaPlayerClient, index: number, previous: string | undefined): string | undefined {
    if (index < 0 || index >= 1024) return previous;
    const text = client.getConfigString(index);
    this.assertActive();
    return sourceCommandText(text ?? "").slice(0, 1023);
  }

  build(client: TeamArenaPlayerClient): void {
    this.assertActive();
    const clientNumber = client.readSnapshotClientNumber();
    this.assertActive();
    let info = this.configString(client, 544 + clientNumber, undefined);
    this.playerNumber = clientNumber;
    if (info === undefined) throw new RangeError("UI_BuildPlayerList reads uninitialized configstring storage");
    this.teamLeader = gameAtoi(infoValueForKey(info, "tl"));
    const team = gameAtoi(infoValueForKey(info, "t"));
    info = this.configString(client, 0, info);
    if (info === undefined) throw new RangeError("UI_BuildPlayerList lost initialized configstring storage");
    const count = gameAtoi(infoValueForKey(info, "sv_maxclients"));
    this.playerCount = 0;
    this.myTeamCount = 0;
    let playerTeamNumber = 0;
    for (let number = 0; number < count; number++) {
      info = this.configString(client, 544 + number, info);
      if (info === undefined) throw new RangeError("UI_BuildPlayerList lost initialized configstring storage");
      if (info.length === 0) {
        // Out-of-range GetConfigString leaves the empty scratch buffer unchanged.
        if (544 + number >= 1024) break;
        continue;
      }
      infoSlot(this.playerNames, this.playerCount);
      this.playerNames[this.playerCount] = playerName(info);
      this.playerCount++;
      if (gameAtoi(infoValueForKey(info, "t")) !== team) continue;
      infoSlot(this.teamNames, this.myTeamCount);
      this.teamNames[this.myTeamCount] = playerName(info);
      this.teamClientNums[this.myTeamCount] = number;
      if (this.playerNumber === number) playerTeamNumber = this.myTeamCount;
      this.myTeamCount++;
    }
    if (this.teamLeader === 0) {
      this.cvars.set("cg_selectedPlayer", gameFormat("%d", [playerTeamNumber]), true);
      this.assertActive();
    }
    let selected = qvmFloatToInt(this.cvars.get("cg_selectedPlayer")?.numericValue ?? 0);
    if (selected < 0 || selected > this.myTeamCount) selected = 0;
    if (selected < this.myTeamCount) {
      this.cvars.set("cg_selectedPlayerName", infoSlot(this.teamNames, selected), true);
      this.assertActive();
    }
  }
}
