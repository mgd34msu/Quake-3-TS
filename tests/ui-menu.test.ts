import { describe, expect, test } from "bun:test";
import { posix } from "node:path";

import type { IncludeRequest, ScriptSource } from "../src/script/preprocessor.ts";
import {
  loadMenuDefinitions,
  type UiMenuRegistrationEvent,
  type UiMenuRegistrationSink,
  type UiMenuResolver,
} from "../src/ui/menu.ts";

class MemoryResolver implements UiMenuResolver {
  private readonly sources = new Map<string, string>();

  constructor(menu: string | undefined, fallback = false) {
    this.sources.set("ui/hud.txt", `{ loadMenu { "${fallback ? "ui/missing.menu" : "ui/test.menu"}" } }`);
    if (menu !== undefined) this.sources.set(fallback ? "ui/testhud.menu" : "ui/test.menu", menu);
  }

  resolveRoot(path: string): ScriptSource | undefined { return this.source(path); }

  resolve(request: IncludeRequest): ScriptSource | undefined {
    return this.source(posix.join(posix.dirname(request.fromPath), request.requestedPath)) ?? this.source(request.requestedPath);
  }

  private source(path: string): ScriptSource | undefined {
    const text = this.sources.get(path);
    return text === undefined ? undefined : { path, text };
  }
}

class RegistrationTrace implements UiMenuRegistrationSink {
  readonly events: string[] = [];

  async register(event: UiMenuRegistrationEvent): Promise<void> {
    this.events.push(`start:${event.kind}:${event.reference.path}`);
    await Promise.resolve();
    this.events.push(`end:${event.kind}:${event.reference.path}`);
  }
}

function eventNames(events: readonly UiMenuRegistrationEvent[]): readonly string[] {
  return events.map(event => `${event.kind}:${event.reference.path}`);
}

describe("source menu registration stream", () => {
  test("awaits HUD registrations at parse sites and keeps overwritten declarations", async () => {
    const resolver = new MemoryResolver(`
      assetGlobalDef { font "fonts/first" 16 gradientbar "ui/first" font "fonts/second" 20 menuEnterSound "sound/enter" }
      menuDef { font "fonts/menu" name hud background "ui/menu" itemDef { type 7 asset_model "models/item.md3" }
        itemDef { type 1 asset_shader "ui/item" focusSound "sound/focus" background "ui/window" } }
    `);
    const trace = new RegistrationTrace();
    const definitions = await loadMenuDefinitions(
      { resolver, random: { nextInt: (): number => 7 } },
      { kind: "hud", setPath: "ui/hud.txt" },
      {},
      { registrationSink: trace },
    );
    const expected = [
      "font:fonts/first", "picture:ui/first", "font:fonts/second", "sound:sound/enter", "font:fonts/menu",
      "picture:ui/menu", "model:models/item.md3", "picture:ui/item", "sound:sound/focus", "picture:ui/window",
    ];
    expect(eventNames(definitions.registration.events)).toEqual(expected);
    expect(definitions.registration.kind).toBe("completed");
    expect(trace.events).toEqual(expected.flatMap(value => [`start:${value}`, `end:${value}`]));
    expect(definitions.assets.textFont?.path).toBe("fonts/menu");
    expect(definitions.fontRegistered).toBe(true);
  });

  test("marks inspection parses deferred and retains prior HUD global assets", async () => {
    const resolver = new MemoryResolver(`menuDef { name retained }`);
    const first = await loadMenuDefinitions(
      { resolver: new MemoryResolver("assetGlobalDef { font \"fonts/prior\" 24 shadowX 5 }") , random: { nextInt: (): number => 0 } },
      { kind: "hud", setPath: "ui/hud.txt" },
    );
    const definitions = await loadMenuDefinitions(
      { resolver, random: { nextInt: (): number => 0 } },
      { kind: "hud", setPath: "ui/hud.txt" },
      {},
      { initialAssets: first.assets, initialFontRegistered: first.fontRegistered },
    );
    expect(definitions.registration.kind).toBe("deferred");
    expect(definitions.registration.events).toEqual([]);
    expect(definitions.assets.textFont?.path).toBe("fonts/prior");
    expect(definitions.assets.shadowX).toBe(5);
  });

  test("uses the actual cgame test HUD fallback and tolerates both menu files missing", async () => {
    const fallback = await loadMenuDefinitions(
      { resolver: new MemoryResolver("menuDef { name fallback }", true), random: { nextInt: (): number => 0 } },
      { kind: "hud", setPath: "ui/hud.txt" },
    );
    expect(fallback.menus[0]?.window.name).toBe("fallback");
    expect(fallback.loadedFiles).toEqual(["ui/hud.txt", "ui/testhud.menu"]);

    const missing = new MemoryResolver(undefined, true);
    const empty = await loadMenuDefinitions(
      { resolver: missing, random: { nextInt: (): number => 0 } },
      { kind: "hud", setPath: "ui/hud.txt" },
    );
    expect(empty.menus).toEqual([]);
    expect(empty.loadedFiles).toEqual(["ui/hud.txt"]);
  });

  test("HUD sets keep COM paths, separate adjacent strings and stop before trailing malformed text", async () => {
    const sources = new Map([
      ["ui/hud.txt", 'loadMenu { ui/first.menu "ui/second.menu" "ui\\third.menu" } }\n"unterminated'],
      ["ui/first.menu", "menuDef { name first }"],
      ["ui/second.menu", "menuDef { name second }"],
      ["ui\\third.menu", "menuDef { name third }"],
    ]);
    const loaded: string[] = [];
    const resolver: UiMenuResolver = {
      resolveRoot(path) {
        loaded.push(path);
        const text = sources.get(path);
        return text === undefined ? undefined : { path, text };
      },
      resolve: () => { throw new Error("HUD menu sets do not preprocess includes"); },
    };
    const definitions = await loadMenuDefinitions({ resolver, random: { nextInt: (): number => 0 } },
      { kind: "hud", setPath: "ui/hud.txt" });
    expect(loaded).toEqual(["ui/hud.txt", "ui/first.menu", "ui/second.menu", "ui\\third.menu"]);
    expect(definitions.menus.map(menu => menu.window.name)).toEqual(["first", "second", "third"]);
    expect(definitions.diagnostics).toEqual([]);
  });

  test("HUD set directives remain ordinary COM text while reached menu files preprocess macros", async () => {
    const sources = new Map([
      ["ui/hud.txt", '#include "ignored.h"\nloadMenu { ui/test.menu }'],
      ["ui/test.menu", "#define HUD_NAME expanded\nmenuDef { name HUD_NAME }"],
    ]);
    const resolver: UiMenuResolver = {
      resolveRoot(path) { const text = sources.get(path); return text === undefined ? undefined : { path, text }; },
      resolve: () => { throw new Error("HUD set include was incorrectly preprocessed"); },
    };
    const definitions = await loadMenuDefinitions({ resolver, random: { nextInt: (): number => 0 } },
      { kind: "hud", setPath: "ui/hud.txt" });
    expect(definitions.loadedFiles).toEqual(["ui/hud.txt", "ui/test.menu"]);
    expect(definitions.menus[0]?.window.name).toBe("expanded");
  });
});
