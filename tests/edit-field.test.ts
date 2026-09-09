import { describe, expect, test } from "bun:test";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { EditField } from "../src/core/edit-field.ts";
import type { FieldClipboard, FieldControls } from "../src/core/edit-field.ts";
import { KeyCode } from "../src/core/key-codes.ts";

function fixture(clipboard: FieldClipboard = { kind: "native-unix-unavailable" }) {
  let overstrike = false; const held = new Set<number>(), field = new EditField(); field.widthInChars = 5;
  const controls: FieldControls = { isDown: key => held.has(key), getOverstrike: () => overstrike,
    setOverstrike: value => { overstrike = value; }, clipboard };
  const type = (text: string): void => { for (const char of text) field.charEvent(char.charCodeAt(0), controls); };
  return { field, controls, held, type };
}
describe("source byte edit fields", () => {
  test("insertion, deletion, overstrike, navigation and source scroll offsets", () => {
    const f = fixture(); f.type("abcd"); f.field.keyDown(KeyCode.Left, f.controls); f.type("X");
    expect(f.field.text).toBe("abcXd"); expect(f.field.cursor).toBe(4);
    f.field.keyDown(KeyCode.Delete, f.controls); expect(f.field.text).toBe("abcX");
    f.field.charEvent(8, f.controls); expect(f.field.text).toBe("abc");
    f.field.charEvent(5, f.controls); expect(f.field.scroll).toBe(-2);
    f.field.keyDown(KeyCode.Home, f.controls); expect(f.field.scroll).toBe(-2);
    f.field.keyDown(KeyCode.Insert, f.controls); f.type("Z"); expect(f.field.text).toBe("Zbc");
    f.field.charEvent(1, f.controls); expect(f.field.cursor).toBe(0); expect(f.field.scroll).toBe(0);
    f.field.widthInChars = 19; f.field.charEvent(3, f.controls); expect(f.field.text).toBe(""); expect(f.field.widthInChars).toBe(19);
  });
  test("keypad editing is not silently broadened beyond native keys", () => {
    const f = fixture(); f.type("abc");
    for (const key of [KeyCode.KeypadLeft, KeyCode.KeypadRight, KeyCode.KeypadDelete, KeyCode.KeypadHome, KeyCode.KeypadEnd, KeyCode.KeypadInsert]) f.field.keyDown(key, f.controls);
    expect(f.field.text).toBe("abc"); expect(f.field.cursor).toBe(3); expect(f.controls.getOverstrike()).toBe(false);
    f.held.add(KeyCode.Control); f.field.keyDown(65, f.controls); expect(f.field.cursor).toBe(0);
    f.field.keyDown(69, f.controls); expect(f.field.cursor).toBe(3);
  });
  test("full field early returns precede unused invalid cursor memory checks", () => {
    const f = fixture(); f.type("x".repeat(255)); f.field.cursor = 999; f.field.charEvent(65, f.controls);
    expect(f.field.text.length).toBe(255); expect(f.field.cursor).toBe(999);
    f.field.clear(); f.field.cursor = 999; f.field.keyDown(KeyCode.Delete, f.controls); expect(f.field.cursor).toBe(999);
    expect(() => f.field.charEvent(65, f.controls)).toThrow("Undefined native field");
    f.field.charEvent(3, f.controls); expect(f.field.cursor).toBe(0);
  });
  test("paste follows signed bytes, NUL termination and real insert/overstrike paths", () => {
    let reads = 0; const f = fixture({ kind: "available", read: () => { reads++; return Uint8Array.of(65, 255, 66, 8, 67, 0, 68); } });
    f.field.charEvent(22, f.controls); expect(f.field.text).toBe("AC"); expect(reads).toBe(1);
    f.held.add(KeyCode.Shift); f.field.keyDown(KeyCode.KeypadInsert, f.controls); expect(f.field.text).toBe("ACAC");
    f.field.charEvent(255, f.controls); expect(f.field.text).toBe("ACAC\xff");
    const unavailable = fixture(); unavailable.field.charEvent(22, unavailable.controls); expect(unavailable.field.text).toBe("");
  });
  test("recursive paste is bounded at use and failure cleanup permits the next paste", () => {
    let recursive = true, reads = 0; const f = fixture({ kind: "available", read: () => { reads++; return Uint8Array.of(recursive ? 22 : 65); } });
    expect(() => f.field.charEvent(22, f.controls)).toThrow("32 clipboard reads"); expect(reads).toBe(32);
    recursive = false; f.field.charEvent(22, f.controls); expect(f.field.text).toBe("A");
  });
  test("copied fields retain source metadata and independently own complete byte buffers", () => {
    const f = fixture(); f.type("original"); f.field.scroll = -7;
    const copy = new EditField(); copy.copyFrom(f.field); f.field.clear();
    expect(copy.text).toBe("original"); expect(copy.cursor).toBe(8); expect(copy.scroll).toBe(-7); expect(copy.widthInChars).toBe(5);
  });
  test("completion uses actual command/cvar traversal, quoted remaining args and source cursor timing", () => {
    const commands = new CommandBuffer(), cvars = new CvarRegistry(), lines: string[] = [], field = new EditField();
    commands.register("echo", () => undefined); commands.register("exec", () => undefined); cvars.register("example", "1");
    field.setText("ec hello \"a b\""); field.complete(commands, cvars, text => { lines.push(text); });
    expect(field.text).toBe("\\echo hello \"a b\""); expect(field.cursor).toBe(field.text.length); expect(lines).toEqual([]);
    field.setText("e original"); field.complete(commands, cvars, text => { lines.push(text); });
    expect(field.text).toBe("\\e original"); expect(field.cursor).toBe(2);
    expect(lines).toEqual([
      "]\\e original\n", "    exec\n", "    echo\n", "    example\n",
    ]);
    field.setText("wait"); field.complete(commands, cvars, text => { lines.push(text); }); expect(field.text).toBe("\\wait ");
    expect(commands.pendingText).toBe("");
  });
  test("a later shorter prefix does not shorten the first native completion match", () => {
    const commands = new CommandBuffer(), field = new EditField(), lines: string[] = [];
    commands.register("foo", () => undefined); commands.register("foobar", () => undefined);
    field.setText("f"); field.complete(commands, new CvarRegistry(), text => { lines.push(text); });
    expect(field.text).toBe("\\foobar"); expect(lines).toEqual([
      "]\\foobar\n", "    foobar\n",
    ]);
  });
  test("completion publishes actual command tokenization even with no matching names", () => {
    const commands = new CommandBuffer(), field = new EditField(), cvars = new CvarRegistry();
    commands.tokenize("old discarded");
    field.setText("unknown \"two words\""); field.complete(commands, cvars, () => undefined);
    expect(commands.tokenizedArguments).toEqual(["unknown", "two words"]);
    field.clear(); field.complete(commands, cvars, () => undefined); expect(commands.tokenizedArguments).toEqual([]);
    field.setText("wai"); field.complete(commands, cvars, () => undefined);
    expect(field.text).toBe("\\wait "); expect(commands.tokenizedArguments).toEqual(["wai"]);
  });
  test("completion formatting retains its destination while recursive completion replaces later field writes", () => {
    const commands = new CommandBuffer(), cvars = new CvarRegistry(), outer = new EditField(), inner = new EditField(), lines: string[] = [];
    cvars.register("long" + "x".repeat(252), "1");
    outer.setText("lo argument"); outer.cursor = 2;
    inner.setText("wai");
    const print = (text: string): undefined => {
      lines.push(text);
      if (text === "Com_sprintf: overflow of 257 in 256\n") inner.complete(commands, cvars, print);
    };
    outer.complete(commands, cvars, print);
    expect(lines).toEqual(["Com_sprintf: overflow of 257 in 256\n"]);
    expect(outer.text).toBe("\\long" + "x".repeat(250));
    expect(outer.cursor).toBe(2);
    expect(inner.text).toBe("\\wait  ");
    expect(inner.cursor).toBe(7);
  });
  test("completion retains the token pointer when a nested empty tokenization clears argc only", () => {
    for (const input of [null, ""]) {
      const commands = new CommandBuffer(), cvars = new CvarRegistry(), outer = new EditField(), inner = new EditField();
      cvars.register("long" + "x".repeat(252), "1");
      outer.setText("lo argument");
      inner.setText("unmatched tail");
      const print = (text: string): undefined => {
        if (text !== "Com_sprintf: overflow of 257 in 256\n") return;
        inner.complete(commands, cvars, print);
        commands.tokenize(input);
      };
      outer.complete(commands, cvars, print);
      expect(commands.tokenizedArguments).toEqual([]);
      expect(inner.text).toBe("unmatched tail");
      expect(inner.cursor).toBe(14);
      expect(outer.cursor).toBe(0);
    }
  });
  test("independent command owners do not share completion field or scalar state", () => {
    const commands = new CommandBuffer(), otherCommands = new CommandBuffer(), cvars = new CvarRegistry(), outer = new EditField(), inner = new EditField();
    cvars.register("long" + "x".repeat(252), "1");
    outer.setText("lo argument"); inner.setText("wai");
    outer.complete(commands, cvars, text => {
      if (text === "Com_sprintf: overflow of 257 in 256\n") inner.complete(otherCommands, cvars, () => undefined);
    });
    expect(outer.text).toBe("\\long" + "x".repeat(250));
    expect(outer.cursor).toBe(255);
    expect(inner.text).toBe("\\wait ");
    expect(inner.cursor).toBe(6);
    expect(commands.tokenizedArguments).toEqual(["lo", "argument"]);
    expect(otherCommands.tokenizedArguments).toEqual(["wai"]);
  });
  test("completion lists live command and cvar links after each output callback", () => {
    const commands = new CommandBuffer(), cvars = new CvarRegistry(), field = new EditField(), lines: string[] = [];
    commands.register("map_a", () => undefined); commands.register("map_b", () => undefined);
    cvars.set("map_removed", "1"); cvars.register("map_c", "1");
    field.setText("map_");
    field.complete(commands, cvars, text => {
      lines.push(text);
      if (text.startsWith("]")) {
        commands.unregister("map_a"); commands.register("map_new", () => undefined); cvars.register("map_late", "1");
        commands.tokenize("nested retains arguments");
      } else if (text === "    map_new\n") {
        commands.unregister("map_b"); commands.register("map_after", () => undefined);
      } else if (text === "    map_late\n") {
        cvars.register("map_after", "1"); cvars.resetAll();
      }
    });
    expect(lines).toEqual([
      "]\\map_\n", "    map_new\n", "    map_late\n", "    map_c\n",
    ]);
    expect(commands.tokenizedArguments).toEqual(["nested", "retains", "arguments"]);
    expect(commands.registeredNames()).toEqual(["map_after", "map_new", "wait"]);
    expect(cvars.get("map_removed")).toBeUndefined();
  });
  test("completion source command traversal observes dispatch moving its current record", () => {
    const commands = new CommandBuffer(), cvars = new CvarRegistry(), field = new EditField(), lines: string[] = [];
    commands.register("map_a", () => undefined); commands.register("map_b", () => undefined);
    let dispatched = false;
    field.setText("map_");
    field.complete(commands, cvars, text => {
      lines.push(text);
      if (text === "    map_a\n" && !dispatched) { dispatched = true; commands.executeNow("map_a fromPrint"); }
    });
    expect(lines).toEqual([
      "]\\map_\n", "    map_b\n", "    map_a\n", "    map_b\n",
    ]);
    expect(commands.tokenizedArguments).toEqual(["map_a", "fromPrint"]);
  });
  test("a completion print abort preserves the completed field and skips remaining names", () => {
    const commands = new CommandBuffer(), field = new EditField(), failure = new Error("completion print failed"), lines: string[] = [];
    commands.register("map_a", () => undefined); commands.register("map_b", () => undefined);
    field.setText("map_ argument");
    expect(() => field.complete(commands, new CvarRegistry(), text => { lines.push(text); throw failure; })).toThrow(failure);
    expect(lines).toEqual([
      "]\\map_ argument\n",
    ]);
    expect(field.text).toBe("\\map_ argument"); expect(field.cursor).toBe(5);
    expect(commands.tokenizedArguments).toEqual(["map_", "argument"]);
  });
});
