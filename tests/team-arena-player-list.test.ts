import { expect, test } from "bun:test";
import { CvarRegistry } from "../src/core/cvar.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { GamestateEntry, ServerMessageContext, ServerOperation } from "../src/protocol/server-message.ts";
import { PlayerState } from "../src/shared/player-state.ts";
import { TeamArenaPlayerList } from "../src/ui/team-arena/player-list.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";

function fixture() {
  const cvars = new CvarRegistry(), lifecycle = new ProtocolClientLifecycle(cvars);
  const session = new EngineClientSession({ product: "missionpack", cvars, lifecycle,
    mode: { kind: "network", challenge: 1, qport: 27961 } });
  let number = 0;
  async function send(operations: readonly ServerOperation[]): Promise<void> {
    number++;
    const context: ServerMessageContext = { product: "missionpack", messageNumber: number, reliableSequence: 0,
      serverCommandSequence: 0, parseEntitiesNumber: 0, baseline: () => null, history: () => null };
    await session.receiveServerMessage(number, encodeServerMessage(0, operations, context));
  }
  async function load(leader: number, empty = false): Promise<void> {
    const entries: GamestateEntry[] = [
      { kind: "configstring", index: 0, value: `\\sv_maxclients\\${empty ? 0 : 4}` },
      { kind: "configstring", index: 1, value: "\\sv_serverid\\100\\sv_cheats\\1\\fs_game\\missionpack" },
    ];
    if (!empty) entries.push(
      { kind: "configstring", index: 544, value: "\\n\\^1Al\x19\xe9pha\\t\\1" },
      { kind: "configstring", index: 545, value: "\\n\\^2Other\\t\\2" },
      { kind: "configstring", index: 546, value: `\\n\\^3Self\\t\\1\\tl\\${leader}` },
    );
    await send([{ kind: "gamestate", commandSequence: 0, clientNumber: 7, checksumFeed: 19, entries }]);
    const playerState = new PlayerState("missionpack"); playerState.clientNum = 2;
    await send([{ kind: "snapshot", validity: { kind: "valid" }, snapshot: { messageNumber: number + 1,
      serverTime: (number + 1) * 50, deltaNumber: -1, flags: 0, serverCommandNumber: 0,
      parseEntitiesNumber: 0, areaMask: new Uint8Array(), playerState, entities: [] } }]);
  }
  return { cvars, lifecycle, session, load,
    players: new TeamArenaPlayerList(cvars, () => { lifecycle.assertCurrentOperation(); }) };
}

test("Team Arena player list reads actual snapshot client, cleans names and retains unused rows", async () => {
  const f = fixture();
  try {
    await f.load(0); f.players.build(f.session);
    expect(f.session.clientNumber).toBe(7);
    expect(f.players.playerNumber).toBe(2);
    expect([f.players.playerCount, f.players.myTeamCount]).toEqual([3, 2]);
    expect(f.players.playerNames.slice(0, 3)).toEqual(["Al.pha", "Other", "Self"]);
    expect(f.players.teamNames.slice(0, 2)).toEqual(["Al.pha", "Self"]);
    expect([...f.players.teamClientNums.slice(0, 2)]).toEqual([0, 2]);
    expect(f.cvars.get("cg_selectedPlayer")?.value).toBe("1");
    expect(f.cvars.get("cg_selectedPlayerName")?.value).toBe("Self");
    await f.load(0, true); f.players.build(f.session);
    expect([f.players.playerCount, f.players.myTeamCount]).toEqual([0, 0]);
    expect(f.players.playerNames.slice(0, 3)).toEqual(["Al.pha", "Other", "Self"]);
    expect(f.cvars.get("cg_selectedPlayerName")?.value).toBe("Self");
  } finally { f.lifecycle.close(); }
});

test("Team Arena leader selection keeps Everyone text and clamps only the local name lookup", async () => {
  const f = fixture();
  try {
    await f.load(2);
    f.cvars.set("cg_selectedPlayer", "2", true);
    f.cvars.set("cg_selectedPlayerName", "Retained", true);
    f.players.build(f.session);
    expect(f.players.teamLeader).toBe(2);
    expect(f.cvars.get("cg_selectedPlayerName")?.value).toBe("Retained");
    f.cvars.set("cg_selectedPlayer", "99", true); f.players.build(f.session);
    expect(f.cvars.get("cg_selectedPlayer")?.value).toBe("99");
    expect(f.cvars.get("cg_selectedPlayerName")?.value).toBe("Al.pha");
    f.lifecycle.close();
    expect(() => f.players.build(f.session)).toThrow("no longer current");
  } finally { f.lifecycle.close(); }
});
