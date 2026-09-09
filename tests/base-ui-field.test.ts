import { expect,test } from "bun:test";
import { MenuField } from "../src/ui/base/field.ts";
import { KeyCode } from "../src/core/key-codes.ts";
import type { FieldControls } from "../src/core/edit-field.ts";
function fixture(){
  const field=new MenuField(),held=new Set<number>();let overstrike=false,clipboard:Uint8Array|null=null;
  const controls:FieldControls={isDown:key=>held.has(key),getOverstrike:()=>overstrike,setOverstrike:value=>{overstrike=value;},clipboard:{kind:"available",read:()=>clipboard}};
  field.widthInChars=4;return {field,held,controls,clipboard:(value:Uint8Array|null)=>{clipboard=value;}};
}
test("base menu field keeps the source inverted insert/overstrike flag and cursor cap",()=>{
  const f=fixture();f.field.setText("abcd");f.field.cursor=1;f.field.charEvent(88,f.controls);expect(f.field.text).toBe("aXcd");
  f.field.keyDown(KeyCode.Insert,f.controls);expect(f.controls.getOverstrike()).toBe(true);f.field.charEvent(89,f.controls);expect(f.field.text).toBe("aXYcd");
  f.field.clear();f.controls.setOverstrike(false);f.field.maxchars=3;
  for(const ch of "abcd")f.field.charEvent(ch.charCodeAt(0),f.controls);
  // Clear only writes buffer[0]; source maxchars prevents the third cursor advance and therefore leaves the prior tail.
  expect(f.field.cursor).toBe(2);expect(f.field.text).toBe("abdcd");
});
test("menu field home/end controls and keypad paths have their own source scrolling",()=>{
  const f=fixture();f.field.setText("abcdef");f.field.keyDown(KeyCode.KeypadEnd,f.controls);expect([f.field.cursor,f.field.scroll]).toEqual([6,3]);
  f.field.keyDown(KeyCode.KeypadLeft,f.controls);f.field.keyDown(KeyCode.KeypadDelete,f.controls);expect(f.field.text).toBe("abcde");
  f.field.keyDown(KeyCode.KeypadHome,f.controls);expect([f.field.cursor,f.field.scroll]).toEqual([0,0]);
  f.field.charEvent(5,f.controls);expect([f.field.cursor,f.field.scroll]).toEqual([5,2]);f.field.charEvent(8,f.controls);expect(f.field.text).toBe("abcd");
  f.held.add(KeyCode.Control);f.field.keyDown(97,f.controls);expect([f.field.cursor,f.field.scroll]).toEqual([0,0]);
  f.field.keyDown(101,f.controls);expect([f.field.cursor,f.field.scroll]).toEqual([4,1]);
});
test("menu clipboard uses a 64-byte local buffer and signed-byte character dispatch",()=>{
  const f=fixture();f.clipboard(new Uint8Array([65,255,128,66,0,67]));f.field.charEvent(22,f.controls);expect(f.field.text).toBe("AB");
  f.field.clear();f.clipboard(new Uint8Array(100).fill(65));f.held.add(KeyCode.Shift);f.field.keyDown(KeyCode.KeypadInsert,f.controls);expect(f.field.text).toBe("A".repeat(63));
  const absent:FieldControls={...f.controls,clipboard:{kind:"native-unix-unavailable"}};f.field.clear();f.field.charEvent(22,absent);expect(f.field.text).toBe("");
});
test("recursive paste rejects only at actual recursion and permits subsequent usable state",()=>{
  const f=fixture();f.clipboard(new Uint8Array([65,22]));expect(()=>f.field.charEvent(22,f.controls)).toThrow("Recursive menu field paste");
  expect(f.field.text).toBe("A".repeat(32));f.clipboard(new Uint8Array([66]));f.field.charEvent(22,f.controls);expect(f.field.text.endsWith("B")).toBe(true);
});
test("menu field enforces only reached native buffer boundaries and retains 255 bytes",()=>{
  const f=fixture();f.field.setText("x".repeat(255));f.field.cursor=255;f.field.charEvent(65,f.controls);expect(f.field.text).toHaveLength(255);
  f.controls.setOverstrike(true);f.field.cursor=0;f.field.charEvent(65,f.controls);expect(f.field.text.startsWith("x")).toBe(true);
  expect(()=>f.field.setText("x".repeat(256))).toThrow("source buffer");expect(f.field.text).toHaveLength(255);
  f.field.cursor=500;f.field.charEvent(3,f.controls);expect(f.field.text).toBe("");expect(f.field.cursor).toBe(0);
});
