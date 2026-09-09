import { expect, test } from "bun:test";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import type { Vec4 } from "../src/core/math.ts";
import { EngineClientSession } from "../src/engine/client-session.ts";
import { encodeServerMessage } from "../src/protocol/server-message.ts";
import type { Rect2D, TextureRect } from "../src/render/draw2d.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseServerInfoMenu } from "../src/ui/base/server-info.ts";
import { MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import type { BaseMenuItem } from "../src/ui/base/state.ts";
import { ProtocolClientLifecycle } from "../tools/client-protocol-fixture.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

type Fixture = Awaited<ReturnType<typeof baseFixture>>;
const shaders = ["menu/art/frame2_l", "menu/art/frame1_r", "menu/art/back_0", "menu/art/back_1"];
function at<T>(values: readonly T[], index: number): T {
  const value = values[index]; if (value === undefined) throw new Error(`Missing fixture element ${index}`); return value;
}
function item(menu: BaseServerInfoMenu, id: number): BaseMenuItem {
  const value = menu.menu.items.find(entry => entry.common.id === id);
  if (value === undefined) throw new Error(`Missing Server Info item ${id}`); return value;
}
async function event(menu: BaseServerInfoMenu, id: number, kind = MenuEvent.Activated): Promise<void> {
  const target = item(menu, id), callback = target.common.callback;
  if (callback === null) throw new Error("Missing actual event callback"); await callback(target, kind);
}
function observeGlyphs(f: Fixture) {
  const glyphs: { readonly rect: Rect2D; readonly uv: TextureRect; readonly color: Vec4 | null; readonly byte: number }[] = [];
  const picture = f.resources.picture(f.state.media.charset), stretch = f.state.draw.stretchPixels.bind(f.state.draw);
  const setColor = f.state.draw.setColor.bind(f.state.draw);
  let color: Vec4 | null = null;
  f.state.draw.setColor = value => { color = value === null ? null : { ...value }; setColor(value); };
  f.state.draw.stretchPixels = (rect, uv, actual) => {
    if (actual === picture) glyphs.push({ rect: { ...rect }, uv: { ...uv }, color,
      byte: (uv.t * 256 + uv.s * 16) & 255 });
    stretch(rect, uv, actual);
  };
  return glyphs;
}
async function draw(menu: BaseServerInfoMenu): Promise<void> {
  const callback = menu.menu.draw; if (callback === null) throw new Error("Missing actual custom draw"); await callback();
}

test("Server Info has source five items, cache order, source flags and actual default key focus", async () => {
  const f = await baseFixture(); try {
    let reads = 0;
    const info = new BaseServerInfoMenu(f.state, () => { reads++; expect(info.menu.itemCount).toBe(0); return "\\mapname\\q3dm1"; });
    const menu = info.menu; f.registrations.length = 0; await info.show();
    expect(info.menu).toBe(menu); expect(reads).toBe(1);
    expect(f.registrations).toEqual(shaders.map(name => `shader:${name}`));
    expect(menu.items.map(value => [value.kind, value.common.id, value.common.x, value.common.y, value.common.flags])).toEqual([
      ["banner",0,320,16,0x4000], ["bitmap",0,0,78,0x4000], ["bitmap",0,376,76,0x4000],
      ["proportional",100,320,371,0x108], ["bitmap",101,0,416,0x104],
    ]);
    expect(menu.items.map(value => value.common.menuPosition)).toEqual([0,1,2,3,4]);
    expect(menu.items.every(value => value.common.parent === menu)).toBe(true);
    expect(menu.items.filter(value => value.kind === "bitmap").map(value => [value.width,value.height,value.focuspic])).toEqual([
      [256,329,null],[256,334,null],[128,64,"menu/art/back_1"],
    ]);
    expect(menu.items.flatMap(value => value.kind === "banner" || value.kind === "proportional" ? [[value.text,value.style,value.color]] : [])).toEqual([
      ["SERVER INFO",1,{x:1,y:1,z:1,w:1}], ["ADD TO FAVORITES",0x11,{x:1,y:0,z:0,w:1}],
    ]);
    expect([menu.itemCount,menu.cursor,menu.cursorPrev]).toEqual([5,3,0]);
    expect([menu.wrapAround,menu.fullscreen,menu.showlogo]).toEqual([true,true,false]);
    expect(menu.key).not.toBeNull(); expect(menu.draw).not.toBeNull();
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.state.activeMenu).toBe(menu);
  } finally { f.close(); }
});

test("Server Info samples sv_running after cache and before configstrings, with banner flags still zero", async () => {
  const f = await baseFixture(); try {
    let retained: BaseMenuItem | null = null;
    const info = new BaseServerInfoMenu(f.state, () => {
      if (retained !== null) expect(retained.common.flags).toBe(0);
      expect(f.cvars.get("sv_running")?.value).toBe("1");
      f.cvars.set("sv_running", "0", true); return "";
    });
    const register = f.resources.registerShaderNoMip.bind(f.resources);
    f.resources.registerShaderNoMip = async name => {
      const result = await register(name); if (name === shaders[3]) f.cvars.set("sv_running", "1", true); return result;
    };
    await info.show(); retained = at(info.menu.items,0); await info.show();
    expect(item(info,100).common.flags).toBe(0x2108); expect(info.menu.cursor).toBe(4);
    f.resources.registerShaderNoMip = register;
  } finally { f.close(); }
});

test("Server Info reads actual session gamestate once per show and refresh uses its captured bytes", async () => {
  const f = await baseFixture(320,240), lifecycle = new ProtocolClientLifecycle(f.cvars);
  const client = new EngineClientSession({ product:"baseq3", cvars:f.cvars, lifecycle,
    mode:{kind:"network",challenge:17,qport:27961} });
  try {
    async function receive(value: string): Promise<void> {
      const number = client.serverMessageSequence + 1;
      const bytes = encodeServerMessage(0,[{kind:"gamestate",commandSequence:0,clientNumber:0,checksumFeed:19,
        entries:[{kind:"configstring",index:1,value:"\\sv_serverid\\100\\sv_cheats\\1"}, {kind:"configstring",index:0,value}]}],
      {product:"baseq3",messageNumber:number,reliableSequence:0,serverCommandSequence:0,parseEntitiesNumber:0,baseline:()=>null,history:()=>null});
      await client.receiveServerMessage(number,bytes);
    }
    await receive("\\hostname\\FIRST"); await cacheMenu(f.state);
    let reads = 0; const info = new BaseServerInfoMenu(f.state,() => { reads++; return at(client.getGameState(),0); });
    await info.show(); await refresh(f.state,0); f.commands.submit(); const first = f.cpu.pixels.slice();
    await receive("\\hostname\\SECOND"); await refresh(f.state,0); f.commands.submit();
    expect(reads).toBe(1); expect(f.cpu.pixels).toEqual(first);
    await info.show(); await refresh(f.state,0); f.commands.submit();
    expect(reads).toBe(2); expect(f.cpu.pixels).not.toEqual(first);
    expect(lifecycle.gamestates).toHaveLength(2);
    expect(f.recorder.trace().flatMap(view=>view.batches).flatMap(batch=>batch.vertices)
      .some(vertex => Math.round(vertex.color.x*255)===255 && Math.round(vertex.color.y*255)===109 && vertex.color.z===0)).toBe(true);
  } finally { lifecycle.close(); f.close(); }
});

test("Info_NextPair keeps order, duplicates, empty values and malformed trailing keys in real glyph geometry", async () => {
  const f = await baseFixture(640,480); try {
    await cacheMenu(f.state); let raw = "\\a\\A\\a\\\\tail";
    const info = new BaseServerInfoMenu(f.state,()=>raw), glyphs = observeGlyphs(f);
    await info.show(); await draw(info); f.commands.submit();
    expect(glyphs.map(glyph=>String.fromCharCode(glyph.byte)).join("")).toBe("a:Aa:tail:");
    expect(glyphs.map(glyph=>[glyph.rect.x,glyph.rect.y])).toEqual([
      [296,196],[304,196],[328,196],[296,212],[304,212], [272,228],[280,228],[288,228],[296,228],[304,228],
    ]);
    expect(at(glyphs,0).uv).toEqual({s:1/16,t:6/16,s2:2/16,t2:7/16});
    expect(at(glyphs,0).color).toEqual({x:1,y:0,z:0,w:1});
    expect(at(glyphs,2).color).toEqual({x:1,y:Math.fround(.43),z:0,w:1});
    for (const [text,expected] of [["a\\b","a:b"],["\\a\\b\\\\discard\\z\\q","a:b"],["\\\\value",""],["\\",""],["",""]]) {
      if (text===undefined || expected===undefined) throw new Error("Missing pair case");
      raw=text; glyphs.length=0; await info.show(); await draw(info); f.commands.submit();
      expect(glyphs.map(glyph=>String.fromCharCode(glyph.byte)).join("")).toBe(expected);
    }
  } finally { f.close(); }
});

test("Server Info clamps only centering to 16 and renders all 18 source pairs", async () => {
  const f = await baseFixture(640,480); try {
    await cacheMenu(f.state); const raw=Array.from({length:18},()=>"\\a\\b").join("");
    const info=new BaseServerInfoMenu(f.state,()=>raw), glyphs=observeGlyphs(f);
    await info.show(); await draw(info); f.commands.submit();
    expect(glyphs).toHaveLength(54);
    expect(glyphs.filter(glyph=>glyph.rect.x===328).map(glyph=>glyph.rect.y)).toEqual(Array.from({length:18},(_,i)=>92+i*16));
    expect(at(glyphs,53).rect.y).toBe(364);
  } finally { f.close(); }
});

test("Server Info 1023-byte copy, NUL and Q_strcat full-key truncation preserve source bytes", async () => {
  const f=await baseFixture(160,120);try{
    await cacheMenu(f.state);let raw="x".repeat(1023)+"IGNORED\u0100";
    const info=new BaseServerInfoMenu(f.state,()=>raw),glyphs=observeGlyphs(f);
    await info.show();await draw(info);f.commands.submit();
    expect(glyphs).toHaveLength(1023);expect(glyphs.every(glyph=>glyph.byte===120)).toBe(true);
    raw="\\k\\"+"v".repeat(1020)+"IGNORED";glyphs.length=0;
    await info.show();await draw(info);f.commands.submit();expect(glyphs).toHaveLength(1022);
    expect(glyphs.filter(glyph=>glyph.byte===118)).toHaveLength(1020);
    raw="\\\xff\\\x80\0\\ignored\\tail\u0100";glyphs.length=0;
    await info.show();await draw(info);f.commands.submit();expect(glyphs.map(glyph=>glyph.byte)).toEqual([255,58,128]);
    expect(at(glyphs,0).uv.t).toBe(-1/16);expect(at(glyphs,2).uv.t).toBe(-.5);
    raw="\\key\\\u0100";await expect(info.show()).rejects.toThrow("source bytes");expect(info.menu.itemCount).toBe(0);
  }finally{f.close();}
});

test("real key activation reads the current address late and returns to a genuine parent", async () => {
  const f=await baseFixture();try{
    await cacheMenu(f.state);const parent=new BaseConfirmMenu(f.state),info=new BaseServerInfoMenu(f.state,()=>"");
    await parent.show("Parent",null,null);f.cvars.set("cl_currentServerAddress","OLD",true);await info.show();
    f.cvars.set("cl_currentServerAddress","NEW",true);
    await f.keys.keyEvent(KeyCode.Enter,true,100);await f.keys.keyEvent(KeyCode.Enter,false,101);
    expect(f.cvars.get("server1")?.value).toBe("NEW");expect(f.state.activeMenu).toBe(parent.menu);expect(f.state.menuDepth).toBe(1);
    expect(f.events).toContain("sound:sound/misc/menu3.wav:6");
    await info.show();await setCursorToItem(f.state,info.menu,item(info,101));
    await f.keys.keyEvent(KeyCode.Enter,true,110);await f.keys.keyEvent(KeyCode.Enter,false,111);
    expect(f.state.activeMenu).toBe(parent.menu);
  }finally{f.close();}
});

test("Favorites scans all slots before writing, retains case-insensitive duplicates and still pops", async () => {
  const f=await baseFixture();try{
    const info=new BaseServerInfoMenu(f.state,()=>"");
    f.cvars.set("cl_currentServerAddress","Example:27960",true);f.cvars.set("server16","eXAMPLE:27960",true);
    const before=f.cvars.get("server16");await info.show();await event(info,100);
    expect(f.cvars.get("server1")?.value).toBe("");expect(f.cvars.get("server16")).toEqual(before);expect(f.state.menuDepth).toBe(0);
    for(let i=1;i<=16;i++)f.cvars.set(`server${i}`,`${i}.0.0.1`,true);
    f.cvars.set("server3","host",true);f.cvars.set("server5","another",true);await info.show();await event(info,100);
    expect(f.cvars.get("server3")?.value).toBe("Example:27960");expect(f.cvars.get("server5")?.value).toBe("another");
    f.cvars.set("server3","3.0.0.1",true);f.cvars.set("server5","5.0.0.1",true);await info.show();await event(info,100);
    expect(f.cvars.get("server1")?.value).toBe("1.0.0.1");expect(f.state.menuDepth).toBe(0);
    f.cvars.set("cl_currentServerAddress","",true);await info.show();await event(info,100);expect(f.state.menuDepth).toBe(0);
  }finally{f.close();}
});

test("Favorites honors 127-byte source buffers, NUL and ASCII-only comparison", async () => {
  const f=await baseFixture();try{
    const info=new BaseServerInfoMenu(f.state,()=>"");const prefix="A".repeat(127);
    f.cvars.set("cl_currentServerAddress",prefix+"one",true);f.cvars.set("server16",prefix.toLowerCase()+"two",true);
    await info.show();await event(info,100);expect(f.cvars.get("server1")?.value).toBe("");
    f.cvars.set("server16","",true);await info.show();await event(info,100);expect(f.cvars.get("server1")?.value).toBe(prefix);
    f.cvars.set("cl_currentServerAddress","\xc0\0ignored",true);f.cvars.set("server1","\xe0",true);
    await info.show();await event(info,100);expect(f.cvars.get("server1")?.value).toBe("\xc0");
    f.cvars.set("cl_currentServerAddress","MIXED\0ignored",true);f.cvars.set("server1","mixed",true);
    await info.show();await event(info,100);expect(f.cvars.get("server1")?.value).toBe("mixed");
  }finally{f.close();}
});

for(const extraFlags of [CvarFlag.ReadOnly,CvarFlag.Latch,CvarFlag.None]) {
  test(`Favorites forced write preserves actual cvar flags/reset and consumes pending value ${extraFlags}`,async()=>{
    const f=await baseFixture();try{
      const info=new BaseServerInfoMenu(f.state,()=>"");f.cvars.addFlags("server1",extraFlags);
      if(extraFlags===CvarFlag.Latch)f.cvars.set("server1","pending");
      const before=f.cvars.get("server1");if(before===undefined)throw new Error("Missing favorite cvar");
      f.cvars.set("cl_currentServerAddress","Favorite",true);await info.show();await event(info,100);
      const after=f.cvars.get("server1");if(after===undefined)throw new Error("Missing written favorite");
      expect(after.value).toBe("Favorite");expect(after.flags).toBe(before.flags);expect(after.resetValue).toBe(before.resetValue);
      expect(after.latchedValue).toBeUndefined();expect(after.modificationCount).toBe(before.modificationCount+1);
      f.cvars.clearModified("server1");const equal=f.cvars.get("server1");await info.show();await event(info,100);
      expect(f.cvars.get("server1")).toEqual(equal);
    }finally{f.close();}
  });
}

test("Favorites creates an actually absent slot through forced registry set",async()=>{
  const f=await baseFixture();try{
    f.cvars.addFlags("server1",CvarFlag.UserCreated);f.cvars.resetAll();expect(f.cvars.get("server1")).toBeUndefined();
    f.cvars.set("cl_currentServerAddress","NEW",true);const info=new BaseServerInfoMenu(f.state,()=>"");
    await info.show();await event(info,100);expect(f.cvars.get("server1")?.flags).toBe(0);expect(f.cvars.get("server1")?.resetValue).toBe("NEW");
  }finally{f.close();}
});

test("an equal current favorite returns before forced set and retains its pending latch",async()=>{
  const f=await baseFixture();try{
    const info=new BaseServerInfoMenu(f.state,()=>"");f.cvars.set("server1","same",true);
    f.cvars.addFlags("server1",CvarFlag.Latch);f.cvars.set("server1","pending");
    f.cvars.set("cl_currentServerAddress","SAME",true);const before=f.cvars.get("server1");
    await info.show();await event(info,100);expect(f.cvars.get("server1")).toEqual(before);
    expect(f.cvars.get("server1")?.latchedValue).toBe("pending");expect(f.state.menuDepth).toBe(0);
  }finally{f.close();}
});

test("missing current address still pops and source sv_running float truth controls actual focus",async()=>{
  const f=await baseFixture();try{
    const info=new BaseServerInfoMenu(f.state,()=>"");expect(f.cvars.get("cl_currentServerAddress")).toBeUndefined();
    await info.show();await event(info,100);expect(f.state.menuDepth).toBe(0);expect(f.cvars.get("server1")?.value).toBe("");
    for(const [text,grayed] of [["0",false],["-0",false],["0.1",true],["-1",true],["nan",true],["inf",true]] satisfies readonly (readonly [string,boolean])[]) {
      f.cvars.set("sv_running",text,true);await info.show();
      expect((item(info,100).common.flags&MenuFlag.Grayed)!==0).toBe(grayed);expect(info.menu.cursor).toBe(grayed?4:3);
    }
  }finally{f.close();}
});

test("non-Activated and unknown events do not write/pop; cvar failure prevents pop and pop failure preserves write",async()=>{
  const f=await baseFixture();try{
    const info=new BaseServerInfoMenu(f.state,()=>"");f.cvars.set("cl_currentServerAddress","NEW",true);await info.show();
    for(const kind of [MenuEvent.GotFocus,MenuEvent.LostFocus])for(const id of [100,101])await event(info,id,kind);
    const add=item(info,100);add.common.id=999;await event(info,999);add.common.id=100;
    expect(f.cvars.get("server1")?.value).toBe("");expect(f.state.activeMenu).toBe(info.menu);
    const set=f.cvars.set.bind(f.cvars),failure=new Error("write failed");
    f.cvars.set=(name,value,force)=>{if(name==="server1")throw failure;return set(name,value,force);};
    await expect(event(info,100)).rejects.toBe(failure);expect(f.state.menuDepth).toBe(1);f.cvars.set=set;
    f.keys.clearStates=async()=>{throw failure;};await expect(event(info,100)).rejects.toBe(failure);
    expect(f.cvars.get("server1")?.value).toBe("NEW");expect(f.state.activeMenu).toBeNull();expect(f.state.menuDepth).toBe(0);
  }finally{f.close();}
});

test("Server Info resets stable records before failing cache, retains partial media, and retries",async()=>{
  const f=await baseFixture();try{
    const info=new BaseServerInfoMenu(f.state,()=>"\\a\\b");await info.show();
    const menu=info.menu,items=[...menu.items],commons=items.map(value=>value.common),key=menu.key,drawCallback=menu.draw;
    for(const value of items){value.common.flags=MenuFlag.Hidden;value.common.name="DIRTY";}menu.showlogo=true;
    const register=f.resources.registerShaderNoMip.bind(f.resources),failure=new Error("cache failed");
    f.registrations.length=0;f.resources.registerShaderNoMip=async name=>{
      expect(menu.itemCount).toBe(0);expect(menu.draw).toBeNull();expect(menu.key).toBeNull();
      expect(items.every(value=>value.common.parent===null&&value.common.name===null)).toBe(true);
      const shader=await register(name);if(name===shaders[1])throw failure;return shader;
    };
    await expect(info.show()).rejects.toBe(failure);expect(f.registrations).toEqual(shaders.slice(0,2).map(name=>`shader:${name}`));
    expect(menu.items).toEqual([]);expect(f.state.activeMenu).toBe(menu);
    f.resources.registerShaderNoMip=register;f.registrations.length=0;await info.show();
    for(const [index,value] of menu.items.entries()){expect(value).toBe(at(items,index));expect(value.common).toBe(at(commons,index));}
    expect(menu.key).toBe(key);expect(menu.draw).toBe(drawCallback);expect(menu.showlogo).toBe(false);
    const before=[...menu.items];await info.cache();expect(menu.items).toEqual(before);
    expect(f.registrations).toEqual([...shaders,...shaders].map(name=>`shader:${name}`));
  }finally{f.close();}
});

test("Server Info retirement during real cache or configstring read rejects later publication",async()=>{
  for(const boundary of ["cache","configstring"]) {
    const f=await baseFixture();try{
      const gate=deferred(),entered=deferred(),register=f.resources.registerShaderNoMip.bind(f.resources);
      const info=new BaseServerInfoMenu(f.state,()=>{if(boundary==="configstring")f.state.retire();return "\\x\\y";});
      if(boundary==="cache")f.resources.registerShaderNoMip=async name=>{const result=await register(name);entered.resolve();await gate.promise;return result;};
      const pending=info.show();if(boundary==="cache"){await entered.promise;f.state.retire();gate.resolve();}
      await expect(pending).rejects.toThrow("retired");expect(info.menu.itemCount).toBe(0);expect(f.state.menuDepth).toBe(0);
    }finally{f.close();}
  }
});

test("first-show cache failure retains actual completed shader identity and retry does not sample prematurely",async()=>{
  const f=await baseFixture();try{
    let reads=0;const info=new BaseServerInfoMenu(f.state,()=>{reads++;return "";});
    const register=f.resources.registerShaderNoMip.bind(f.resources),failure=new Error("fourth registration failed");
    const completed: Awaited<ReturnType<typeof register>>[]=[];
    f.resources.registerShaderNoMip=async name=>{
      if(name===shaders[3])throw failure;const shader=await register(name);completed.push(shader);return shader;
    };
    await expect(info.show()).rejects.toBe(failure);expect(reads).toBe(0);expect(info.menu.itemCount).toBe(0);expect(f.state.activeMenu).toBeNull();
    for(let index=0;index<3;index++){expect(at(completed,index)).not.toBeNull();expect(await register(at(shaders,index))).toBe(at(completed,index));}
    f.resources.registerShaderNoMip=register;await info.show();expect(reads).toBe(1);expect(info.menu.itemCount).toBe(5);
  }finally{f.close();}
});

test("controlled cache reentry uses the same source record and preserves inner publication before outer continuation",async()=>{
  const f=await baseFixture();try{
    let entered=false,reads=0;const info=new BaseServerInfoMenu(f.state,()=>{reads++;return `\\call\\${reads}`;});
    const register=f.resources.registerShaderNoMip.bind(f.resources);
    f.resources.registerShaderNoMip=async name=>{
      const shader=await register(name);
      if(!entered){entered=true;await info.show();expect(info.menu.itemCount).toBe(5);}
      return shader;
    };
    await info.show();expect(reads).toBe(2);expect(info.menu.itemCount).toBe(10);expect(f.state.menuDepth).toBe(1);
    for(let index=0;index<5;index++)expect(at(info.menu.items,index)).toBe(at(info.menu.items,index+5));
    f.resources.registerShaderNoMip=register;await info.show();expect(info.menu.itemCount).toBe(5);expect(reads).toBe(3);
  }finally{f.close();}
});

test("raw configstring failure retains source setup and does not publish items or an active menu",async()=>{
  const f=await baseFixture();try{
    const failure=new Error("configstring read failed");let fail=true;
    const info=new BaseServerInfoMenu(f.state,()=>{if(fail)throw failure;return "\\key\\value";});
    await expect(info.show()).rejects.toBe(failure);expect(info.menu.draw).not.toBeNull();expect(info.menu.key).not.toBeNull();
    expect(info.menu.fullscreen).toBe(true);expect(info.menu.itemCount).toBe(0);expect(f.state.activeMenu).toBeNull();
    fail=false;await info.show();expect(info.menu.itemCount).toBe(5);
  }finally{f.close();}
});

test("Server Info escaped command operation and retired pop callbacks cannot continue",async()=>{
  const f=await baseFixture();try{
    const info=new BaseServerInfoMenu(f.state,()=>""),escaped:{promise:Promise<void>|null}={promise:null};
    f.consoleCommands.register("escape-info",()=>{escaped.promise=info.show();});f.consoleCommands.executeNow("escape-info");
    if(escaped.promise===null)throw new Error("Missing escaped operation");
    await expect(escaped.promise).rejects.toThrow("closed");expect(info.menu.itemCount).toBe(0);
    await info.show();const clear=f.keys.clearStates.bind(f.keys);f.keys.clearStates=async()=>{await clear();f.state.retire();};
    await expect(event(info,101)).rejects.toThrow("retired");expect(f.state.activeMenu).toBeNull();
    await expect(info.cache()).rejects.toThrow("retired");
  }finally{f.close();}
});
