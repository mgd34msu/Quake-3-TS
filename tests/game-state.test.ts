import { expect, test } from "bun:test";
import { vec3 } from "../src/core/math.ts";
import { Team, Weapon } from "../src/shared/definitions.ts";
import { ConnectionState, createGameClient, createGameEntity, GameFlags, MoverState,
  SpectatorState, TeamState } from "../src/game/state.ts";

test("g_local state starts source-zero with original enum values", () => {
  const client = createGameClient("baseq3");
  expect(client.ps.product).toBe("baseq3");
  expect(client.ps.health).toBe(0);
  expect(client.pers.connected).toBe(ConnectionState.DISCONNECTED);
  expect(client.pers.cmd.weapon).toBe(Weapon.WP_NONE);
  expect(client.sess.sessionTeam).toBe(Team.TEAM_FREE);
  expect(client.sess.spectatorState).toBe(SpectatorState.NOT);
  expect(client.pers.teamState.state).toBe(TeamState.BEGIN);
  expect(client.hook).toBeNull();
  expect(client.areabits).toBeNull();
  expect(client.ammoTimes.length).toBe(11);
  expect(ConnectionState.CONNECTED).toBe(2);
  expect(SpectatorState.SCOREBOARD).toBe(3);
  expect(MoverState.TWO_TO_ONE).toBe(3);
  expect(GameFlags.GODMODE).toBe(0x10);
  expect(GameFlags.FORCE_GESTURE).toBe(0x8000);
});

test("client player state, persistent commands, team state and sessions do not alias", () => {
  const first = createGameClient("missionpack");
  const second = createGameClient("missionpack");
  first.ps.health = 100;
  first.ps.ammo.set(Weapon.WP_CHAINGUN, 20);
  first.pers.cmd.angles = vec3(1, 2, 3);
  first.pers.netname = "one";
  first.pers.teamState.captures = 2;
  first.sess.wins = 5;
  first.ammoTimes.set(Weapon.WP_CHAINGUN, 1000);
  expect(second.ps.health).toBe(0);
  expect(second.ps.ammo.get(Weapon.WP_CHAINGUN)).toBe(0);
  expect(second.pers.cmd.angles).toEqual(vec3(0, 0, 0));
  expect(second.pers.netname).toBe("");
  expect(second.pers.teamState.captures).toBe(0);
  expect(second.sess.wins).toBe(0);
  expect(second.ammoTimes.get(Weapon.WP_CHAINGUN)).toBe(0);
  expect(first.ammoTimes.length).toBe(14);
  expect(first.ps).not.toBe(second.ps);
  expect(first.pers).not.toBe(second.pers);
  expect(first.sess).not.toBe(second.sess);
});

test("entity constructors are inactive, with separate shared records and null callbacks", () => {
  const first = createGameEntity(64);
  const second = createGameEntity(65);
  expect(first.slot).toBe(64);
  expect(first.s.number).toBe(0);
  expect(first.r.ownerNum).toBe(0);
  expect(first.classname).toBeNull();
  expect(first.inuse).toBe(false);
  expect(first.client).toBeNull();
  expect(first.item).toBeNull();
  expect(first.parent).toBeNull();
  expect(first.think).toBeNull();
  expect(first.reached).toBeNull();
  expect(first.blocked).toBeNull();
  expect(first.touch).toBeNull();
  expect(first.use).toBeNull();
  expect(first.pain).toBeNull();
  expect(first.die).toBeNull();
  first.s.event = 99;
  first.r.contents = 1;
  expect(second.s.event).toBe(0);
  expect(second.r.contents).toBe(0);
  expect(first.s).not.toBe(second.s);
  expect(first.r).not.toBe(second.r);
  expect(() => createGameEntity(-1)).toThrow(RangeError);
  expect(() => createGameEntity(1024)).toThrow(RangeError);
});

test("typed entity callbacks can retain concrete rule context", () => {
  const entity = createGameEntity(64);
  const attacker = createGameEntity(65);
  const deaths: number[] = [];
  entity.health = 100;
  entity.pain = (self, source, damage) => { self.enemy = source; self.health -= damage; };
  entity.die = (self, inflictor, source, damage, method) => {
    self.parent = inflictor;
    self.enemy = source;
    self.health -= damage;
    deaths.push(method);
  };
  entity.use = (self, other, activator) => { self.targetEnt = other; self.activator = activator; };
  entity.pain(entity, attacker, 10);
  entity.die(entity, attacker, attacker, 100, 17);
  entity.use(entity, null, attacker);
  expect(entity.health).toBe(-10);
  expect(entity.enemy).toBe(attacker);
  expect(entity.parent).toBe(attacker);
  expect(entity.activator).toBe(attacker);
  expect(entity.targetEnt).toBeNull();
  expect(deaths).toEqual([17]);
});
