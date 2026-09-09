import { describe, expect, test } from "bun:test";
import {
  BotActionBuffer,
  BotActionFlag,
} from "../src/botlib/actions.ts";
import type { BotActionHost } from "../src/botlib/actions.ts";
import type { CallSteps } from "../src/core/call-steps.ts";
import { BotMemory } from "../src/botlib/memory.ts";
import { HunkArena } from "../src/core/hunk.ts";
import type { HunkAllocation, HunkPreference } from "../src/core/hunk.ts";
import { ZoneArena, ZoneTag } from "../src/core/zone.ts";
import { SourceHunkAccounting } from "../src/render/hunk-accounting.ts";

interface CommandRecord {
  readonly client: number;
  readonly command: string;
}

class RecordingHost implements BotActionHost {
  readonly commands: CommandRecord[] = [];

  *clientCommand(client: number, command: string): CallSteps {
    this.commands.push({ client, command });
  }
}

class RecordingArena extends HunkArena {
  readonly allocated: HunkAllocation[] = [];

  override allocate(size: number, preference: HunkPreference): HunkAllocation {
    const allocation = super.allocate(size, preference);
    this.allocated.push(allocation);
    return allocation;
  }

  latest(): HunkAllocation {
    const allocation = this.allocated.at(-1);
    if (allocation === undefined) throw new Error("Expected a bot input hunk allocation");
    return allocation;
  }
}

function createBuffer(maxClients = 2): { readonly actions: BotActionBuffer; readonly host: RecordingHost } {
  const host = new RecordingHost();
  return { actions: new BotActionBuffer(maxClients, host), host };
}

test("bot heap uses the actual zone block, source prefix and uncleared reuse", () => {
  const zone = new ZoneArena(1024);
  const memory = new BotMemory(undefined, zone);
  const allocation = memory.allocate(5, "heap", false);
  const bytes = allocation.bytes;
  const block = new DataView(bytes.buffer, bytes.byteOffset - 24, 36);
  expect(block.getInt32(0, true)).toBe(36);
  expect(block.getInt32(4, true)).toBe(ZoneTag.Botlib);
  expect(block.getUint32(20, true)).toBe(0x12345678);
  expect(zone.memoryRemaining()).toBe(1024 - 36);
  bytes.fill(0x37);
  memory.free(allocation);
  expect(bytes).toEqual(new Uint8Array(5).fill(0xaa));
  expect(zone.memoryRemaining()).toBe(1024);
  expect(() => allocation.bytes).toThrow("freed");

  const reused = memory.allocate(5, "heap", false);
  expect(reused.bytes.byteOffset).toBe(bytes.byteOffset);
  expect(reused.bytes.buffer).toBe(bytes.buffer);
  expect(reused.bytes).toEqual(new Uint8Array(5).fill(0xaa));
  memory.free(reused);
  const cleared = memory.allocate(5, "heap", true);
  expect(cleared.bytes).toEqual(new Uint8Array(5));
  expect(block.getUint32(20, true)).toBe(0x12345678);
  expect(block.getUint8(29)).toBe(0xaa);
  memory.free(cleared);
  zone.dispose();
});

test("bot heap respects prefix identity, zone tag frees and terminal lifetime", () => {
  const zone = new ZoneArena(1024);
  const memory = new BotMemory(undefined, zone);
  const allocation = memory.allocate(4, "heap", true);
  const prefix = new DataView(allocation.bytes.buffer, allocation.bytes.byteOffset - 4, 4);
  prefix.setUint32(0, 0x87654321, true);
  memory.free(allocation);
  expect(zone.memoryRemaining()).toBe(1024 - 32);
  expect(allocation.bytes).toEqual(new Uint8Array(4));
  prefix.setUint32(0, 0x12345678, true);
  expect(() => new BotMemory(undefined, zone).free(allocation)).toThrow("another owner");
  zone.freeTags(ZoneTag.Botlib);
  expect(zone.memoryRemaining()).toBe(1024);
  expect(() => allocation.bytes).toThrow();
  expect(() => memory.free(allocation)).toThrow();
  const live = memory.allocate(4, "heap", false);
  zone.dispose();
  expect(() => live.bytes).toThrow();
  expect(() => memory.free(live)).toThrow();
  expect(() => memory.allocate(4, "heap", false)).toThrow();
});

describe("be_ea.c action accumulation", () => {
  test("reads and writes the actual 40-byte source records after the l_memory prefix", () => {
    const arena = new RecordingArena(1024, () => {});
    const memory = new BotMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) });
    const actions = new BotActionBuffer(2, new RecordingHost(), memory);
    const allocation = arena.latest();
    expect(allocation.byteLength).toBe(84);
    expect(arena.memoryRemaining()).toBe(928);
    const bytes = allocation.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x87654321);
    expect(bytes.subarray(4)).toEqual(new Uint8Array(80));

    actions.move(1, { x: 1.00000006, y: -2, z: 3 }, 500);
    actions.view(1, { x: 4, y: 5, z: 6 });
    actions.action(1, -0x80000000 | BotActionFlag.ATTACK);
    actions.selectWeapon(1, -17);
    const snapshot = actions.getInput(1, 0.123456789);
    expect(Array.from({ length: 8 }, (_, index) => view.getFloat32(44 + index * 4, true))).toEqual([
      Math.fround(0.123456789), Math.fround(1.00000006), -2, 3, 400, 4, 5, 6,
    ]);
    expect(view.getInt32(76, true)).toBe(-0x80000000 | BotActionFlag.ATTACK);
    expect(view.getInt32(80, true)).toBe(-17);
    expect(bytes.subarray(4, 44)).toEqual(new Uint8Array(40));

    view.setFloat32(48, 99, true);
    view.setFloat32(60, -23.5, true);
    view.setInt32(76, BotActionFlag.JUMP, true);
    view.setInt32(80, 42, true);
    expect(actions.getInput(1, 1)).toMatchObject({
      direction: { x: 99, y: -2, z: 3 }, speed: -23.5, actionFlags: BotActionFlag.JUMP, weapon: 42,
    });
    expect(snapshot.direction.x).toBe(Math.fround(1.00000006));
    expect(snapshot.weapon).toBe(-17);
    actions.resetInput(1);
    expect(bytes.subarray(44, 64)).toEqual(new Uint8Array(20));
    expect(view.getInt32(76, true)).toBe(128);
    expect(view.getFloat32(64, true)).toBe(4);
    expect(view.getInt32(80, true)).toBe(42);
  });

  test("shutdown retains hunk storage and setup uses a new cleared allocation", () => {
    const arena = new RecordingArena(1024, () => {});
    const accounting = new SourceHunkAccounting(arena);
    const memory = new BotMemory({ kind: "source-hunk", accounting });
    const actions = new BotActionBuffer(1, new RecordingHost(), memory);
    actions.selectWeapon(0, 42);
    const first = arena.latest();
    const remaining = arena.memoryRemaining();
    expect(() => actions.setup(30)).toThrow("Hunk_Alloc failed");
    expect(actions.maxClients).toBe(1);
    expect(actions.getInput(0, 0).weapon).toBe(42);
    actions.shutdown();
    actions.shutdown();
    expect(arena.memoryRemaining()).toBe(remaining);
    expect(arena.ownsLiveAllocation(first)).toBe(true);
    expect(new DataView(first.bytes.buffer, first.bytes.byteOffset, first.byteLength).getInt32(40, true)).toBe(42);
    expect(() => actions.attack(0)).toThrow("shut down");
    actions.setup(1);
    const second = arena.latest();
    expect(second.byteOffset).not.toBe(first.byteOffset);
    expect(arena.memoryRemaining()).toBe(remaining - 64);
    expect(actions.getInput(0, 0).weapon).toBe(0);

    accounting.clearToMark();
    expect(() => actions.attack(0)).toThrow("no longer valid");
    let directionRead = false;
    expect(() => actions.move(0, () => { directionRead = true; return { x: 1, y: 2, z: 3 }; }, 20)).toThrow("no longer valid");
    expect(directionRead).toBe(false);
    actions.disposeResources();
    actions.setup(1);
    expect(arena.latest().byteOffset).toBe(second.byteOffset);
    expect(actions.getInput(0, 0).weapon).toBe(0);
  });

  test("a lazy argument can replace input storage without redirecting the captured action", () => {
    const arena = new RecordingArena(1024, () => {});
    const memory = new BotMemory({ kind: "source-hunk", accounting: new SourceHunkAccounting(arena) });
    const actions = new BotActionBuffer(1, new RecordingHost(), memory);
    actions.getInput(0, 0);
    const first = arena.latest();
    const firstView = new DataView(first.bytes.buffer, first.bytes.byteOffset, first.byteLength);

    actions.move(0, () => {
      actions.setup(1);
      actions.selectWeapon(0, 7);
      return { x: 1, y: 2, z: 3 };
    }, 80);
    expect(firstView.getFloat32(8, true)).toBe(1);
    expect(firstView.getFloat32(12, true)).toBe(2);
    expect(firstView.getFloat32(16, true)).toBe(3);
    expect(firstView.getFloat32(20, true)).toBe(80);
    expect(actions.getInput(0, 0)).toMatchObject({ direction: { x: 0, y: 0, z: 0 }, speed: 0, weapon: 7 });

    actions.move(0, { x: 4, y: 5, z: 6 }, 90);
    expect(actions.getInput(0, 0)).toMatchObject({ direction: { x: 4, y: 5, z: 6 }, speed: 90, weapon: 7 });
    expect(firstView.getFloat32(8, true)).toBe(1);
    expect(firstView.getFloat32(20, true)).toBe(80);
  });

  test("starts each client with an independently owned zero input", () => {
    const { actions } = createBuffer();
    const first = actions.getInput(0, 0.125);
    const second = actions.getInput(1, 0.25);
    expect(first).toEqual({
      thinkTime: 0.125, direction: { x: 0, y: 0, z: 0 }, speed: 0,
      viewAngles: { x: 0, y: 0, z: 0 }, actionFlags: 0, weapon: 0,
    });
    expect(second.thinkTime).toBe(0.25);
    expect(second.direction).not.toBe(first.direction);
    actions.attack(0);
    expect(actions.getInput(0, 0.125).actionFlags).toBe(BotActionFlag.ATTACK);
    expect(actions.getInput(1, 0.25).actionFlags).toBe(0);
  });

  test("accumulates every direct and generic action family with source flag values", () => {
    const { actions } = createBuffer(1);
    actions.attack(0);
    actions.use(0);
    actions.respawn(0);
    actions.moveUp(0);
    actions.crouch(0);
    actions.moveDown(0);
    actions.moveForward(0);
    actions.moveBack(0);
    actions.moveLeft(0);
    actions.moveRight(0);
    actions.talk(0);
    actions.gesture(0);
    actions.walk(0);
    actions.action(0, BotActionFlag.AFFIRMATIVE | BotActionFlag.NEGATIVE
      | BotActionFlag.GET_FLAG | BotActionFlag.GUARD_BASE | BotActionFlag.PATROL | BotActionFlag.FOLLOW_ME);
    expect(actions.getInput(0, 0).actionFlags).toBe(0x0bbb3bab);
    actions.action(0, 0x40000000);
    expect(actions.getInput(0, 0).actionFlags).toBe(0x4bbb3bab);
  });

  test("copies direction without normalization and clamps float32 speed to 400", () => {
    const { actions } = createBuffer(1);
    actions.move(0, { x: 1.00000006, y: -2.00000012, z: 0.333333343 }, 400.000031);
    expect(actions.getInput(0, 0)).toMatchObject({
      direction: {
        x: Math.fround(1.00000012),
        y: Math.fround(-2.00000024),
        z: Math.fround(0.333333343),
      },
      speed: 400,
    });
    actions.move(0, { x: 3, y: 4, z: 0 }, -500);
    expect(actions.getInput(0, 0)).toMatchObject({ direction: { x: 3, y: 4, z: 0 }, speed: -400 });
  });

  test("stores view and arbitrary source weapon integers", () => {
    const { actions } = createBuffer(1);
    actions.view(0, { x: 12.3456789, y: -181.25, z: 0.00000001 });
    actions.selectWeapon(0, -17);
    expect(actions.getInput(0, 0)).toMatchObject({
      viewAngles: {
        x: Math.fround(12.3456789), y: Math.fround(-181.25), z: Math.fround(0.00000001),
      },
      weapon: -17,
    });
  });

  test("matches the private jumped-last-frame bit and crouch overlap", () => {
    const { actions } = createBuffer(1);
    actions.jump(0);
    expect(actions.getInput(0, 0).actionFlags).toBe(BotActionFlag.JUMP);
    actions.resetInput(0);
    expect(actions.getInput(0, 0).actionFlags).toBe(0x80);
    actions.jump(0);
    actions.delayedJump(0);
    expect(actions.getInput(0, 0).actionFlags).toBe(0x80);
    actions.resetInput(0);
    actions.delayedJump(0);
    expect(actions.getInput(0, 0).actionFlags).toBe(BotActionFlag.DELAYED_JUMP);
    actions.resetInput(0);
    actions.crouch(0);
    actions.jump(0);
    expect(actions.getInput(0, 0).actionFlags).toBe(BotActionFlag.CROUCH);
  });

  test("getInput copies accumulated state and reset preserves view and weapon", () => {
    const { actions } = createBuffer(1);
    actions.move(0, { x: 1, y: 2, z: 3 }, 200);
    actions.view(0, { x: 4, y: 5, z: 6 });
    actions.selectWeapon(0, 99);
    actions.attack(0);
    const snapshot = actions.getInput(0, 0.123456789);
    expect(snapshot.thinkTime).toBe(Math.fround(0.123456789));
    actions.move(0, { x: 7, y: 8, z: 9 }, 300);
    expect(snapshot.direction).toEqual({ x: 1, y: 2, z: 3 });
    actions.endRegular(0, 0.5);
    expect(actions.getInput(0, 0.25).actionFlags).toBe(BotActionFlag.ATTACK);
    actions.resetInput(0);
    expect(actions.getInput(0, 0)).toEqual({
      thinkTime: 0, direction: { x: 0, y: 0, z: 0 }, speed: 0,
      viewAngles: { x: 4, y: 5, z: 6 }, actionFlags: 0, weapon: 99,
    });
  });
});

describe("be_ea.c client commands", () => {
  test("emits every command form verbatim without adding escaping", () => {
    const { actions, host } = createBuffer(2);
    actions.say(0, "hello \"ranger\"; wave");
    actions.sayTeam(1, "red\nteam");
    actions.tell(0, -7, "target");
    actions.useItem(0, "Quad Damage");
    actions.dropItem(0, "item_quad");
    actions.useInventory(1, "teleporter");
    actions.dropInventory(1, "medkit");
    actions.command(0, "team blue; say ready");
    expect(host.commands).toEqual([
      { client: 0, command: "say hello \"ranger\"; wave" },
      { client: 1, command: "say_team red\nteam" },
      { client: 0, command: "tell -7, target" },
      { client: 0, command: "use Quad Damage" },
      { client: 0, command: "drop item_quad" },
      { client: 1, command: "invuse teleporter" },
      { client: 1, command: "invdrop medkit" },
      { client: 0, command: "team blue; say ready" },
    ]);
  });

  test("uses C-string termination and bounds the source va buffer safely", () => {
    const { actions, host } = createBuffer(1);
    actions.say(0, "visible\0ignored\u{100}");
    actions.command(0, "raw\0ignored");
    expect(host.commands).toEqual([
      { client: 0, command: "say visible" },
      { client: 0, command: "raw" },
    ]);
    actions.say(0, "x".repeat(31_995));
    expect(host.commands[2]?.command).toHaveLength(31_999);
    expect(() => actions.say(0, "x".repeat(31_996))).toThrow("32000-byte");
    expect(() => actions.say(0, "not-byte-\u{100}")).toThrow("byte-valued");
  });
});

describe("bot action boundaries", () => {
  test("rejects unsafe client counts and handles", () => {
    const host = new RecordingHost();
    expect(new BotActionBuffer(0, host).maxClients).toBe(0);
    const sourceDefault = new BotActionBuffer(128, host);
    sourceDefault.attack(127);
    expect(sourceDefault.getInput(127, 0).actionFlags & BotActionFlag.ATTACK).not.toBe(0);
    expect(() => new BotActionBuffer(-1, host)).toThrow("source signed allocation range");
    expect(() => new BotActionBuffer(1.5, host)).toThrow("source signed allocation range");
    const actions = new BotActionBuffer(2, host);
    const invalidCalls: readonly (() => void)[] = [
      () => actions.attack(-1),
      () => actions.move(2, { x: 0, y: 0, z: 0 }, 0),
      () => actions.getInput(1.5, 0),
    ];
    for (const call of invalidCalls) expect(call).toThrow("bot action client");
  });

  test("source command callbacks and empty EndRegular do not address bot inputs", () => {
    const host = new RecordingHost();
    const actions = new BotActionBuffer(0, host);
    actions.shutdown();
    actions.say(-1, "hello");
    actions.sayTeam(2, "ready");
    actions.tell(-1, 7, "target");
    actions.useItem(-1, "quad");
    actions.dropItem(-1, "quad");
    actions.useInventory(-1, "teleporter");
    actions.dropInventory(-1, "teleporter");
    actions.command(2, "x");
    actions.endRegular(-1, Number.NaN);
    expect(host.commands).toEqual([
      { client: -1, command: "say hello" },
      { client: 2, command: "say_team ready" },
      { client: -1, command: "tell 7, target" },
      { client: -1, command: "use quad" },
      { client: -1, command: "drop quad" },
      { client: -1, command: "invuse teleporter" },
      { client: -1, command: "invdrop teleporter" },
      { client: 2, command: "x" },
    ]);
  });

  test("rejects values outside defined C storage", () => {
    const { actions } = createBuffer(1);
    expect(() => actions.action(0, 0x80000000)).toThrow("signed 32-bit");
    expect(() => actions.selectWeapon(0, 1.5)).toThrow("signed 32-bit");
    expect(() => actions.tell(0, Number.NaN, "x")).toThrow("signed 32-bit");
    actions.move(0, { x: Infinity, y: -Infinity, z: NaN }, Infinity);
    expect(actions.getInput(0, NaN)).toMatchObject({ thinkTime: NaN, direction: { x: Infinity, y: -Infinity, z: NaN }, speed: 400 });
    actions.view(0, { x: 0, y: NaN, z: -Infinity });
    expect(actions.getInput(0, Infinity).viewAngles).toEqual({ x: 0, y: NaN, z: -Infinity });
  });
});
