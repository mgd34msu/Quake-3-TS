import { HunkArena } from "../src/core/hunk.ts";
import type { SourceFileReader } from "../src/assets/reader.ts";
import type { RetainedFileBuffer, RetainedFileReader } from "../src/assets/read-file-memory.ts";
import { identityImageUploadProfile } from "./renderer-settings-fixture.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { SoundAssetReader } from "../src/cgame/sound-bank.ts";
import { ClientSoundBank } from "../src/cgame/sound-bank.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import type { PcmSound } from "../src/assets/wav.ts";
import { CommandBuffer } from "../src/core/commands.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { ClientKeys } from "../src/engine/client-keys.ts";
import type { ClientKeyHost, ClientKeyPhase } from "../src/engine/client-keys.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererResources } from "../src/render/world.ts";
import { RegisteredRendererCvars, SourceRendererSettings } from "../src/render/settings.ts";
import { BaseUiState } from "../src/ui/base/state.ts";
import { BaseUiCvars } from "../src/ui/base/cvars.ts";
import { keyEvent } from "../src/ui/base/framework.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";

export function deferred() {
  let finish:(()=>void)|undefined;
  const promise=new Promise<void>(resolve=>{finish=resolve;});
  return {promise,resolve:()=>{if(finish===undefined)throw new Error("Missing test resolver");finish();}};
}
function unavailable():never {throw new Error("This foundation fixture does not install a full client/product menu controller");}
export class ObservedAssets implements SoundAssetReader, SourceFileReader, RetainedFileReader {
  readonly reads:string[]=[];
  beforeRead:((path:string)=>Promise<void>)|null=null;
  constructor(readonly files:VirtualFileSystem){}
  has(path:string):boolean{return this.files.has(path);}
  list(prefix?:string):readonly string[]{return this.files.list(prefix);}
  readFileLength(path:string):number{return this.files.readFileLength(path);}
  readFileRetainedSync(path:string):RetainedFileBuffer|undefined {this.reads.push(path);return this.files.readFileRetainedSync(path);}
  async readFileRetained(path:string):Promise<RetainedFileBuffer|undefined>{this.reads.push(path);const before=this.beforeRead;if(before!==null)await before(path);return this.files.readFileRetained(path);}
  freeFile(buffer:RetainedFileBuffer):void {this.files.freeFile(buffer);}
  readFileOptionalSync(path:string):Uint8Array|undefined {this.reads.push(path);return this.files.readFileOptionalSync(path);}
  async readFileOptional(path:string):Promise<Uint8Array|undefined>{this.reads.push(path);const before=this.beforeRead;if(before!==null)await before(path);return this.files.readFileOptional(path);}
  readSync(path:string):Uint8Array {this.reads.push(path);return this.files.readSync(path);}
  async read(path:string):Promise<Uint8Array>{this.reads.push(path);const before=this.beforeRead;if(before!==null)await before(path);return await this.files.read(path);}
}
export async function baseFixture(width=160,height=120){
  const dataPath=process.env["Q3_DATA"]??"/home/buzzkill/Projects/qfiles/q3a";
  const files=await VirtualFileSystem.openInspection({dataPath,homePath:dataPath,cdPath:null,product:"baseq3"});
  const assets=new ObservedAssets(files),prints:string[]=[],events:string[]=[],cvars=new CvarRegistry(text=>{prints.push(text);});
  const consoleCommands=new CommandBuffer({print:text=>{prints.push(text);},resolveFallback:()=>({kind:"sync",handler:()=>unavailable()})});
  let phase:ClientKeyPhase="disconnected",state:BaseUiState|null=null,time=0;
  const mixer=new AudioMixer(22050, () => time),soundBank=new ClientSoundBank(assets,{ debugPrint: text => { prints.push(text); },print:text=>{prints.push(text);}});
  const host:ClientKeyHost={readConnection:()=>({kind:phase,demoPlayback:false}),readUi:()=>state===null?null:{
    keyEvent:async(key,down)=>{if(state===null)throw new Error("Missing real base UI state");await keyEvent(state,key,down);},setActiveMenu:async()=>unavailable()},
    readCgame:()=>null,assertCurrentOperation:()=>{consoleCommands.assertCurrentExecution();},disconnect:async()=>unavailable(),
    stopAllSounds:()=>{mixer.stopAll();},addReliableCommand:()=>unavailable(),toggleConsole:async()=>unavailable(),updateScreen:async()=>unavailable(),
    consoleScroll:()=>unavailable(),readConsoleWidth:()=>78,clipboard:{kind:"native-unix-unavailable"}};
  const keys=new ClientKeys({commands:consoleCommands,cvars,print:text=>{prints.push(text);},host});keys.initializeCommands();keys.initializeConsoleFields(78);
  const images=new RendererImageCatalog(),cpu=new SoftwareRenderer(width,height,images),recorder=new BatchRecordingBackend(cpu),target=new RenderTarget(images,[recorder]);
  const registered=new RegisteredRendererCvars(cvars,"linux");
  const builtins=new BuiltinImages(images, identityImageUploadProfile),settings=new SourceRendererSettings(registered, {textureUnits:2,textureEnvAdd:true});
  const cinematics=new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: () => undefined,files: { kind: "diagnostic-bytes", reader: assets },sound: { kind: "diagnostic", readMixer: () => mixer },clock:{sample:()=>time},scratchImages:builtins,console:{kind:"absent"},
    settings:{inGameVideo:()=>1,hardware:"generic",maxTextureSize:4096}});
  let renderCommands:RenderCommandBuffer|null=null;
  try{
    const resources=await RendererResources.create(assets,{kind:"unaccounted"},settings,{ patchMemory: { kind: "diagnostic" }, print:text=>{prints.push(text);}, imageProfile: identityImageUploadProfile, target,images,builtins,drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics:cinematics.shaderCinematics});
    renderCommands=new RenderCommandBuffer(target,{print: (text: string) => { prints.push(text); }, clock:{milliseconds:()=>time},identityLight:1,tess:resources.tess,runtime:settings.runtime});
    const soundNames=new Map<PcmSound,string|null>(),registrations:string[]=[];
    const registerSound=soundBank.registerSound.bind(soundBank);soundBank.registerSound=async(path,compressed)=>{
      registrations.push(`sound:${path}:${compressed}`);const result=await registerSound(path,compressed);if(result!==null)soundNames.set(result,path);return result;};
    await soundBank.beginRegistration();const zero=soundBank.resolveForPlayback(null);if(zero!==null)soundNames.set(zero,"sound/feedback/hit.wav");
    const registerShader=resources.registerShaderNoMip.bind(resources);resources.registerShaderNoMip=async path=>{registrations.push(`shader:${path}`);return await registerShader(path);};
    const uiCvars=new BaseUiCvars(cvars,()=>{consoleCommands.assertCurrentExecution();});
    state=new BaseUiState({cvars:uiCvars,keys,clipboard:host.clipboard,resources,commands:renderCommands,consoleCommands,sounds:soundBank,audio:mixer,hardware:"generic",
      readClientPhase:()=>phase,print:text=>{consoleCommands.assertCurrentExecution();prints.push(text);},assertCurrentOperation:()=>{consoleCommands.assertCurrentExecution();}});
    uiCvars.register();
    const commands=renderCommands;
    const play=mixer.startLocalSound.bind(mixer);mixer.startLocalSound=(sound,channel)=>{
      const name=soundNames.get(sound);if(name===undefined)throw new Error("Playback did not originate in real sound registration");
      events.push(`sound:${name}:${channel}`);return play(sound,channel);};
    return {state,keys,cvars,registered,consoleCommands,commands,resources,soundBank,mixer,assets,prints,events,cpu,target,recorder,registrations,
      phase:(value:ClientKeyPhase)=>{phase=value;},time:(value:number)=>{time=value;},
      close:()=>{commands.close("discard");try{target.close();}finally{cinematics.dispose();mixer.stopAll();files.close();}}};
  }catch(error){renderCommands?.close("discard");try{target.close();}finally{cinematics.dispose();mixer.stopAll();files.close();}throw error;}
}
