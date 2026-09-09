import { expect,test } from "bun:test";
import { CvarFlag,CvarRegistry,CvarVmStringError } from "../src/core/cvar.ts";
import type { VmCvar } from "../src/core/cvar.ts";
function words(mirror:VmCvar):readonly [string,number,number,number]{return [mirror.value,mirror.numericValue,mirror.integerValue,mirror.modificationCount];}
test("VM cvar registration captures a source index and reads only on update",()=>{
  const registry=new CvarRegistry(),mirror=registry.registerVm("v","1.25",CvarFlag.Archive);
  expect(words(mirror)).toEqual(["1.25",1.25,1,1]);expect(registry.indexCount).toBe(1);
  registry.set("V","2.75");expect(words(mirror)).toEqual(["1.25",1.25,1,1]);mirror.update();expect(words(mirror)).toEqual(["2.75",2.75,2,2]);
  const other=registry.registerVm("V","0");expect(registry.indexCount).toBe(1);expect(words(other)).toEqual(words(mirror));
  registry.set("v","3");other.update();expect(mirror.value).toBe("2.75");expect(other.value).toBe("3");
});
test("cleared UserCreated slot never retargets a same-name replacement",()=>{
  const registry=new CvarRegistry();registry.set("server1","first");const mirror=registry.registerVm("server1","",CvarFlag.Archive);
  expect(registry.get("server1")?.flags).toBe(CvarFlag.Archive|CvarFlag.UserCreated);const before=words(mirror);
  registry.resetAll();expect(registry.get("server1")).toBeUndefined();mirror.update();expect(words(mirror)).toEqual(before);
  registry.set("server1","replacement");expect(registry.indexCount).toBe(2);mirror.update();expect(words(mirror)).toEqual(before);
  const replacement=registry.registerVm("server1","",CvarFlag.Archive);expect(replacement.value).toBe("replacement");
  registry.set("server1","next");mirror.update();replacement.update();expect(words(mirror)).toEqual(before);expect(replacement.value).toBe("next");
});
test("registration preserves existing UserCreated promotion and all protected restart slots",()=>{
  const registry=new CvarRegistry();registry.set("promoted","12");const mirror=registry.registerVm("promoted","7",CvarFlag.Archive);
  expect(registry.get("promoted")?.flags).toBe(CvarFlag.Archive);registry.resetAll();mirror.update();expect(mirror.value).toBe("7");
  for(const flag of [CvarFlag.ReadOnly,CvarFlag.Init,CvarFlag.NoRestart]){
    const name=`protected${flag}`;registry.set(name,"original");const protectedMirror=registry.registerVm(name,"",flag);
    registry.set(name,"kept",true);registry.resetAll();protectedMirror.update();expect(protectedMirror.value).toBe("kept");
  }
});
test("registration uses canonical latch application and archive bookkeeping",()=>{
  const registry=new CvarRegistry(),first=registry.registerVm("latched","1",CvarFlag.Archive|CvarFlag.Latch);
  registry.set("latched","2");first.update();expect(words(first)).toEqual(["1",1,1,2]);registry.clearModifiedFlags(CvarFlag.Archive);
  const second=registry.registerVm("latched","1",CvarFlag.Archive|CvarFlag.Latch);
  expect(words(second)).toEqual(["2",2,2,3]);expect(registry.modifiedFlags&CvarFlag.Archive).toBe(CvarFlag.Archive);
  expect(first.value).toBe("1");first.update();expect(words(first)).toEqual(words(second));
});
test("VM cvar 255-byte boundary and NUL input use actual canonical byte strings",()=>{
  const registry=new CvarRegistry(),maximum="\xff".repeat(255),mirror=registry.registerVm("byte",maximum+"\0ignored");
  expect(mirror.value).toBe(maximum);expect(mirror.value.length).toBe(255);
  expect(()=>registry.registerVm("wide","\u0100")).toThrow("byte");expect(registry.get("wide")).toBeUndefined();
  expect(()=>registry.registerVm("too-long","x".repeat(256))).toThrow(CvarVmStringError);expect(registry.get("too-long")?.value.length).toBe(256);
});
test("overflow publishes count before error and unchanged-count retry leaves prior words",()=>{
  const registry=new CvarRegistry(),mirror=registry.registerVm("value","12.5"),large="9".repeat(256);
  registry.set("value",large);let caught:unknown;
  try{mirror.update();}catch(error){caught=error;}
  expect(caught).toBeInstanceOf(CvarVmStringError);if(!(caught instanceof CvarVmStringError))throw new Error("Missing typed native VM overflow");
  expect(caught.length).toBe(256);expect(caught.message).toBe(`Cvar_Update: src ${large} length 256 exceeds MAX_CVAR_VALUE_STRING`);
  expect(words(mirror)).toEqual(["12.5",12.5,12,2]);expect(()=>mirror.update()).not.toThrow();expect(words(mirror)).toEqual(["12.5",12.5,12,2]);
  registry.set("value","-4");mirror.update();expect(words(mirror)).toEqual(["-4",-4,-4,3]);
});
