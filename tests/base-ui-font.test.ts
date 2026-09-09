import { expect, test } from "bun:test";
import { drawUiString, drawCgString, drawProportionalString } from "../src/render/font.ts";
import { UI_PICTURE_STATE } from "../src/render/draw2d.ts";
import type { PictureAsset } from "../src/render/draw2d.ts";
import type { Vec2 } from "../src/core/math.ts";
import { RenderTarget, RenderCommandBuffer } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { BatchRecordingBackend, publishTexture } from "./render-target-fixture.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";
const white = { x: 1, y: 1, z: 1, w: 1 };
function fixture() {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(64,48,images);
  const recorder = new BatchRecordingBackend(cpu), target = new RenderTarget(images,[recorder]);
  const image = publishTexture(images,{name:"probe",width:1,height:1,pixels:new Uint8Array([255,255,255,255]),internalFormat:"rgba8",sampling:{wrap:"repeat",filter:"nearest"},registrationUnit:0});
  const picture:PictureAsset={kind:"image",name:"probe",texture:{kind:"bind-image",image},state:UI_PICTURE_STATE,color:{rgb:"vertex",alpha:"vertex"}};
  const commands = new RenderCommandBuffer(target,{print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock:{milliseconds:()=>0},identityLight:1,tess:new SourceTessState(),runtime:createRendererSettings().runtime});
  return { cpu, recorder, target, picture, commands, draw: commands.draw2D("base-ui-640") };
}
test("base UI matches all byte glyph UVs from source native and shipped QVM signed-load profile", () => {
  const f=fixture();
  try {
    for(let byte=0;byte<256;byte++) drawUiString(f.draw,f.picture,{x:19,y:27,text:String.fromCharCode(byte),style:0,time:0,color:white});
    f.commands.submit();
    const vertices=f.recorder.trace().flatMap(view=>view.batches).flatMap(batch=>batch.vertices);
    const expected: Vec2[]=[];
    for(let byte=1;byte<256;byte++) {
      if(byte===32)continue;
      // ui.qvm14646: LOAD1/SEX8 and RSHI4 at14798..14803; native byte oracle independently agrees.
      const signed=byte<128?byte:byte-256, s=(signed&15)/16,t=(signed>>4)/16;
      expected.push({x:s,y:t},{x:s+1/16,y:t},{x:s+1/16,y:t+1/16},{x:s,y:t+1/16});
    }
    expect(vertices.map(vertex=>vertex.texCoord)).toEqual(expected);
    expect(vertices).toHaveLength(254*4);
  } finally {f.target.close();}
});
test("base UI source spaces, escaped colors and NUL keep byte consumption", () => {
  const f=fixture();
  try {
    drawUiString(f.draw,f.picture,{x:0,y:0,text:" \xff^1\x80\0A",style:0,time:0,color:white});f.commands.submit();
    const vertices=f.recorder.trace().flatMap(view=>view.batches).flatMap(batch=>batch.vertices);
    expect(vertices).toHaveLength(8);
    expect(vertices[0]?.texCoord).toEqual({x:15/16,y:-1/16});
    expect(vertices[4]?.texCoord).toEqual({x:0,y:-.5});
    expect(vertices[0]?.color).toEqual(white);expect(vertices[4]?.color).toEqual({x:1,y:0,z:0,w:1});
  } finally {f.target.close();}
});
test("cgame byte glyphs and proportional mask127 retain their separate profiles", () => {
  const f=fixture();
  try {
    drawCgString(f.draw,f.picture,{x:0,y:0,text:"\xff",charWidth:16,charHeight:16,maxChars:0,color:white,forceColor:false,shadow:false});
    drawProportionalString(f.draw,{charset:f.picture,proportional:f.picture,glow:f.picture,banner:f.picture},{x:0,y:0,text:"\xc1",style:0,time:0,color:white});
    f.commands.submit();const vertices=f.recorder.trace().flatMap(view=>view.batches).flatMap(batch=>batch.vertices);
    expect(vertices).toHaveLength(8);expect(vertices[0]?.texCoord).toEqual({x:15/16,y:15/16});
    expect(vertices[4]?.texCoord).toEqual({x:5/256,y:4/256});
  } finally {f.target.close();}
});
