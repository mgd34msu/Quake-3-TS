import { expect,test } from "bun:test";
import { KeyCatcher,KeyCode,KEY_CHAR_FLAG } from "../src/core/key-codes.ts";
import { CvarFlag } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { UI_SMALLFONT } from "../src/render/font.ts";
import { BaseMenu,MenuCommon,MenuFlag,MenuEvent,COLORS } from "../src/ui/base/state.ts";
import type { BaseMenuItem,MenuAction,MenuScroll,MenuSlider,MenuBitmap } from "../src/ui/base/state.ts";
import { BASE_UI_CVARS } from "../src/ui/base/cvars.ts";
import { MenuField,fieldKey } from "../src/ui/base/field.ts";
import { cacheMenu,drawTextBox,drawNamed } from "../src/ui/base/draw.ts";
import { addItem,setCursor,pushMenu,popMenu,defaultKey,keyEvent,mouseEvent,drawMenu,refresh,isFullscreen,menuItemAtCursor,scrollKey } from "../src/ui/base/framework.ts";
import { BaseConfirmMenu } from "../src/ui/base/confirm.ts";
import { baseFixture,deferred } from "./base-ui-fixture.ts";

function action(id:number,flags=0):MenuAction {const common=new MenuCommon();common.id=id;common.name=`ITEM${id}`;common.x=100;common.y=id*30+50;common.flags=flags;return {kind:"action",common};}
function list(columns:number):MenuScroll {const common=new MenuCommon();common.x=100;common.y=100;return {kind:"scroll",common,oldvalue:0,curvalue:0,numitems:9,top:0,itemnames:["Alpha","beta","Charlie","delta","Echo","Foxtrot","golf","Hotel","India"],width:8,height:3,columns,separation:0};}

test("source menu trap_Error exits retain ERR_DROP and their exact messages",async()=>{
  const f=await baseFixture();try{
    const menu=new BaseMenu();for(let index=0;index<64;index++)addItem(f.state,menu,action(index));
    expect(()=>addItem(f.state,menu,action(64))).toThrow(new CommonError("drop","Menu_AddItem: excessive items"));
    try{addItem(f.state,menu,action(64));}catch(error){expect(error).toBeInstanceOf(CommonError);if(error instanceof CommonError)expect(error.code).toBe("drop");}
    for(let index=0;index<8;index++)await pushMenu(f.state,new BaseMenu());
    await expect(pushMenu(f.state,new BaseMenu())).rejects.toMatchObject({name:"CommonError",code:"drop",message:"UI_PushMenu: menu stack overflow"});
    f.state.menuDepth=0;
    await expect(popMenu(f.state)).rejects.toMatchObject({name:"CommonError",code:"drop",message:"UI_PopMenu: menu stack underflow"});
    expect(f.state.menuDepth).toBe(-1);
    // The source's length guard precedes its copy; ordinary 256-byte fields cannot reach it.
    class OversizedField extends MenuField {override get text():string{return "x".repeat(1024);}}
    const field=new OversizedField();field.widthInChars=1024;
    try{field.draw(f.state,0,0,0,COLORS.white);throw new Error("Expected source field error");}
    catch(error){expect(error).toBeInstanceOf(CommonError);if(error instanceof CommonError)expect([error.code,error.message]).toEqual(["drop","drawLen >= MAX_STRING_CHARS"]);}
  }finally{f.close();}
});

function indexedQueueVertices(f:Awaited<ReturnType<typeof baseFixture>>){
  return f.recorder.trace().flatMap(view=>view.batches).flatMap(batch=>[...new Set(batch.indices)].sort((a,b)=>a-b).map(index=>{
    const vertex=batch.vertices[index];if(vertex===undefined)throw new Error("Queued bitmap index has no vertex");return vertex;
  }));
}

test("bitmap pulse preserves shipped UI QVM DIVI/CVIF/SIN/MULF/ADDF words and queued bytes",async()=>{
  const f=await baseFixture();try{
    await cacheMenu(f.state);
    const menu=new BaseMenu(),bitmap:MenuBitmap={kind:"bitmap",common:new MenuCommon(),focuspic:"menu/art/play_1",errorpic:null,shader:null,focusshader:null,width:40,height:20,focuscolor:null};
    bitmap.common.name="menu/art/play_0";bitmap.common.flags=MenuFlag.PulseIfFocus;addItem(f.state,menu,bitmap);
    // Shipped ui.qvm 3a6fd12b... PCs45311..45329: DIVI75, CVIF, trap-104, MULF.5, ADDF.5.
    // cl_ui.c UI_SIN returns FloatAsInt(sin(VMF(1))). These are that binary32 profile's words,
    // not the native ui_qmenu.c double-expression oracle or a claim of VM execution.
    const cases:readonly (readonly [number,number,number])[]=[
      [3566925,1065353216,255],[3566999,1065353216,255],[3566924,1061494264,196],[3567000,1061499719,196],
      [0,1056964608,127],[74,1056964608,127],[75,1064023378,234],[76,1064023378,234],
      [-74,1056964608,127],[-75,1034048880,20],[-76,1034048880,20],[-3566925,855638016,0],
      [1258291275,1038203408,28],[-1258291275,1063504062,226],
      [2147483647,1051532533,86],[-2147483648,1059680646,168],
    ];
    const bits=new DataView(new ArrayBuffer(4));
    for(const [time,alphaWord,alphaByte] of cases){
      f.state.realtime=time;
      const start=indexedQueueVertices(f).length;
      await drawMenu(f.state,menu);f.commands.submit();
      const vertices=indexedQueueVertices(f).slice(start);
      expect(vertices).toHaveLength(8);
      expect(vertices.slice(4).map(vertex=>vertex.color.w)).toEqual([alphaByte/255,alphaByte/255,alphaByte/255,alphaByte/255]);
      bits.setFloat32(0,f.state.pulseColor.w,true);expect(bits.getUint32(0,true)).toBe(alphaWord);
    }
  }finally{f.close();}
});

test("bitmap QVM pulse preserves focused flags, custom-color ownership and nonpulse branches",async()=>{
  const f=await baseFixture();try{
    await cacheMenu(f.state);
    const menu=new BaseMenu(),focuscolor={x:.25,y:.5,z:.75,w:.125};
    const bitmap:MenuBitmap={kind:"bitmap",common:new MenuCommon(),focuspic:"menu/art/play_1",errorpic:null,shader:null,focusshader:null,width:40,height:20,focuscolor};
    bitmap.common.name="menu/art/play_0";addItem(f.state,menu,bitmap);f.state.realtime=3566925;
    const retained={x:.1,y:.2,z:.3,w:.375};f.state.pulseColor=retained;
    for(const flags of [MenuFlag.Pulse,MenuFlag.PulseIfFocus]){
      bitmap.common.flags=flags;menu.cursor=0;
      const start=indexedQueueVertices(f).length;
      await drawMenu(f.state,menu);f.commands.submit();
      const vertices=indexedQueueVertices(f).slice(start);
      expect(vertices).toHaveLength(8);
      expect(vertices.slice(4).map(vertex=>vertex.color)).toEqual(Array.from({length:4},()=>({x:63/255,y:127/255,z:191/255,w:1})));
      expect(f.state.pulseColor).toBe(retained);expect(focuscolor.w).toBe(.125);
      menu.cursor=-1;
      const before=indexedQueueVertices(f).length;
      await drawMenu(f.state,menu);f.commands.submit();
      expect(indexedQueueVertices(f).length-before).toBe(4);
      expect(f.state.pulseColor).toBe(retained);
    }
    menu.cursor=0;bitmap.common.flags=MenuFlag.Grayed|MenuFlag.Pulse;
    const start=indexedQueueVertices(f).length;
    await drawMenu(f.state,menu);f.commands.submit();
    expect(indexedQueueVertices(f).length-start).toBe(4);
    expect(f.state.pulseColor).toBe(retained);
    bitmap.common.flags=MenuFlag.Highlight;
    await drawMenu(f.state,menu);f.commands.submit();
    const highlight=indexedQueueVertices(f).slice(-4);
    expect(highlight.map(vertex=>vertex.color.w)).toEqual([31/255,31/255,31/255,31/255]);
    expect(f.state.pulseColor).toBe(retained);expect(focuscolor.w).toBe(.125);
  }finally{f.close();}
});

test("base UI registers the actual ordered 47-entry source table and keeps refresh snapshots",async()=>{
  const f=await baseFixture();try{
    expect(BASE_UI_CVARS).toHaveLength(47);
    expect(BASE_UI_CVARS.slice(30,46).map(row=>row[0])).toEqual(Array.from({length:16},(_,i)=>`server${i+1}`));
    expect(BASE_UI_CVARS.at(-1)).toEqual(["ui_cdkeychecked","0",CvarFlag.ReadOnly]);
    expect(f.cvars.get("g_spSkill")?.flags).toBe(CvarFlag.Archive|CvarFlag.Latch);
    f.cvars.set("cg_marks","0");expect(f.state.services.cvars.get("cg_marks").integerValue).toBe(1);
    await refresh(f.state,10);expect(f.state.services.cvars.get("cg_marks").integerValue).toBe(1);
    f.keys.setCatcher(KeyCatcher.Ui);await refresh(f.state,20);expect(f.state.services.cvars.get("cg_marks").integerValue).toBe(0);
    expect(f.state.frameTime).toBe(10);expect(f.state.realtime).toBe(20);
  }finally{f.close();}
});
test("all ten discriminated items reproduce native Menu_AddItem initialization and bounds",async()=>{
  const f=await baseFixture();try{
    const menu=new BaseMenu(),common=()=>new MenuCommon(),field=new MenuField();field.widthInChars=5;
    const items:BaseMenuItem[]=[
      {kind:"slider",common:common(),minvalue:0,maxvalue:10,curvalue:5,range:0},action(0),
      {kind:"spin",common:common(),oldvalue:0,curvalue:0,numitems:0,top:0,itemnames:["ONE","LONGER"],width:0,height:0,columns:0,separation:0},
      {kind:"field",common:common(),field},{kind:"radio",common:common(),curvalue:0},
      {kind:"bitmap",common:common(),focuspic:null,errorpic:null,shader:null,focusshader:null,width:-40,height:-20,focuscolor:null},
      {kind:"text",common:common(),text:"TEXT",style:0,color:COLORS.white},
      {...list(2),width:7,numitems:2,itemnames:["ONE","LONGER"]},
      {kind:"proportional",common:common(),text:"HELLO",style:UI_SMALLFONT,color:COLORS.white},
      {kind:"banner",common:common(),text:"BANNER",style:0,color:COLORS.white}];
    const rows:number[][]=[];
    for(const [index,item] of items.entries()){
      Object.assign(item.common,{x:200,y:20+index*20,id:index,name:"LABEL",flags:MenuFlag.HasMouseFocus|MenuFlag.CenterJustify});
      addItem(f.state,menu,item);const c=item.common;rows.push([index+1,c.menuPosition,c.flags,c.left,c.top,c.right,c.bottom,c.id]);
      expect(c.parent).toBe(menu);
    }
    // Original unchanged ui_qmenu.c, native/menu-oracle mode0.
    expect(rows).toEqual([[1,0,8,152,20,304,36,0],[2,1,8,200,40,280,56,1],[3,2,8,152,60,256,76,2],
      [4,3,8,104,80,296,96,3],[5,4,8,152,100,248,116,4],[6,5,8,180,120,220,140,5],
      [7,6,16392,0,0,0,0,6],[8,7,8,132,160,268,208,7],[9,8,8,166,180,234,200,8],[10,9,16392,0,0,0,0,9]]);
    expect(menu.itemCount).toBe(10);menu.cursor=10;expect(menuItemAtCursor(menu)).toBeNull();
    const bad={kind:"proportional",common:common(),text:null,style:0,color:COLORS.white} satisfies BaseMenuItem;
    expect(()=>addItem(f.state,menu,bad)).toThrow("proportional string pointer");expect(menu.itemCount).toBe(10);expect(menu.items[10]).toBe(bad);expect(bad.common.parent).toBe(menu);
  }finally{f.close();}
});
test("stack identity, hidden focus and source callbacks survive real key dispatch",async()=>{
  const f=await baseFixture();try{
    await cacheMenu(f.state);const menu=new BaseMenu();menu.wrapAround=true;menu.fullscreen=true;
    const first=action(0),hidden=action(1,MenuFlag.Hidden),mouse=action(2,MenuFlag.MouseOnly),last=action(3);
    const calls:string[]=[];for(const item of [first,hidden,mouse,last]){item.common.callback=async(item,event)=>{calls.push(`${item.common.id}:${event}`);};addItem(f.state,menu,item);}
    await pushMenu(f.state,menu);expect(calls).toEqual([]);expect(isFullscreen(f.state)).toBe(true);
    await f.keys.keyEvent(KeyCode.Down,true,10);expect(menu.cursor).toBe(1);expect(calls).toEqual(["0:2","1:1"]);
    await f.keys.keyEvent(KeyCode.Down,true,20);expect(menu.cursor).toBe(3);
    await f.keys.keyEvent(KeyCode.Down,true,30);expect(menu.cursor).toBe(0);
    await f.keys.keyEvent(KeyCode.Enter,true,40);expect(calls.at(-1)).toBe("0:3");
    const other=new BaseMenu();await pushMenu(f.state,other);await pushMenu(f.state,menu);expect(f.state.menuDepth).toBe(1);expect(f.state.stack[0]).toBe(menu);
    f.events.length=0;await f.keys.keyEvent(KeyCode.Escape,true,50);expect(f.state.activeMenu).toBeNull();expect(f.keys.getCatcher()).toBe(0);
    expect(f.events).toEqual(["sound:sound/misc/menu3.wav:6","sound:sound/misc/menu3.wav:6"]);
    expect(f.cvars.get("cl_paused")?.value).toBe("0");expect(f.keys.isDown(KeyCode.Escape)).toBe(false);
    await expect(popMenu(f.state)).rejects.toThrow("underflow");expect(f.state.menuDepth).toBe(-1);
  }finally{f.close();}
});
test("focus callback reads the live cursor after the lost-focus callback",async()=>{
  const f=await baseFixture();try{
    const menu=new BaseMenu(),items=[action(0),action(1),action(2)],calls:string[]=[];
    for(const item of items){item.common.callback=async(item,event)=>{calls.push(`${item.common.id}:${event}`);if(item.common.id===0&&event===MenuEvent.LostFocus)menu.cursor=2;};addItem(f.state,menu,item);}
    await setCursor(f.state,menu,1);expect(menu.cursor).toBe(2);expect(calls).toEqual(["0:2","2:1"]);
  }finally{f.close();}
});
test("manual field wrapper preserves source alpha-only numeric filtering and Enter-to-Tab",async()=>{
  const f=await baseFixture();try{
    await cacheMenu(f.state);const menu=new BaseMenu(),field=new MenuField();field.widthInChars=4;field.maxchars=5;
    const item={kind:"field",common:new MenuCommon(),field} satisfies BaseMenuItem;item.common.flags=MenuFlag.NumbersOnly;addItem(f.state,menu,item);addItem(f.state,menu,action(1));await pushMenu(f.state,menu);
    expect(fieldKey(f.state,item,KEY_CHAR_FLAG|65).sound.kind).toBe("sound");expect(field.text).toBe("");
    fieldKey(f.state,item,KEY_CHAR_FLAG|45);fieldKey(f.state,item,KEY_CHAR_FLAG|49);expect(field.text).toBe("-1");
    item.common.flags|=MenuFlag.Uppercase;fieldKey(f.state,item,KEY_CHAR_FLAG|97);expect(field.text).toBe("-1A");
    await defaultKey(f.state,menu,KeyCode.Enter);expect(menu.cursor).toBe(1);
  }finally{f.close();}
});
test("source cache is ordered and genuine Confirm/Message draw through CPU and PCM owners",async()=>{
  const f=await baseFixture();try{
    f.registrations.length=0;await cacheMenu(f.state);
    expect(f.registrations).toEqual(["shader:gfx/2d/bigchars","shader:menu/art/font1_prop.tga","shader:menu/art/font1_prop_glo.tga","shader:menu/art/font2_prop.tga",
      "shader:menu/art/3_cursor2","shader:menu/art/switch_on","shader:menu/art/switch_off","shader:white","shader:menuback","shader:menubacknologo",
      "sound:sound/misc/menu1.wav:false","sound:sound/misc/menu2.wav:false","sound:sound/misc/menu3.wav:false","sound:sound/misc/menu4.wav:false","sound:sound/weapons/change.wav:false",
      "shader:menu/art/slider2","shader:menu/art/sliderbutt_0","shader:menu/art/sliderbutt_1"]);
    const confirm=new BaseConfirmMenu(f.state),results:string[]=[];
    await confirm.show("READY?",null,async result=>{results.push(`${result}:${f.state.menuDepth}:${f.keys.getCatcher()}`);});
    expect(confirm.menu.cursor).toBe(1);expect(confirm.menu.fullscreen).toBe(true);const identity=confirm.menu;
    await refresh(f.state,1000);expect(f.events).toEqual(["sound:sound/misc/menu1.wav:6"]);f.commands.submit();
    expect(f.recorder.trace().flatMap(view=>view.batches)).toHaveLength(5);expect(f.cpu.pixels.some(value=>value!==0)).toBe(true);
    expect(f.mixer.mix(512).some(value=>value!==0)).toBe(true);
    await f.keys.keyEvent(110,true,2);expect(results).toEqual(["false:0:0"]);
    f.phase("connected");await confirm.message(["FIRST","SECOND"]);expect(confirm.menu).toBe(identity);expect(confirm.menu.itemCount).toBe(1);expect(confirm.menu.fullscreen).toBe(false);
    f.events.length=0;await f.keys.keyEvent(KeyCode.Enter,true,3);expect(f.state.activeMenu).toBeNull();
    expect(f.events).toEqual(["sound:sound/misc/menu3.wav:6","sound:sound/misc/menu2.wav:6"]);
    await confirm.show("AGAIN",null,null);await confirm.show("REPLACED",null,null);expect(f.state.menuDepth).toBe(1);
    drawTextBox(f.state,10,10,8,3);f.commands.submit();
  }finally{f.close();}
});
test("real awaited asset failure and escaped completion cannot publish into a closed UI operation",async()=>{
  const f=await baseFixture();try{
    const gate=deferred(),entered=deferred();f.assets.beforeRead=async path=>{if(path.includes("cut_frame")){entered.resolve();await gate.promise;}};
    const confirm=new BaseConfirmMenu(f.state);let escaped:Promise<void>|undefined;
    f.consoleCommands.register("escape-ui",()=>{escaped=confirm.show("STALE",null,null);});
    f.consoleCommands.executeNow("escape-ui");await entered.promise;gate.resolve();
    if(escaped===undefined)throw new Error("Missing actual escaped UI operation");await expect(escaped).rejects.toThrow("closed command");
    expect(f.state.menuDepth).toBe(0);expect(f.state.activeMenu).toBeNull();
    f.assets.beforeRead=null;await confirm.message(["RECOVERED"]);expect(f.state.activeMenu).toBe(confirm.menu);
    const gate2=deferred(),entered2=deferred();f.assets.beforeRead=async path=>{if(path.includes("play_0")){entered2.resolve();await gate2.promise;throw new Error("owned image read failed");}};
    f.consoleCommands.registerAsync("read-failure",async()=>{await drawNamed(f.state,1,1,10,10,"menu/art/play_0");});
    const pending=f.consoleCommands.executeNowAsync("read-failure");await entered2.promise;
    await expect(pushMenu(f.state,new BaseMenu())).rejects.toThrow("overlapping command");expect(f.state.activeMenu).toBe(confirm.menu);
    gate2.resolve();await expect(pending).rejects.toThrow("owned image read failed");expect(f.state.activeMenu).toBe(confirm.menu);
  }finally{f.close();}
});
test("shipped QVM debug keys retain widget-first dispatch and actual screenshot queue order",async()=>{
  const f=await baseFixture();try{
    await cacheMenu(f.state);const menu=new BaseMenu();addItem(f.state,menu,action(0));await pushMenu(f.state,menu);
    f.consoleCommands.append("echo before\n");await f.keys.keyEvent(KeyCode.F11,true,1);expect(f.state.debug).toBe(true);
    await f.keys.keyEvent(KeyCode.F12,true,2);expect(f.consoleCommands.pendingText).toBe("echo before\nscreenshot\n");
    await refresh(f.state,1000);f.commands.submit();expect(f.recorder.trace().flatMap(view=>view.batches).some(batch=>batch.vertices.some(vertex=>vertex.color.x===1&&vertex.color.y===0&&vertex.color.z===0))).toBe(true);
    await keyEvent(f.state,KeyCode.F11,false);expect(f.state.debug).toBe(true);await f.keys.keyEvent(KeyCode.F11,true,3);expect(f.state.debug).toBe(false);
    const empty=new BaseMenu();await defaultKey(f.state,empty,KeyCode.F11);expect(f.state.debug).toBe(false);
    const scroll=list(1);addItem(f.state,empty,scroll);await pushMenu(f.state,empty);await defaultKey(f.state,empty,KeyCode.F11);expect(f.state.debug).toBe(true);
  }finally{f.close();}
});
test("source mouse focus uses inclusive rectangles and rereads replacement active menus",async()=>{
  const f=await baseFixture();try{
    await cacheMenu(f.state);const menu=new BaseMenu(),first=action(0),second=action(1),replacement=new BaseMenu(),a=action(0),b=action(1);
    for(const item of [first,second])addItem(f.state,menu,item);for(const item of [a,b])addItem(f.state,replacement,item);
    first.common.callback=async(_item,event)=>{if(event===MenuEvent.LostFocus){f.state.activeMenu=replacement;replacement.cursor=1;replacement.cursorPrev=0;}};
    await pushMenu(f.state,menu);await mouseEvent(f.state,second.common.right,second.common.bottom);
    expect(f.state.activeMenu).toBe(replacement);expect(b.common.flags&MenuFlag.HasMouseFocus).toBe(MenuFlag.HasMouseFocus);expect(second.common.flags&MenuFlag.HasMouseFocus).toBe(0);
    expect(f.events.at(-1)).toBe("sound:sound/misc/menu2.wav:6");await mouseEvent(f.state,640,480);expect(b.common.flags&MenuFlag.HasMouseFocus).toBe(0);
  }finally{f.close();}
});
test("slider/radio callbacks include source buzz and source fractional old-value comparison",async()=>{
  const f=await baseFixture();try{
    await cacheMenu(f.state);const menu=new BaseMenu(),slider:MenuSlider={kind:"slider",common:new MenuCommon(),minvalue:0,maxvalue:10,curvalue:0,range:0};slider.common.x=100;
    const calls:number[]=[];slider.common.callback=async(_item,event)=>{calls.push(event);};addItem(f.state,menu,slider);
    await defaultKey(f.state,menu,KeyCode.Left);expect(calls).toEqual([MenuEvent.Activated]);
    slider.curvalue=.5;f.state.cursorX=120;await defaultKey(f.state,menu,KeyCode.Mouse1);expect(slider.curvalue).toBe(.5);expect(calls).toHaveLength(2);
    const radio={kind:"radio",common:new MenuCommon(),curvalue:4} satisfies BaseMenuItem;radio.common.callback=async(_item,event)=>{calls.push(event);};addItem(f.state,menu,radio);await setCursor(f.state,menu,1);
    const before=calls.length;await defaultKey(f.state,menu,KeyCode.Mouse1);expect(radio.curvalue).toBe(4);expect(calls).toHaveLength(before);
    await defaultKey(f.state,menu,KeyCode.Enter);expect(radio.curvalue).toBe(0);expect(calls.at(-1)).toBe(MenuEvent.Activated);
  }finally{f.close();}
});
test("scroll list retains empty End, multi-column consumption and mouse boundary selection",async()=>{
  const f=await baseFixture();try{
    const menu=new BaseMenu(),scroll=list(2);addItem(f.state,menu,scroll);expect((await scrollKey(f.state,scroll,KeyCode.PageDown)).kind).toBe("none");
    await cacheMenu(f.state);
    expect((await scrollKey(f.state,scroll,KeyCode.PageDown)).kind).toBe("consumed");scroll.common.flags|=MenuFlag.HasMouseFocus;
    f.state.cursorX=100+11*8;f.state.cursorY=100+2*16;expect((await scrollKey(f.state,scroll,KeyCode.Mouse1)).kind).toBe("consumed");expect(scroll.curvalue).toBe(5);
    scroll.numitems=0;await scrollKey(f.state,scroll,KeyCode.End);expect(scroll.curvalue).toBe(-1);expect(scroll.top).toBe(0);
    scroll.height=0;await expect(scrollKey(f.state,scroll,KeyCode.End)).rejects.toThrow("Undefined native");
  }finally{f.close();}
});
test("bitmap missing handles retry real registration and use the actual fallback image",async()=>{
  const f=await baseFixture();try{
    await cacheMenu(f.state);const menu=new BaseMenu(),bitmap:MenuBitmap={kind:"bitmap",common:new MenuCommon(),focuspic:null,errorpic:"menu/art/play_0",shader:null,focusshader:null,width:40,height:20,focuscolor:null};
    bitmap.common.name="menu/art/not-a-retail-image";addItem(f.state,menu,bitmap);await drawMenu(f.state,menu);expect(bitmap.shader).not.toBeNull();
    expect(f.registrations.slice(-2)).toEqual(["shader:menu/art/not-a-retail-image","shader:menu/art/play_0"]);f.commands.submit();
    bitmap.errorpic=null;bitmap.shader=null;f.registrations.length=0;await drawMenu(f.state,menu);await drawMenu(f.state,menu);
    expect(bitmap.shader).toBeNull();expect(f.registrations).toEqual(["shader:menu/art/not-a-retail-image","shader:menu/art/not-a-retail-image"]);
  }finally{f.close();}
});
test("cvar refresh stops in source table order and resumes after overflow count publication",async()=>{
  const f=await baseFixture();try{
    f.keys.setCatcher(KeyCatcher.Ui);f.cvars.set("ui_ffa_fraglimit","12");f.cvars.set("ui_ffa_timelimit","9".repeat(256));f.cvars.set("ui_tourney_fraglimit","33");
    await expect(refresh(f.state,20)).rejects.toThrow("MAX_CVAR_VALUE_STRING");
    expect(f.state.services.cvars.get("ui_ffa_fraglimit").value).toBe("12");expect(f.state.services.cvars.get("ui_ffa_timelimit").value).toBe("0");
    expect(f.state.services.cvars.get("ui_tourney_fraglimit").value).toBe("0");
    await refresh(f.state,40);expect(f.state.services.cvars.get("ui_tourney_fraglimit").value).toBe("33");
  }finally{f.close();}
});
test("source stack/item limits preserve already accepted identities and partial callback state",async()=>{
  const f=await baseFixture();try{
    const menus=Array.from({length:8},()=>new BaseMenu());for(const menu of menus)await pushMenu(f.state,menu);
    const active=f.state.activeMenu;await expect(pushMenu(f.state,new BaseMenu())).rejects.toThrow("overflow");expect(f.state.menuDepth).toBe(8);expect(f.state.activeMenu).toBe(active);
    const menu=new BaseMenu();for(let i=0;i<64;i++)addItem(f.state,menu,action(i));
    const extra=action(64);expect(()=>addItem(f.state,menu,extra)).toThrow("excessive items");expect(extra.common.parent).toBeNull();expect(menu.itemCount).toBe(64);
    const first=menu.items[0];if(first===undefined)throw new Error("Missing first source item");first.common.callback=async()=>{throw new Error("focus callback failed");};
    await expect(setCursor(f.state,menu,1)).rejects.toThrow("focus callback failed");expect([menu.cursorPrev,menu.cursor]).toEqual([0,1]);
    first.common.callback=null;await setCursor(f.state,menu,2);expect(menu.cursor).toBe(2);
  }finally{f.close();}
});
test("delayed enter sound and first-draw mouse wait for successful actual asset drawing",async()=>{
  const f=await baseFixture();try{
    await cacheMenu(f.state);const menu=new BaseMenu(),bitmap:MenuBitmap={kind:"bitmap",common:new MenuCommon(),focuspic:null,errorpic:null,shader:null,focusshader:null,width:40,height:20,focuscolor:null};
    bitmap.common.name="menu/art/back_0";addItem(f.state,menu,bitmap);await pushMenu(f.state,menu);
    f.assets.beforeRead=async path=>{if(path.includes("back_0"))throw new Error("refresh image failure");};
    await expect(refresh(f.state,100)).rejects.toThrow("refresh image failure");expect(f.state.enterSound).toBe(true);expect(f.state.firstDraw).toBe(true);expect(f.events).toEqual([]);expect(bitmap.shader).toBeNull();
    f.assets.beforeRead=null;bitmap.common.name="menu/art/back_1";await refresh(f.state,200);expect(f.state.enterSound).toBe(false);expect(f.state.firstDraw).toBe(false);expect(f.events).toEqual(["sound:sound/misc/menu1.wav:6"]);
  }finally{f.close();}
});
test("retired product UI cannot publish a late bitmap into its retained record",async()=>{
  const f=await baseFixture();try{
    const menu=new BaseMenu(),bitmap:MenuBitmap={kind:"bitmap",common:new MenuCommon(),focuspic:null,errorpic:null,shader:null,focusshader:null,width:40,height:20,focuscolor:null};
    bitmap.common.name="menu/art/next_0";addItem(f.state,menu,bitmap);const entered=deferred(),gate=deferred();
    f.assets.beforeRead=async path=>{if(path.includes("next_0")){entered.resolve();await gate.promise;}};
    f.consoleCommands.registerAsync("retire-draw",async()=>{
      const pending=drawMenu(f.state,menu);await entered.promise;f.state.retire();gate.resolve();await expect(pending).rejects.toThrow("retired");
    });
    await f.consoleCommands.executeNowAsync("retire-draw");expect(bitmap.shader).toBeNull();expect(()=>f.state.retire()).toThrow("retired");
  }finally{f.close();}
});
test("shipped QVM int32 mouse additions wrap before clamping and absent menus ignore inputs",async()=>{
  const f=await baseFixture();try{
    await mouseEvent(f.state,Infinity,NaN);expect([f.state.cursorX,f.state.cursorY]).toEqual([0,0]);
    await pushMenu(f.state,new BaseMenu());f.state.cursorX=10;f.state.cursorY=20;
    await mouseEvent(f.state,2147483647,2147483647);expect([f.state.cursorX,f.state.cursorY]).toEqual([0,0]);
    await mouseEvent(f.state,2147483647,2147483647);expect([f.state.cursorX,f.state.cursorY]).toEqual([640,480]);
    await mouseEvent(f.state,-2147483648,-2147483648);expect([f.state.cursorX,f.state.cursorY]).toEqual([0,0]);
    await expect(mouseEvent(f.state,Infinity,0)).rejects.toThrow("Undefined native");
  }finally{f.close();}
});
test("shipped QVM realtime subtraction wraps and publishes before the catcher early return",async()=>{
  const f=await baseFixture();try{
    f.state.realtime=2147483640;await refresh(f.state,-2147483640);expect([f.state.frameTime,f.state.realtime]).toEqual([16,-2147483640]);
    f.state.realtime=-2147483640;await refresh(f.state,2147483640);expect([f.state.frameTime,f.state.realtime]).toEqual([-16,2147483640]);
    expect(f.recorder.trace()).toEqual([]);expect(f.keys.getCatcher()).toBe(0);
  }finally{f.close();}
});
