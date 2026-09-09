// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { vec4 } from "../src/core/math.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { RendererImageCatalog, RgbaSnapshot } from "../src/render/image-resource.ts";
import type { RendererImage } from "../src/render/image-resource.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { SourceTessState } from "../src/render/tess-state.ts";
import { OPAQUE_STATE } from "../src/render/types.ts";
import type { DrawBatch, MultitextureBatch, SingleTextureBatch, TextureBinding, TextureEnvironment, TextureSampling } from "../src/render/types.ts";
import { executeStaticBatch, publishTexture } from "./render-target-fixture.ts";
import { createRendererSettings } from "./renderer-settings-fixture.ts";

const retain: TextureBinding = { kind: "retain-current-texture" }, black = vec4(0,0,0,0);
const nearest: TextureSampling = { wrap:"repeat",filter:"nearest" };
function image(images: RendererImageCatalog, rgba: readonly number[], unit: 0|1 = 1, sampling = nearest, width = 1): RendererImage {
  return publishTexture(images,{name:"retain-fixture",width,height:1,pixels:new Uint8Array(rgba),internalFormat:"rgba8",sampling,registrationUnit:unit});
}
function bind(image: RendererImage): TextureBinding { return {kind:"bind-image",image}; }
function quad(texture: TextureBinding, color = vec4(1,1,1,1)): SingleTextureBatch {
  return {texturing:"single",primitive:"triangles",texture,state:{...OPAQUE_STATE,cull:"none"},indices:[0,1,2,0,2,3],
    vertices:[vec4(-1,1,0,1),vec4(1,1,0,1),vec4(1,-1,0,1),vec4(-1,-1,0,1)].map(position=>({position,color,texCoord:{x:.5,y:.5}}))};
}
function pair(first: TextureBinding, second: TextureBinding, environment: TextureEnvironment = "replace"): MultitextureBatch {
  const base = quad(first);
  return {...base,texturing:"pair",secondTexture:{binding:second,environment},vertices:base.vertices.map(vertex=>({...vertex,texCoord2:{x:.5,y:.5}}))};
}
function pixel(pixels: Uint8Array): number[] { return [...pixels.subarray((4*8+4)*4,(4*8+5)*4)]; }
function fixture() {
  const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(8,8,images), target = new RenderTarget(images,[cpu]);
  return {images,cpu,target};
}
function commandsFor(target: RenderTarget): RenderCommandBuffer {
  return new RenderCommandBuffer(target,{print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock:{milliseconds:()=>0},identityLight:1,tess:new SourceTessState(),runtime:createRendererSettings().runtime});
}
function clear(cpu: SoftwareRenderer): void { cpu.beginView({viewport:{x:0,y:0,width:8,height:8},clear:{ stencil: false,color:black,depth:1}}); }

test("retain survives clears and views, distinct from binding a registered white image", () => {
  const {images,cpu,target} = fixture(), red = bind(image(images,[255,0,0,255])), white = bind(image(images,[255,255,255,255]));
  executeStaticBatch(cpu,quad(red)); clear(cpu); executeStaticBatch(cpu,quad(retain)); expect(pixel(cpu.pixels)).toEqual([255,0,0,255]);
  const commands = commandsFor(target);
  commands.addView({viewport:{x:0,y:0,width:8,height:8},clear:{ stencil: false,color:black,depth:1},operations: [{ kind: "draw", batches: [quad(retain)] }]}); commands.submit();
  expect(pixel(cpu.pixels)).toEqual([255,0,0,255]);
  executeStaticBatch(cpu,quad(white)); clear(cpu); executeStaticBatch(cpu,quad(retain)); expect(pixel(cpu.pixels)).toEqual([255,255,255,255]);
  executeStaticBatch(cpu,quad(bind(image(images,[0,255,0,255])))); executeStaticBatch(cpu,quad(retain));
  expect(pixel(cpu.pixels)).toEqual([0,255,0,255]); target.close();
});

test("initial incomplete object zero skips MODULATE, ADD and REPLACE entirely", () => {
  const {images,cpu,target} = fixture();
  executeStaticBatch(cpu,quad(retain,vec4(.25,.5,.75,.5))); expect(pixel(cpu.pixels)).toEqual([64,128,191,128]);
  const first = bind(image(images,[32,64,96,128]));
  for (const environment of ["modulate","add","replace"] satisfies readonly TextureEnvironment[]) {
    executeStaticBatch(cpu,pair(first,retain,environment)); expect(pixel(cpu.pixels)).toEqual([32,64,96,128]);
  }
  target.close();
});

test("unit one survives single-unit draws and uses later environments without rebinding", () => {
  const {images,cpu,target} = fixture(), white = bind(image(images,[255,255,255,255],1)), secondary = bind(image(images,[16,32,64,128],0));
  const primary = bind(image(images,[128,64,32,255],0));
  executeStaticBatch(cpu,pair(white,secondary));
  executeStaticBatch(cpu,quad(primary)); clear(cpu);
  executeStaticBatch(cpu,pair(retain,retain,"add")); expect(pixel(cpu.pixels)).toEqual([144,96,96,128]);
  executeStaticBatch(cpu,pair(retain,retain,"replace")); expect(pixel(cpu.pixels)).toEqual([16,32,64,128]);
  executeStaticBatch(cpu,pair(retain,white)); executeStaticBatch(cpu,pair(retain,retain)); expect(pixel(cpu.pixels)).toEqual([255,255,255,255]); target.close();
});

test("ordinary binds never inspect mutated source pixels; border changes are ordered actual-object operations", () => {
  const {images,cpu,target} = fixture(), pixels = new Uint8Array([255,0,0,255,0,255,0,255]);
  const colors = publishTexture(images,{name:"colors",width:2,height:1,pixels,internalFormat:"rgba8",sampling:{wrap:"clamp",filter:"linear"},registrationUnit:1});
  const outside = (texture: TextureBinding): SingleTextureBatch => {const base=quad(texture);return {...base,vertices:base.vertices.map(vertex=>({...vertex,texCoord:{x:1,y:.5}}))};};
  executeStaticBatch(cpu,quad(bind(colors))); images.setCurrentBorderColor(vec4(0,0,1,1));
  executeStaticBatch(cpu,outside(retain)); expect(pixel(cpu.pixels)).toEqual([0,128,128,255]);
  pixels.set([255,255,0,255],4);
  executeStaticBatch(cpu,outside(bind(colors))); expect(pixel(cpu.pixels)).toEqual([0,128,128,255]);
  images.setCurrentBorderColor(vec4(1,0,0,1)); executeStaticBatch(cpu,outside(retain)); expect(pixel(cpu.pixels)).toEqual([128,128,0,255]);
  target.close();
});

test("explicit cinematic subimage changes one texture object shared by both units", () => {
  const {images,cpu,target} = fixture(), shared = image(images,[64,0,0,255],1), other = image(images,[1,1,1,255],0);
  executeStaticBatch(cpu,pair(bind(shared),bind(other),"add"));
  executeStaticBatch(cpu,pair(retain,bind(shared),"add")); expect(pixel(cpu.pixels)).toEqual([128,0,0,255]);
  const commands = commandsFor(target), base = pair(retain,retain,"add");
  const movie: TextureBinding = {kind:"shader-cinematic",source:{image:shared,prepareAtExecution(){return {upload:{image:shared,sourceWidth:1,sourceHeight:1,uploadWidth:1,uploadHeight:1,dirty:true,
    content:new RgbaSnapshot(1,1,new Uint8Array([0,128,0,255]))},afterShaderUpload:()=>undefined};}}};
  commands.addView({viewport:{x:0,y:0,width:8,height:8},clear:{ stencil: false,color:black,depth:1},operations: [{ kind: "draw", batches: [{...base,secondTexture:{binding:movie,environment:"add"}}] }]}); commands.submit();
  expect(pixel(cpu.pixels)).toEqual([0,255,0,255]); target.close();
});

test("empty and statically rejected batches leave established bindings unchanged", () => {
  const {images,cpu,target} = fixture(), red = bind(image(images,[255,0,0,255])), white = bind(image(images,[255,255,255,255]));
  executeStaticBatch(cpu,quad(red)); executeStaticBatch(cpu,{...quad(white),indices:[]});
  expect(()=>executeStaticBatch(cpu,{...quad(white),indices:[99,1,2]})).toThrow("index");
  executeStaticBatch(cpu,quad(retain)); expect(pixel(cpu.pixels)).toEqual([255,0,0,255]); target.close();
});

test("registration raw-unbind preserves cached identities independently on both units", () => {
  const {images,cpu,target} = fixture(), red = image(images,[255,0,0,255],1);
  executeStaticBatch(cpu,quad(bind(red))); const green=image(images,[0,255,0,255],0);
  executeStaticBatch(cpu,quad(retain)); expect(pixel(cpu.pixels)).toEqual([255,255,255,255]);
  executeStaticBatch(cpu,quad(bind(green))); expect(pixel(cpu.pixels)).toEqual([255,255,255,255]);
  executeStaticBatch(cpu,quad(bind(red))); executeStaticBatch(cpu,quad(bind(green))); expect(pixel(cpu.pixels)).toEqual([0,255,0,255]);
  const blue=image(images,[0,0,255,255],1);
  executeStaticBatch(cpu,pair(retain,bind(blue))); expect(pixel(cpu.pixels)).toEqual([0,255,0,255]);
  executeStaticBatch(cpu,pair(retain,bind(green))); executeStaticBatch(cpu,pair(retain,bind(blue))); expect(pixel(cpu.pixels)).toEqual([0,0,255,255]); target.close();
});

test.skipIf(process.env["QUAKE_GL_TEST"]!=="1")("actual mirrored GL/CPU retains registered images and the source raw-zero divergence",()=>{
  const window=SdlWindow.open({title:"Retained source image objects",width:8,height:8,backend:"gl",hidden:true});
  const images=new RendererImageCatalog(),gl=new GlRenderer(window,images),cpu=new SoftwareRenderer(8,8,images,gl.subpixelBits),target=new RenderTarget(images,[cpu,gl]),commands=commandsFor(target);
  gl.initializeDefaultState(gl.capabilities.textureUnits > 1, () => { images.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const compare=(batch:DrawBatch,expected:readonly number[]):void=>{
    commands.addView({viewport:{x:0,y:0,width:8,height:8},clear:{ stencil: false,color:black,depth:1},operations: [{ kind: "draw", batches: [batch] }]});commands.submit();
    expect(pixel(cpu.pixels)).toEqual([...expected]);expect(pixel(gl.readPixels())).toEqual([...expected]);
  };
  try{
    const red=image(images,[255,0,0,255],1);compare(quad(bind(red)),[255,0,0,255]);
    const green=image(images,[0,255,0,255],0);compare(quad(retain),[255,255,255,255]);compare(quad(bind(green)),[255,255,255,255]);
    compare(quad(bind(red)),[255,0,0,255]);compare(quad(bind(green)),[0,255,0,255]);
    const blue=image(images,[0,0,255,255],1);compare(pair(retain,bind(blue)),[0,255,0,255]);
    compare(quad(bind(red)),[255,0,0,255]);compare(pair(retain,retain),[255,0,0,255]);
    compare(pair(retain,bind(green)),[0,255,0,255]);compare(pair(retain,bind(blue)),[0,0,255,255]);
    compare({...quad(bind(green)),indices:[]},[0,0,0,0]);compare(pair(retain,retain),[0,0,255,255]);
    const line:MultitextureBatch={...pair(retain,retain),primitive:"lines",lineWidth:3,indices:[0,1],vertices:[
      {position:vec4(-.7,.1,0,1),color:vec4(1,1,1,1),texCoord:{x:.5,y:.5},texCoord2:{x:.5,y:.5}},
      {position:vec4(.7,.1,0,1),color:vec4(1,1,1,1),texCoord:{x:.5,y:.5},texCoord2:{x:.5,y:.5}}]};
    compare(line,[0,0,255,255]);
  }finally{target.close();window.close();}
});

test.skipIf(process.env["QUAKE_GL_TEST"]!=="1")("alternating native targets own independent image catalogs, bytes and retained bindings",()=>{
  const firstWindow=SdlWindow.open({title:"First image context",width:8,height:8,backend:"gl",hidden:true});
  const secondWindow=SdlWindow.open({title:"Second image context",width:8,height:8,backend:"gl",hidden:true});
  const firstImages=new RendererImageCatalog(),secondImages=new RendererImageCatalog();
  const firstGl=new GlRenderer(firstWindow,firstImages),secondGl=new GlRenderer(secondWindow,secondImages);
  firstGl.initializeDefaultState(firstGl.capabilities.textureUnits > 1, () => { firstImages.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  secondGl.initializeDefaultState(secondGl.capabilities.textureUnits > 1, () => { secondImages.setTextureMode("GL_LINEAR_MIPMAP_NEAREST"); });
  const firstCpu=new SoftwareRenderer(8,8,firstImages,firstGl.subpixelBits),secondCpu=new SoftwareRenderer(8,8,secondImages,secondGl.subpixelBits);
  const firstTarget=new RenderTarget(firstImages,[firstCpu,firstGl]),secondTarget=new RenderTarget(secondImages,[secondCpu,secondGl]);
  const firstCommands=commandsFor(firstTarget),secondCommands=commandsFor(secondTarget);
  try{
    const first=image(firstImages,[255,0,0,255]),second=image(secondImages,[0,255,0,255]);
    for(const binding of [bind(first),retain]){firstCommands.addView({viewport:{x:0,y:0,width:8,height:8},clear:{ stencil: false,color:black,depth:1},operations: [{ kind: "draw", batches: [quad(binding)] }]});firstCommands.submit();}
    for(const binding of [bind(second),retain]){secondCommands.addView({viewport:{x:0,y:0,width:8,height:8},clear:{ stencil: false,color:black,depth:1},operations: [{ kind: "draw", batches: [quad(binding)] }]});secondCommands.submit();}
    expect(pixel(firstCpu.pixels)).toEqual([255,0,0,255]);expect(pixel(firstGl.readPixels())).toEqual(pixel(firstCpu.pixels));
    expect(pixel(secondCpu.pixels)).toEqual([0,255,0,255]);expect(pixel(secondGl.readPixels())).toEqual(pixel(secondCpu.pixels));
  }finally{firstTarget.close();secondTarget.close();firstWindow.close();secondWindow.close();}
});
