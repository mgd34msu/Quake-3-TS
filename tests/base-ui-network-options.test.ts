import { expect, test } from "bun:test";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCatcher, KeyCode } from "../src/core/key-codes.ts";
import type { SceneShader } from "../src/render/ref-entity.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh, setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseNetworkOptionsMenu } from "../src/ui/base/network-options.ts";
import { MenuEvent, MenuFlag } from "../src/ui/base/state.ts";
import type { BaseMenuItem, MenuSpin } from "../src/ui/base/state.ts";
import { baseFixture, deferred } from "./base-ui-fixture.ts";

const shaders = ["menu/art/frame2_l", "menu/art/frame1_r", "menu/art/back_0", "menu/art/back_1"];
function fixtureMenu(f: Awaited<ReturnType<typeof baseFixture>>) {
  // These real Confirm targets exercise navigation, not implementations of the three sibling menus.
  const sibling = new BaseConfirmMenu(f.state), calls: string[] = [];
  const open = async (name: string): Promise<void> => {
    calls.push(`${name}:${f.state.menuDepth}:${f.state.activeMenu === null ? "none" : "parent"}`);
    await sibling.show(`Navigation fixture ${name}`, null, null);
  };
  const network = new BaseNetworkOptionsMenu(f.state, {
    graphics: () => open("graphics"), display: () => open("display"), sound: () => open("sound"),
  });
  return { network, sibling, calls };
}
function item(network: BaseNetworkOptionsMenu, id: number): BaseMenuItem {
  const found = network.menu.items.find(value => value.common.id === id);
  if (found === undefined) throw new Error(`Missing network item ${id}`);
  return found;
}
function rate(network: BaseNetworkOptionsMenu): MenuSpin {
  const value = item(network, 14); if (value.kind !== "spin") throw new Error("Rate is not a source spin control");
  return value;
}
async function event(network: BaseNetworkOptionsMenu, id: number, event = MenuEvent.Activated): Promise<void> {
  const target = item(network, id), callback = target.common.callback;
  if (callback === null) throw new Error("Expected actual network event callback");
  await callback(target, event);
}

test("network source has exact nine items, cache order, fields and post-push network focus", async () => {
  const f = await baseFixture(); try {
    const { network } = fixtureMenu(f), menu = network.menu;
    f.registrations.length = 0;
    await network.show();
    expect(network.menu).toBe(menu); expect(menu.itemCount).toBe(9);
    expect(f.registrations).toEqual(shaders.map(name => `shader:${name}`));
    expect(menu.items.map(value => [value.kind, value.common.id, value.common.x, value.common.y, value.common.flags])).toEqual([
      ["banner", 0, 320, 16, 0x4008], ["bitmap", 0, 0, 78, 0x4000], ["bitmap", 0, 376, 76, 0x4000],
      ["proportional", 10, 216, 186, 0x110], ["proportional", 11, 216, 213, 0x110],
      ["proportional", 12, 216, 240, 0x110], ["proportional", 13, 216, 267, 0x10],
      ["spin", 14, 400, 222, 0x102], ["bitmap", 15, 0, 416, 0x104],
    ]);
    expect(menu.items.map(value => value.common.menuPosition)).toEqual([0,1,2,3,4,5,6,7,8]);
    expect(menu.items.every(value => value.common.parent === menu)).toBe(true);
    expect(menu.items.filter(value => value.kind === "bitmap").map(value => [value.width, value.height, value.focuspic])).toEqual([
      [256,329,null], [256,334,null], [128,64,"menu/art/back_1"],
    ]);
    expect(menu.items.flatMap(value => value.kind === "proportional" || value.kind === "banner" ? [[value.text, value.style, value.color]] : [])).toEqual([
      ["SYSTEM SETUP", 1, {x:1,y:1,z:1,w:1}], ["GRAPHICS", 2, {x:1,y:0,z:0,w:1}],
      ["DISPLAY", 2, {x:1,y:0,z:0,w:1}], ["SOUND", 2, {x:1,y:0,z:0,w:1}], ["NETWORK", 2, {x:1,y:0,z:0,w:1}],
    ]);
    expect([menu.cursor, menu.cursorPrev]).toEqual([6,3]);
    expect([menu.wrapAround, menu.fullscreen, menu.showlogo]).toEqual([true,true,false]);
    expect([rate(network).common.left, rate(network).common.right, rate(network).common.top, rate(network).common.bottom]).toEqual([312,520,222,238]);
    expect(rate(network).itemnames).toEqual(["<= 28.8K","33.6K","56K","ISDN","LAN/Cable/xDSL"]);
    expect(rate(network).numitems).toBe(5); expect(rate(network).curvalue).toBe(0);
    expect(f.cvars.get("rate")).toBeUndefined(); expect(f.state.activeMenu).toBe(menu);
    expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui); expect(f.state.enterSound).toBe(true);
  } finally { f.close(); }
});

test("network rate uses float32 Cvar_VariableValue then int conversion before source thresholds", async () => {
  const f = await baseFixture(); try {
    const { network } = fixtureMenu(f);
    const cases: readonly (readonly [string, number])[] = [
      ["-2147483648",0], ["-1.9",0], ["0",0], ["2500",0], ["2500.75",0], ["2500.9998",0], ["2500.9999",1],
      ["2501",1], ["2.501e3",1], ["3000.9",1], ["3001",2], ["4000.9",2], ["4001",3],
      ["5000.9",3], ["5001",4], ["25000",4], ["2147483520",4], ["not-a-number",0],
    ];
    for (const [text, expected] of cases) {
      f.cvars.set("rate", text, true); await network.show(); expect(rate(network).curvalue).toBe(expected);
      expect(f.cvars.get("rate")?.value).toBe(text); expect(f.state.menuDepth).toBe(1);
    }
    for (const text of ["nan", "inf", "1e300", "2147483647", "-2147483904"]) {
      f.cvars.set("rate", text, true);
      await expect(network.show()).rejects.toThrow("Undefined native base UI integer conversion");
      expect(network.menu.itemCount).toBe(9); expect(rate(network).curvalue).toBe(0);
      expect(network.menu.cursor).toBe(0); expect(f.cvars.get("rate")?.value).toBe(text);
    }
  } finally { f.close(); }
});

for (const flags of [CvarFlag.None, CvarFlag.ReadOnly | CvarFlag.Archive, CvarFlag.Latch | CvarFlag.UserInfo]) {
  test(`network all five rate writes force Cvar_Set and preserve metadata ${flags}`, async () => {
    const f = await baseFixture(); try {
      const { network } = fixtureMenu(f);
      f.cvars.register("rate", "100", flags);
      if ((flags & CvarFlag.Latch) !== 0) f.cvars.set("rate", "777");
      await network.show();
      for (const [index, text] of ["2500","3000","4000","5000","25000"].entries()) {
        rate(network).curvalue = index; await event(network, 14);
        const variable = f.cvars.get("rate"); if (variable === undefined) throw new Error("Missing written rate");
        expect(variable.value).toBe(text); expect(variable.flags).toBe(flags);
        expect(variable.resetValue).toBe("100"); expect(variable.latchedValue).toBeUndefined();
      }
      const before = f.cvars.get("rate");
      for (const value of [-1,5]) { rate(network).curvalue = value; await event(network,14); }
      for (const kind of [MenuEvent.GotFocus,MenuEvent.LostFocus]) {
        rate(network).curvalue = 0; await event(network,14,kind); await event(network,10,kind);
      }
      await event(network,13);
      expect(f.cvars.get("rate")).toEqual(before); expect(f.state.activeMenu).toBe(network.menu);
    } finally { f.close(); }
  });
}

test("network absent rate is created by forced set without UserCreated metadata", async () => {
  const f = await baseFixture(); try {
    const { network } = fixtureMenu(f); await network.show(); await event(network,14);
    expect(f.cvars.get("rate")?.flags).toBe(0); expect(f.cvars.get("rate")?.resetValue).toBe("2500");
  } finally { f.close(); }
});

for (const [id,name] of [[10,"graphics"],[11,"display"],[12,"sound"]] satisfies readonly (readonly [number,string])[]) {
  test(`network ${name} key activation pops before awaited real navigation target`, async () => {
    const f = await baseFixture(); try {
      await cacheMenu(f.state); const { network,sibling,calls } = fixtureMenu(f);
      await network.show(); await setCursorToItem(f.state,network.menu,item(network,id));
      await f.keys.keyEvent(KeyCode.Enter,true,100); await f.keys.keyEvent(KeyCode.Enter,false,101);
      expect(calls).toEqual([`${name}:0:none`]); expect(f.state.activeMenu).toBe(sibling.menu);
      expect(f.events).toContain("sound:sound/misc/menu3.wav:6"); expect(f.state.menuDepth).toBe(1);
    } finally { f.close(); }
  });
}

test("network actual keys move spin control, enforce boundaries, and back returns to real parent", async () => {
  const f = await baseFixture(); try {
    await cacheMenu(f.state); const {network,sibling} = fixtureMenu(f);
    await sibling.show("Parent fixture",null,null); await network.show();
    await f.keys.keyEvent(KeyCode.Down,true,10); await f.keys.keyEvent(KeyCode.Down,false,11);
    expect(network.menu.cursor).toBe(7);
    for (let i=0;i<4;i++) { await f.keys.keyEvent(KeyCode.Right,true,20+i*2); await f.keys.keyEvent(KeyCode.Right,false,21+i*2); }
    expect(f.cvars.get("rate")?.value).toBe("25000"); expect(rate(network).curvalue).toBe(4);
    await f.keys.keyEvent(KeyCode.Right,true,50); await f.keys.keyEvent(KeyCode.Right,false,51);
    expect(rate(network).curvalue).toBe(4);
    await setCursorToItem(f.state,network.menu,item(network,15));
    await f.keys.keyEvent(KeyCode.Enter,true,60); await f.keys.keyEvent(KeyCode.Enter,false,61);
    expect(f.state.activeMenu).toBe(sibling.menu); expect(f.state.menuDepth).toBe(1);
  } finally { f.close(); }
});

test("network cache failure leaves reset stable records and actual partial registration, then retries in order", async () => {
  const f=await baseFixture(); try {
    const {network}=fixtureMenu(f); await network.show();
    const menu=network.menu, items=[...menu.items], commons=items.map(value=>value.common);
    for(const value of items) { value.common.flags=MenuFlag.Hidden; value.common.name="DIRTY"; }
    rate(network).oldvalue=9; rate(network).width=7; menu.showlogo=true;
    const register=f.resources.registerShaderNoMip.bind(f.resources), failure=new Error("second registration failed");
    f.registrations.length=0;
    f.resources.registerShaderNoMip=async name=>{
      expect(menu.itemCount).toBe(0); expect(menu.fullscreen).toBe(false);
      expect(items.every(value=>value.common.parent===null && value.common.name===null)).toBe(true);
      const result=await register(name); if(name===shaders[1]) throw failure; return result;
    };
    await expect(network.show()).rejects.toBe(failure);
    expect(f.registrations).toEqual(shaders.slice(0,2).map(name=>`shader:${name}`));
    expect(f.state.activeMenu).toBe(menu); expect(menu.items).toEqual([]);
    f.resources.registerShaderNoMip=register; f.registrations.length=0;
    await network.show(); expect(menu.items).toEqual(items);
    for(const [index,value] of menu.items.entries()) {
      const previous=items[index], common=commons[index];
      if(previous===undefined || common===undefined)throw new Error("Missing retained source item");
      expect(value).toBe(previous);expect(value.common).toBe(common);
    }
    expect(rate(network).oldvalue).toBe(0); expect(rate(network).width).toBe(0); expect(menu.showlogo).toBe(false);
    expect(f.registrations).toEqual(shaders.map(name=>`shader:${name}`));
    const before=[...menu.items]; await network.cache(); expect(menu.items).toEqual(before);
  } finally {f.close();}
});

test("network late cache completion cannot publish after retirement", async()=>{
  const f=await baseFixture();try{
    const {network}=fixtureMenu(f), gate=deferred(), entered=deferred(), register=f.resources.registerShaderNoMip.bind(f.resources);
    f.registrations.length=0;
    f.resources.registerShaderNoMip=async name=>{const result=await register(name);entered.resolve();await gate.promise;return result;};
    const pending=network.show(); await entered.promise; f.state.retire(); gate.resolve();
    await expect(pending).rejects.toThrow("retired"); expect(network.menu.itemCount).toBe(0); expect(f.state.menuDepth).toBe(0);
    expect(f.registrations).toEqual([`shader:${shaders[0]}`]);
  }finally{f.close();}
});

test("network first cache failure retains successful real shader registrations without publishing menu items", async()=>{
  const f=await baseFixture();try{
    const {network}=fixtureMenu(f), registered=new Map<string,SceneShader|null>(), calls:string[]=[];
    const register=f.resources.registerShaderNoMip.bind(f.resources), failure=new Error("third cache call failed");
    f.resources.registerShaderNoMip=async name=>{ if (name === null) throw new Error("Authored menu cache requires a shader name");
      calls.push(name);if(name==="menu/art/back_0")throw failure;
      const result=await register(name);registered.set(name,result);return result;
    };
    await expect(network.show()).rejects.toBe(failure);
    expect(calls).toEqual(shaders.slice(0,3));expect(network.menu.itemCount).toBe(0);expect(f.state.activeMenu).toBeNull();
    for(const name of shaders.slice(0,2)) {
      const shader=registered.get(name);if(shader===undefined || shader===null)throw new Error("Expected actual retained retail shader");
      expect(await register(name)).toBe(shader);
    }
    f.resources.registerShaderNoMip=register;await network.show();expect(network.menu.itemCount).toBe(9);
  }finally{f.close();}
});

test("network escaped show rejects closed real command execution before publication", async()=>{
  const f=await baseFixture();try{
    const {network}=fixtureMenu(f);const escaped:{promise:Promise<void>|null}={promise:null};
    f.consoleCommands.register("escape-network",()=>{escaped.promise=network.show();});
    f.consoleCommands.executeNow("escape-network");
    if(escaped.promise===null)throw new Error("Missing escaped operation");
    await expect(escaped.promise).rejects.toThrow("closed");expect(network.menu.itemCount).toBe(0);expect(f.state.menuDepth).toBe(0);
  }finally{f.close();}
});

test("network pop completes before sibling failure, and sibling await revalidates retirement", async()=>{
  const f=await baseFixture();try{
    const failure=new Error("navigation failure"), parent=new BaseConfirmMenu(f.state);
    const network=new BaseNetworkOptionsMenu(f.state,{
      graphics:async()=>{expect(f.state.activeMenu).toBe(parent.menu);throw failure;},
      display:async()=>{f.state.retire();}, sound:async()=>{throw new Error("Unexpected sound navigation");},
    });
    await parent.show("Parent",null,null);await network.show();await expect(event(network,10)).rejects.toBe(failure);
    expect(f.state.menuDepth).toBe(1);expect(f.state.activeMenu).toBe(parent.menu);
    await network.show();await expect(event(network,11)).rejects.toThrow("retired");expect(f.state.menuDepth).toBe(1);
  }finally{f.close();}
});

test("network pop clear-state callback retirement prevents sibling entry", async()=>{
  const f=await baseFixture();try{
    const {network,calls}=fixtureMenu(f);await network.show();
    const clear=f.keys.clearStates.bind(f.keys);
    f.keys.clearStates=async()=>{await clear();f.state.retire();};
    await expect(event(network,10)).rejects.toThrow("retired");
    expect(calls).toEqual([]);expect(f.state.menuDepth).toBe(0);expect(f.state.activeMenu).toBeNull();
  }finally{f.close();}
});

test("network refresh renders real retail resources through shared queue and CPU", async()=>{
  const f=await baseFixture(320,240);try{
    await cacheMenu(f.state);const {network}=fixtureMenu(f);await network.show();
    await refresh(f.state,75);f.commands.submit();
    const batches=f.recorder.trace().flatMap(view=>view.batches);
    expect(batches.length).toBeGreaterThan(5);expect(batches.reduce((sum,batch)=>sum+batch.indices.length,0)).toBeGreaterThan(200);
    expect(f.cpu.pixels.some((value,index)=>index%4!==3 && value!==0)).toBe(true);
    expect(network.menu.items.filter(value=>value.kind==="bitmap").every(value=>value.shader!==null)).toBe(true);
    expect(f.state.firstDraw).toBe(false);expect(f.state.enterSound).toBe(false);
    expect(f.events).toContain("sound:sound/misc/menu1.wav:6");
    const before=f.cpu.pixels.slice();await setCursorToItem(f.state,network.menu,item(network,14));rate(network).curvalue=4;
    await refresh(f.state,150);f.commands.submit();expect(f.cpu.pixels).not.toEqual(before);
  }finally{f.close();}
});
