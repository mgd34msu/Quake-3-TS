import { expect,test } from "bun:test";
import { CvarFlag } from "../src/core/cvar.ts";
import { KeyCatcher,KeyCode } from "../src/core/key-codes.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { cacheMenu } from "../src/ui/base/draw.ts";
import { refresh,setCursorToItem } from "../src/ui/base/framework.ts";
import { BaseNetworkOptionsMenu } from "../src/ui/base/network-options.ts";
import { BaseSoundOptionsMenu } from "../src/ui/base/sound-options.ts";
import { MenuEvent,MenuFlag } from "../src/ui/base/state.ts";
import type { BaseMenuItem,MenuSlider,MenuSpin } from "../src/ui/base/state.ts";
import type { SceneShader } from "../src/render/ref-entity.ts";
import { baseFixture,deferred } from "./base-ui-fixture.ts";

const art=["menu/art/frame2_l","menu/art/frame1_r","menu/art/back_0","menu/art/back_1"];
function menus(f:Awaited<ReturnType<typeof baseFixture>>){
  const confirm=new BaseConfirmMenu(f.state),calls:string[]=[];
  const graphics=async()=>{calls.push(`graphics:${f.state.menuDepth}`);await confirm.show("Graphics navigation fixture",null,null);};
  const display=async()=>{calls.push(`display:${f.state.menuDepth}`);await confirm.show("Display navigation fixture",null,null);};
  const sound:BaseSoundOptionsMenu=new BaseSoundOptionsMenu(f.state,{graphics,display,network:async()=>{calls.push(`network:${f.state.menuDepth}`);await network.show();}});
  const network:BaseNetworkOptionsMenu=new BaseNetworkOptionsMenu(f.state,{graphics,display,sound:()=>sound.show()});
  return {sound,network,confirm,calls};
}
function item(sound:BaseSoundOptionsMenu,id:number):BaseMenuItem{
  const value=sound.menu.items.find(value=>value.common.id===id);if(value===undefined)throw new Error(`Missing source sound item ${id}`);return value;
}
function slider(sound:BaseSoundOptionsMenu,id:number):MenuSlider{
  const value=item(sound,id);if(value.kind!=="slider")throw new Error("Expected source slider");return value;
}
function quality(sound:BaseSoundOptionsMenu):MenuSpin{
  const value=item(sound,16);if(value.kind!=="spin")throw new Error("Expected source quality spin");return value;
}
async function event(sound:BaseSoundOptionsMenu,id:number,kind=MenuEvent.Activated):Promise<void>{
  const value=item(sound,id),callback=value.common.callback;if(callback===null)throw new Error("Missing source callback");await callback(value,kind);
}

test("sound exact eleven source items, four art registrations and initial Sound focus",async()=>{
  const f=await baseFixture();try{
    const {sound}=menus(f),menu=sound.menu;f.registrations.length=0;await sound.show();
    expect(sound.menu).toBe(menu);expect(menu.itemCount).toBe(11);expect(f.registrations).toEqual(art.map(name=>`shader:${name}`));
    expect(menu.items.map(value=>[value.kind,value.common.id,value.common.x,value.common.y,value.common.flags])).toEqual([
      ["banner",0,320,16,0x4008],["bitmap",0,0,78,0x4000],["bitmap",0,376,76,0x4000],
      ["proportional",10,216,186,0x110],["proportional",11,216,213,0x110],["proportional",12,216,240,0x10],
      ["proportional",13,216,267,0x110],["slider",14,400,213,0x102],["slider",15,400,231,0x102],
      ["spin",16,400,249,0x102],["bitmap",18,0,416,0x104],
    ]);
    expect(menu.items.every((value,index)=>value.common.parent===menu&&value.common.menuPosition===index)).toBe(true);
    expect(menu.items.filter(value=>value.kind==="bitmap").map(value=>[value.width,value.height,value.focuspic])).toEqual([[256,329,null],[256,334,null],[128,64,"menu/art/back_1"]]);
    expect(menu.items.flatMap(value=>value.kind==="banner"||value.kind==="proportional"?[[value.text,value.style,value.color]]:[])).toEqual([
      ["SYSTEM SETUP",1,{x:1,y:1,z:1,w:1}],["GRAPHICS",2,{x:1,y:0,z:0,w:1}],["DISPLAY",2,{x:1,y:0,z:0,w:1}],
      ["SOUND",2,{x:1,y:0,z:0,w:1}],["NETWORK",2,{x:1,y:0,z:0,w:1}],
    ]);
    expect([menu.cursor,menu.cursorPrev,menu.wrapAround,menu.fullscreen,menu.showlogo]).toEqual([5,3,true,true,false]);
    expect([slider(sound,14).common.name,slider(sound,15).common.name,quality(sound).common.name]).toEqual(["Effects Volume:","Music Volume:","Sound Quality:"]);
    expect([slider(sound,14).minvalue,slider(sound,14).maxvalue,slider(sound,14).curvalue,slider(sound,14).range]).toEqual([0,10,0,0]);
    expect([quality(sound).curvalue,quality(sound).numitems,quality(sound).itemnames]).toEqual([1,2,["Low","High"]]);
    expect(f.cvars.get("s_volume")).toBeUndefined();expect(f.keys.getCatcher()).toBe(KeyCatcher.Ui);
  }finally{f.close();}
});

test("sound samples float32 cvars after cache, preserves fractional and unclamped initialization",async()=>{
  const f=await baseFixture();try{
    const {sound}=menus(f),register=f.resources.registerShaderNoMip.bind(f.resources),gate=deferred(),entered=deferred();
    f.cvars.set("s_volume",".2",true);
    f.resources.registerShaderNoMip=async name=>{const result=await register(name);if(name===art[3]){entered.resolve();await gate.promise;}return result;};
    const pending=sound.show();await entered.promise;
    f.cvars.set("s_volume",".1234567",true);f.cvars.set("s_musicvolume","-1.25",true);f.cvars.set("s_compression","-3",true);gate.resolve();await pending;
    expect(slider(sound,14).curvalue).toBe(Math.fround(Math.fround(.1234567)*10));expect(slider(sound,15).curvalue).toBe(-12.5);expect(quality(sound).curvalue).toBe(0);
    f.resources.registerShaderNoMip=register;
    for(const [text,expected] of [["1.5",15],["-2",-20],["inf",Infinity],["-inf",-Infinity]] satisfies readonly (readonly [string,number])[]){
      f.cvars.set("s_volume",text,true);await sound.show();expect(slider(sound,14).curvalue).toBe(expected);
    }
    f.cvars.set("s_compression","nan",true);await sound.show();expect(quality(sound).curvalue).toBe(0);
  }finally{f.close();}
});

for(const [id,name] of [[14,"s_volume"],[15,"s_musicvolume"]] satisfies readonly (readonly [number,string])[]){
  test(`sound ${name} source float division and libc fixed6 ties-even through actual initialized slider event`,async()=>{
    const f=await baseFixture();try{
      const {sound}=menus(f);
      const cases:readonly (readonly [string,string])[]=[
        ["0","0"],["-0","0"],["1","1"],["-1","-1"],[".5","0.500000"],[".1","0.100000"],
        [".0078125","0.007812"],[".0234375","0.023438"],["-.0078125","-0.007812"],["-.0234375","-0.023438"],
        [".0000001","0.000000"],["-.0000001","-0.000000"],[".99999994","1.000000"],
        ["1.25","1.250000"],["-1.25","-1.250000"],["2147483520","2147483392"],["-2147483648","-2147483648"],
        ["2147483648","2147483648.000000"],["-2147483904","-2147483904.000000"],
        ["4294967296","4294967296.000000"],["-4294967296","-4294967296.000000"],
      ];
      for(const [input,expected] of cases){f.cvars.set(name,input,true);await sound.show();await event(sound,id);expect(f.cvars.get(name)?.value).toBe(expected);}
      f.cvars.set(name,"1267650600228229401496703205376",true);await sound.show();await event(sound,id);
      expect(f.cvars.get(name)?.value).toBe("1267650600228229401496703205376");
      expect(f.prints).toContain("Com_sprintf: overflow of 38 in 32\n");
      for(const input of ["nan","inf","-inf"]){
        f.cvars.set(name,input,true);await sound.show();await expect(event(sound,id)).rejects.toThrow("Cvar_SetValue requires a finite float");
        expect(f.cvars.get(name)?.value).toBe(input);expect(f.state.activeMenu).toBe(sound.menu);
      }
    }finally{f.close();}
  });
  test(`sound ${name} actual key path changes fractional slider using source division`,async()=>{
    const f=await baseFixture();try{
      await cacheMenu(f.state);const {sound}=menus(f);f.cvars.set(name,".25",true);await sound.show();
      await setCursorToItem(f.state,sound.menu,item(sound,id));
      await f.keys.keyEvent(KeyCode.Right,true,10);await f.keys.keyEvent(KeyCode.Right,false,11);
      expect(slider(sound,id).curvalue).toBe(3.5);expect(f.cvars.get(name)?.value).toBe("0.350000");
      await f.keys.keyEvent(KeyCode.Left,true,12);await f.keys.keyEvent(KeyCode.Left,false,13);
      expect(f.cvars.get(name)?.value).toBe("0.250000");
      expect(f.events).toContain("sound:sound/misc/menu2.wav:6");
    }finally{f.close();}
  });
}

for(const flags of [CvarFlag.ReadOnly|CvarFlag.Archive,CvarFlag.Latch|CvarFlag.UserInfo]){
  test(`sound forced fractional writes preserve source cvar metadata ${flags}`,async()=>{
    const f=await baseFixture();try{
      const {sound}=menus(f);
      for(const name of ["s_volume","s_musicvolume"]){f.cvars.register(name,"0.25",flags);if(flags&CvarFlag.Latch)f.cvars.set(name,".75");}
      await sound.show();
      for(const [id,name] of [[14,"s_volume"],[15,"s_musicvolume"]] satisfies readonly (readonly [number,string])[]){
        await event(sound,id);const value=f.cvars.get(name);if(value===undefined)throw new Error("Missing source written cvar");
        expect(value.value).toBe("0.250000");expect(value.flags).toBe(flags);expect(value.resetValue).toBe("0.25");expect(value.latchedValue).toBeUndefined();
      }
    }finally{f.close();}
  });
}

test("sound absent writes and equal-string pending latch retain canonical Cvar_Set semantics",async()=>{
  const f=await baseFixture();try{
    const {sound}=menus(f);await sound.show();await event(sound,14);await event(sound,15);
    for(const name of ["s_volume","s_musicvolume"]){expect(f.cvars.get(name)?.flags).toBe(0);expect(f.cvars.get(name)?.resetValue).toBe("0");}
    f.cvars.register("s_volume","0",CvarFlag.Latch);f.cvars.set("s_volume",".75");const before=f.cvars.get("s_volume");
    await sound.show();await event(sound,14);expect(f.cvars.get("s_volume")).toEqual(before);
  }finally{f.close();}
});

for(const value of [0,1]){
  test(`sound quality ${value} writes in source order, clears real keys/menu, then appends without execution`,async()=>{
    const f=await baseFixture();try{
      const {sound}=menus(f),calls:string[]=[];let executions=0;
      f.consoleCommands.register("snd_restart",()=>{executions++;});f.consoleCommands.append("echo preceding\n");
      f.cvars.register("s_khz","44",CvarFlag.ReadOnly);f.cvars.register("s_compression","7",CvarFlag.Latch);f.cvars.set("s_compression","8");
      await sound.show();quality(sound).curvalue=value;f.cvars.set("cl_paused","1",true);
      const set=f.cvars.set.bind(f.cvars),clear=f.keys.clearStates.bind(f.keys),append=f.consoleCommands.append.bind(f.consoleCommands);
      f.cvars.set=(name,text,force)=>{calls.push(`set:${name}:${text}:${String(force)}`);return set(name,text,force);};
      f.keys.clearStates=async()=>{calls.push(`clear:${f.state.menuDepth}:${f.state.activeMenu===null}:${f.keys.getCatcher()}`);await clear();calls.push("cleared");};
      f.consoleCommands.append=text=>{calls.push(`append:${text}`);expect(f.cvars.get("cl_paused")?.value).toBe("0");append(text);};
      await event(sound,16);
      expect(calls).toEqual([`set:s_khz:${value?22:11}:true`,`set:s_compression:${value?0:1}:true`,"clear:0:true:0","cleared","set:cl_paused:0:true","append:snd_restart\n"]);
      expect(f.consoleCommands.pendingText).toBe("echo preceding\nsnd_restart\n");expect(executions).toBe(0);
      expect(f.cvars.get("s_khz")?.flags).toBe(CvarFlag.ReadOnly);expect(f.cvars.get("s_compression")?.latchedValue).toBeUndefined();
    }finally{f.close();}
  });
}

test("sound quality preserves writes on real command overflow after complete menu off",async()=>{
  const f=await baseFixture();try{
    const {sound}=menus(f);await sound.show();quality(sound).curvalue=0;f.consoleCommands.append("x".repeat(16380));
    const printedBefore=f.prints.length;
    await event(sound,16);
    expect(f.prints.slice(printedBefore)).toEqual(["Cbuf_AddText: overflow\n"]);
    expect(f.cvars.get("s_khz")?.value).toBe("11");expect(f.cvars.get("s_compression")?.value).toBe("1");
    expect(f.state.activeMenu).toBeNull();expect(f.state.menuDepth).toBe(0);expect(f.cvars.get("cl_paused")?.value).toBe("0");expect(f.consoleCommands.pendingText).toHaveLength(16380);
    expect(f.keys.getCatcher()).toBe(0);expect(f.events).toEqual([]);
  }finally{f.close();}
});

test("sound quality force-off failure and retirement stop append without rolling back quality writes",async()=>{
  for(const retire of [false,true]){
    const f=await baseFixture();try{
      const {sound}=menus(f);await sound.show();const clear=f.keys.clearStates.bind(f.keys),failure=new Error("key clear failure");
      f.keys.clearStates=async()=>{await clear();if(retire)f.state.retire();else throw failure;};
      if(retire)await expect(event(sound,16)).rejects.toThrow("retired");else await expect(event(sound,16)).rejects.toBe(failure);
      expect(f.cvars.get("s_khz")?.value).toBe("22");expect(f.cvars.get("s_compression")?.value).toBe("0");expect(f.consoleCommands.pendingText).toBe("");
      expect(f.state.activeMenu).toBeNull();
    }finally{f.close();}
  }
});

test("sound tabs use actual network owner and real Confirm navigation targets; ignored events are source no-ops",async()=>{
  const f=await baseFixture();try{
    const {sound,network,confirm,calls}=menus(f);await sound.show();
    for(const kind of [MenuEvent.GotFocus,MenuEvent.LostFocus])for(const id of [10,11,12,13,14,15,16,18])await event(sound,id,kind);
    await event(sound,12);expect(calls).toEqual([]);expect(f.consoleCommands.pendingText).toBe("");expect(f.cvars.get("s_volume")).toBeUndefined();
    await event(sound,13);expect(f.state.activeMenu).toBe(network.menu);expect(calls).toEqual(["network:0"]);
    await sound.show();await event(sound,10);expect(f.state.activeMenu).toBe(confirm.menu);expect(calls.at(-1)).toBe("graphics:1");
    await sound.show();await event(sound,11);expect(f.state.activeMenu).toBe(confirm.menu);expect(calls.at(-1)).toBe("display:2");
    await sound.show();await event(sound,18);expect(f.state.activeMenu).toBe(confirm.menu);
  }finally{f.close();}
});

test("sound stable reset, partial first cache failure, retained registrations and retry",async()=>{
  const f=await baseFixture();try{
    const {sound}=menus(f),register=f.resources.registerShaderNoMip.bind(f.resources),retained=new Map<string,SceneShader|null>();
    const failure=new Error("cache stopped"),calls:string[]=[];
    f.resources.registerShaderNoMip=async name=>{ if (name === null) throw new Error("Authored menu cache requires a shader name");calls.push(name);if(name===art[2])throw failure;const shader=await register(name);retained.set(name,shader);return shader;};
    await expect(sound.show()).rejects.toBe(failure);expect(calls).toEqual(art.slice(0,3));expect(sound.menu.itemCount).toBe(0);
    for(const name of art.slice(0,2)){const shader=retained.get(name);if(shader===undefined||shader===null)throw new Error("Missing actual partial registration");expect(await register(name)).toBe(shader);}
    f.resources.registerShaderNoMip=register;await sound.show();const menu=sound.menu,items=[...menu.items],commons=items.map(value=>value.common);
    slider(sound,14).range=.9;quality(sound).oldvalue=7;menu.showlogo=true;
    for(const value of items)value.common.flags=MenuFlag.Hidden;
    const gate=deferred(),entered=deferred();f.resources.registerShaderNoMip=async name=>{entered.resolve();await gate.promise;return await register(name);};
    const pending=sound.show();await entered.promise;expect(menu.itemCount).toBe(0);expect(items.every(value=>value.common.parent===null&&value.common.callback===null)).toBe(true);gate.resolve();await pending;
    for(const [index,value]of menu.items.entries()){const prior=items[index],common=commons[index];if(prior===undefined||common===undefined)throw new Error("Missing retained item");expect(value).toBe(prior);expect(value.common).toBe(common);}
    expect(slider(sound,14).range).toBe(0);expect(quality(sound).oldvalue).toBe(0);expect(menu.showlogo).toBe(false);
    const before=[...menu.items];await sound.cache();expect(menu.items).toEqual(before);expect(menu.cursor).toBe(5);
  }finally{f.close();}
});

test("sound sibling failure keeps completed pop and returned sibling retirement is checked",async()=>{
  const f=await baseFixture();try{
    const parent=new BaseConfirmMenu(f.state),failure=new Error("sibling failure");
    const sound=new BaseSoundOptionsMenu(f.state,{
      graphics:async()=>{expect(f.state.activeMenu).toBe(parent.menu);throw failure;},
      display:async()=>{f.state.retire();},network:async()=>{throw new Error("Unexpected navigation");},
    });
    await parent.show("Parent",null,null);await sound.show();await expect(event(sound,10)).rejects.toBe(failure);
    expect(f.state.menuDepth).toBe(1);expect(f.state.activeMenu).toBe(parent.menu);
    await sound.show();await expect(event(sound,11)).rejects.toThrow("retired");expect(f.state.menuDepth).toBe(1);
  }finally{f.close();}
});

test("sound late cache retirement and escaped command cannot publish",async()=>{
  for(const retire of [false,true]){
    const f=await baseFixture();try{
      const {sound}=menus(f),register=f.resources.registerShaderNoMip.bind(f.resources),gate=deferred(),entered=deferred();
      f.resources.registerShaderNoMip=async name=>{const shader=await register(name);entered.resolve();await gate.promise;return shader;};
      const holder:{promise:Promise<void>|null}={promise:null};
      if(retire)holder.promise=sound.show();else{f.consoleCommands.register("escape-sound",()=>{holder.promise=sound.show();});f.consoleCommands.executeNow("escape-sound");}
      await entered.promise;if(retire)f.state.retire();gate.resolve();if(holder.promise===null)throw new Error("Missing pending menu");
      await expect(holder.promise).rejects.toThrow(retire?"retired":"closed");expect(sound.menu.itemCount).toBe(0);expect(f.state.activeMenu).toBeNull();
    }finally{f.close();}
  }
});

test("sound real retail CPU queue has both slider geometry/UVs and changing foreground pixels",async()=>{
  const f=await baseFixture(320,240);try{
    await cacheMenu(f.state);const {sound}=menus(f);await sound.show();await refresh(f.state,75);f.commands.submit();
    const bars=f.recorder.trace().flatMap(view=>view.batches).filter(batch=>batch.texture.kind==="bind-image"&&batch.texture.image.name.includes("slider2"));
    const vertices=bars.flatMap(batch=>[...new Set(batch.indices)].sort((a,b)=>a-b).map(index=>{const vertex=batch.vertices[index];if(vertex===undefined)throw new Error("Missing actual queued vertex");return vertex;}));
    expect(vertices).toHaveLength(8);
    const expected=[[408,213],[504,213],[504,229],[408,229],[408,231],[504,231],[504,247],[408,247]];
    for(const [index,vertex]of vertices.entries()){const point=expected[index];if(point===undefined)throw new Error("Missing source slider corner");const x=point[0],y=point[1];if(x===undefined||y===undefined)throw new Error("Missing source coordinate");expect((vertex.position.x+1)*320).toBeCloseTo(x,3);expect((1-vertex.position.y)*240).toBeCloseTo(y,3);}
    expect(vertices.map(vertex=>vertex.texCoord)).toEqual(Array.from({length:2},()=>[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]).flat());
    const before=f.cpu.pixels.slice();slider(sound,14).curvalue=10;slider(sound,15).curvalue=10;
    await refresh(f.state,75);f.commands.submit();let changed=0;
    for(let y=105;y<126;y++)for(let x=204;x<253;x++)for(let channel=0;channel<3;channel++){const index=(y*320+x)*4+channel;if(f.cpu.pixels[index]!==before[index])changed++;}
    expect(changed).toBeGreaterThan(0);expect(f.state.firstDraw).toBe(false);expect(f.events).toContain("sound:sound/misc/menu1.wav:6");
  }finally{f.close();}
});
