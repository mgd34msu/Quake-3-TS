import { HunkArena } from "../src/core/hunk.ts";
import { describe, expect, test } from "bun:test";
import type { PlayerFootsteps, PlayerGender } from "../src/assets/animation.ts";
import type { PcmSound } from "../src/assets/wav.ts";
import { decodeWav } from "../src/assets/wav.ts";
import { VirtualFileSystem } from "../src/assets/vfs.ts";
import type { BspMap } from "../src/assets/bsp.ts";
import { AudioMixer } from "../src/audio/mixer.ts";
import { CollisionWorld } from "../src/collision/world.ts";
import { ClientEffects } from "../src/cgame/effects.ts";
import type { EffectMedia } from "../src/cgame/effects.ts";
import { LocalEntityPool, LocalEntitySystem } from "../src/cgame/local-entities.ts";
import type { LocalEntityHost, LocalEntityMedia } from "../src/cgame/local-entities.ts";
import { ClientCommandHistory, PredictionRuntime } from "../src/cgame/prediction.ts";
import { ClientEventRuntime, placeString } from "../src/cgame/events.ts";
import type { ClientEventHost, ClientEventMedia, ClientEventOptions } from "../src/cgame/events.ts";
import { PacketEntityPresenter } from "../src/cgame/entities.ts";
import type { PacketEntityMedia } from "../src/cgame/entities.ts";
import { SnapshotRuntime } from "../src/cgame/snapshots.ts";
import { ClientGameState, ClientGameStaticState } from "../src/cgame/state.ts";
import { ClientServerCommandRuntime } from "../src/cgame/server-commands.ts";
import { PlayerStateRuntime } from "../src/cgame/player-state.ts";
import { CvarRegistry } from "../src/core/cvar.ts";
import { CommonError } from "../src/core/common-error.ts";
import { ClientInfo } from "../src/cgame/client-info.ts";
import { ClientWeaponMediaRegistry, ClientWeaponRuntime } from "../src/cgame/weapons.ts";
import { anglesToAxis, vec3, vec4 } from "../src/core/math.ts";
import type { Vec3 } from "../src/core/math.ts";
import { float32ToBits } from "../src/core/numeric.ts";
import { GameRandom } from "../src/game/numeric.ts";
import type { RetailSnapshot } from "../src/cgame/retail-snapshot.ts";
import { DEFAULT_MODEL } from "../src/render/ref-entity.ts";
import { RendererResources } from "../src/render/world.ts";
import { EngineCinematics } from "../src/engine/cinematics.ts";
import { BuiltinImages } from "../src/render/builtin-images.ts";
import { RenderCommandBuffer, RenderTarget } from "../src/render/commands.ts";
import { RendererImageCatalog } from "../src/render/image-resource.ts";
import { BatchRecordingBackend } from "./render-target-fixture.ts";
import { createRefdef, RDF_NOWORLDMODEL } from "../src/render/refdef.ts";
import { SoftwareRenderer } from "../src/render/cpu/rasterizer.ts";
import { GlRenderer } from "../src/render/gl/renderer.ts";
import { SdlWindow } from "../src/platform/sdl.ts";
import { EntityEvent, EntityType, GameType, ItemType, PersistentIndex, Powerup, Team, Weapon } from "../src/shared/definitions.ts";
import type { Product } from "../src/shared/definitions.ts";
import { itemList } from "../src/shared/items.ts";
import { createPlayerState } from "../src/shared/player-state.ts";
import { TrajectoryType } from "../src/shared/trajectory.ts";
import { createRendererSettings, identityImageUploadProfile } from "./renderer-settings-fixture.ts";

// Captured from whole unchanged cg_event.c in /tmp/quake3-cgame-events-reference-vZMD6e.
// Native driver supplies source-compatible rand and records dependent presentation calls.
// Actual QVM matrices agree except center Y; shipped base=143 and missionpack=144.
const sourceGolden: Record<Product,{self:readonly (readonly string[])[];other:readonly string[];events:readonly {event:number;state:readonly number[]}[]}> = {
  baseq3: {
    self: [
      ["Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 tripped on his own grenade.","Player1^7 killed himself.","Player1^7 blew himself up.","Player1^7 killed himself.","Player1^7 melted himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 should have used a smaller gun.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself."],
      ["Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 tripped on her own grenade.","Player1^7 killed herself.","Player1^7 blew herself up.","Player1^7 killed herself.","Player1^7 melted herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 should have used a smaller gun.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself."],
      ["Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 tripped on its own grenade.","Player1^7 killed itself.","Player1^7 blew itself up.","Player1^7 killed itself.","Player1^7 melted itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 should have used a smaller gun.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself."],
    ],
    other: ["Player1^7 was killed by Player0^7","Player1^7 was gunned down by Player0^7","Player1^7 was pummeled by Player0^7","Player1^7 was machinegunned by Player0^7","Player1^7 ate Player0^7's grenade","Player1^7 was shredded by Player0^7's shrapnel","Player1^7 ate Player0^7's rocket","Player1^7 almost dodged Player0^7's rocket","Player1^7 was melted by Player0^7's plasmagun","Player1^7 was melted by Player0^7's plasmagun","Player1^7 was railed by Player0^7","Player1^7 was electrocuted by Player0^7","Player1^7 was blasted by Player0^7's BFG","Player1^7 was blasted by Player0^7's BFG","Player1^7 sank like a rock.","Player1^7 melted.","Player1^7 does a back flip into the lava.","Player1^7 was squished.","Player1^7 tried to invade Player0^7's personal space","Player1^7 cratered.","Player1^7 suicides.","Player1^7 saw the light.","Player1^7 was in the wrong place.","Player1^7 was caught by Player0^7","Player1^7 was killed by Player0^7","Player1^7 was killed by Player0^7","Player1^7 was killed by Player0^7","Player1^7 was killed by Player0^7","Player1^7 was killed by Player0^7"],
    events: [
      {"event":0,"state":[0,0,0,0,0,0]},
      {"event":1,"state":[0,0,0,0,0,0]},
      {"event":2,"state":[0,0,0,0,0,0]},
      {"event":3,"state":[0,0,0,0,0,0]},
      {"event":4,"state":[0,0,0,0,0,0]},
      {"event":5,"state":[0,0,0,0,0,0]},
      {"event":6,"state":[0,0,0,0,0,0]},
      {"event":7,"state":[0,0,0,0,0,0]},
      {"event":8,"state":[0,0,0,0,0,0]},
      {"event":9,"state":[0,0,0,0,0,0]},
      {"event":10,"state":[0,0,0,0,0,0]},
      {"event":11,"state":[0,0,0,0,0,0]},
      {"event":12,"state":[1100,0,0,0,0,0]},
      {"event":13,"state":[0,0,0,0,0,0]},
      {"event":14,"state":[0,0,0,0,0,0]},
      {"event":15,"state":[0,0,0,0,0,0]},
      {"event":16,"state":[0,0,0,0,0,0]},
      {"event":17,"state":[0,0,0,0,0,0]},
      {"event":18,"state":[0,0,0,0,0,0]},
      {"event":19,"state":[0,0,0,0,0,0]},
      {"event":20,"state":[0,0,0,0,0,0]},
      {"event":21,"state":[0,0,0,0,0,0]},
      {"event":22,"state":[0,0,0,0,0,0]},
      {"event":23,"state":[0,0,0,0,0,0]},
      {"event":24,"state":[0,0,0,0,0,0]},
      {"event":25,"state":[0,0,0,0,0,0]},
      {"event":26,"state":[0,0,0,0,0,0]},
      {"event":27,"state":[0,0,0,0,0,0]},
      {"event":28,"state":[0,0,0,0,0,0]},
      {"event":29,"state":[0,0,0,0,0,0]},
      {"event":30,"state":[0,0,0,0,0,0]},
      {"event":31,"state":[0,0,0,0,0,0]},
      {"event":32,"state":[0,0,0,0,0,0]},
      {"event":33,"state":[0,0,0,0,0,0]},
      {"event":34,"state":[0,0,0,0,0,0]},
      {"event":35,"state":[0,0,0,0,0,0]},
      {"event":36,"state":[0,0,0,0,0,0]},
      {"event":37,"state":[0,0,0,0,0,0]},
      {"event":38,"state":[0,0,0,0,0,0]},
      {"event":40,"state":[0,0,0,0,1100,0]},
      {"event":41,"state":[0,0,0,0,0,0]},
      {"event":42,"state":[0,0,0,0,0,0]},
      {"event":43,"state":[0,0,0,0,0,0]},
      {"event":44,"state":[0,0,0,0,0,0]},
      {"event":45,"state":[0,0,0,0,0,0]},
      {"event":46,"state":[0,0,0,0,0,0]},
      {"event":47,"state":[0,0,0,0,0,0]},
      {"event":48,"state":[0,0,0,0,0,0]},
      {"event":49,"state":[0,0,0,0,0,0]},
      {"event":50,"state":[0,0,0,0,0,0]},
      {"event":51,"state":[0,0,0,0,0,0]},
      {"event":52,"state":[0,0,0,0,0,0]},
      {"event":53,"state":[0,0,0,0,0,0]},
      {"event":54,"state":[0,0,0,0,0,0]},
      {"event":56,"state":[1100,1,0,0,0,0]},
      {"event":57,"state":[0,0,0,0,0,0]},
      {"event":58,"state":[0,0,0,0,0,0]},
      {"event":59,"state":[0,0,0,0,0,0]},
      {"event":60,"state":[0,0,0,0,0,0]},
      {"event":61,"state":[0,0,0,0,0,0]},
      {"event":62,"state":[0,0,0,0,0,0]},
      {"event":63,"state":[0,0,0,0,0,0]},
      {"event":64,"state":[0,0,0,0,0,0]},
      {"event":65,"state":[0,0,0,0,0,0]},
      {"event":74,"state":[0,0,0,0,0,0]},
      {"event":75,"state":[0,0,0,0,0,0]},
      {"event":76,"state":[0,0,0,0,0,0]},
    ],
  },
  missionpack: {
    self: [
      ["Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 tripped on his own grenade.","Player1^7 killed himself.","Player1^7 blew himself up.","Player1^7 killed himself.","Player1^7 melted himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 should have used a smaller gun.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 killed himself.","Player1^7 found his prox mine.","Player1^7 goes out with a bang.","Player1^7 killed himself.","Player1^7 killed himself."],
      ["Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 tripped on her own grenade.","Player1^7 killed herself.","Player1^7 blew herself up.","Player1^7 killed herself.","Player1^7 melted herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 should have used a smaller gun.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 killed herself.","Player1^7 found her prox mine.","Player1^7 goes out with a bang.","Player1^7 killed herself.","Player1^7 killed herself."],
      ["Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 tripped on its own grenade.","Player1^7 killed itself.","Player1^7 blew itself up.","Player1^7 killed itself.","Player1^7 melted itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 should have used a smaller gun.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 killed itself.","Player1^7 found it's prox mine.","Player1^7 goes out with a bang.","Player1^7 killed itself.","Player1^7 killed itself."],
    ],
    other: ["Player1^7 was killed by Player0^7","Player1^7 was gunned down by Player0^7","Player1^7 was pummeled by Player0^7","Player1^7 was machinegunned by Player0^7","Player1^7 ate Player0^7's grenade","Player1^7 was shredded by Player0^7's shrapnel","Player1^7 ate Player0^7's rocket","Player1^7 almost dodged Player0^7's rocket","Player1^7 was melted by Player0^7's plasmagun","Player1^7 was melted by Player0^7's plasmagun","Player1^7 was railed by Player0^7","Player1^7 was electrocuted by Player0^7","Player1^7 was blasted by Player0^7's BFG","Player1^7 was blasted by Player0^7's BFG","Player1^7 sank like a rock.","Player1^7 melted.","Player1^7 does a back flip into the lava.","Player1^7 was squished.","Player1^7 tried to invade Player0^7's personal space","Player1^7 cratered.","Player1^7 suicides.","Player1^7 saw the light.","Player1^7 was in the wrong place.","Player1^7 was nailed by Player0^7","Player1^7 got lead poisoning from Player0^7's Chaingun","Player1^7 was too close to Player0^7's Prox Mine","Player1^7 falls to Player0^7's Kamikaze blast","Player1^7 was juiced by Player0^7","Player1^7 was caught by Player0^7"],
    events: [
      {"event":0,"state":[0,0,0,0,0,0]},
      {"event":1,"state":[0,0,0,0,0,0]},
      {"event":2,"state":[0,0,0,0,0,0]},
      {"event":3,"state":[0,0,0,0,0,0]},
      {"event":4,"state":[0,0,0,0,0,0]},
      {"event":5,"state":[0,0,0,0,0,0]},
      {"event":6,"state":[0,0,0,0,0,0]},
      {"event":7,"state":[0,0,0,0,0,0]},
      {"event":8,"state":[0,0,0,0,0,0]},
      {"event":9,"state":[0,0,0,0,0,0]},
      {"event":10,"state":[0,0,0,0,0,0]},
      {"event":11,"state":[0,0,0,0,0,0]},
      {"event":12,"state":[1100,0,0,0,0,0]},
      {"event":13,"state":[0,0,0,0,0,0]},
      {"event":14,"state":[0,0,0,0,0,0]},
      {"event":15,"state":[0,0,0,0,0,0]},
      {"event":16,"state":[0,0,0,0,0,0]},
      {"event":17,"state":[0,0,0,0,0,0]},
      {"event":18,"state":[0,0,0,0,0,0]},
      {"event":19,"state":[0,0,0,0,0,0]},
      {"event":20,"state":[0,0,0,0,0,0]},
      {"event":21,"state":[0,0,0,0,0,0]},
      {"event":22,"state":[0,0,0,0,0,0]},
      {"event":23,"state":[0,0,0,0,0,0]},
      {"event":24,"state":[0,0,0,0,0,0]},
      {"event":25,"state":[0,0,0,0,0,0]},
      {"event":26,"state":[0,0,0,0,0,0]},
      {"event":27,"state":[0,0,0,0,0,0]},
      {"event":28,"state":[0,0,0,0,0,0]},
      {"event":29,"state":[0,0,0,0,0,0]},
      {"event":30,"state":[0,0,0,0,0,0]},
      {"event":31,"state":[0,0,0,0,0,0]},
      {"event":32,"state":[0,0,0,0,0,0]},
      {"event":33,"state":[0,0,0,0,0,0]},
      {"event":34,"state":[0,0,0,0,0,0]},
      {"event":35,"state":[0,0,0,0,0,0]},
      {"event":36,"state":[0,0,0,0,0,0]},
      {"event":37,"state":[0,0,0,0,0,0]},
      {"event":38,"state":[0,0,0,0,0,0]},
      {"event":40,"state":[0,0,0,0,1100,0]},
      {"event":41,"state":[0,0,0,0,0,0]},
      {"event":42,"state":[0,0,0,0,0,0]},
      {"event":43,"state":[0,0,0,0,0,0]},
      {"event":44,"state":[0,0,0,0,0,0]},
      {"event":45,"state":[0,0,0,0,0,0]},
      {"event":46,"state":[0,0,0,0,0,0]},
      {"event":47,"state":[0,0,0,0,0,0]},
      {"event":48,"state":[0,0,0,0,0,0]},
      {"event":49,"state":[0,0,0,0,0,0]},
      {"event":50,"state":[0,0,0,0,0,0]},
      {"event":51,"state":[0,0,0,0,0,0]},
      {"event":52,"state":[0,0,0,0,0,0]},
      {"event":53,"state":[0,0,0,0,0,0]},
      {"event":54,"state":[0,0,0,0,0,0]},
      {"event":56,"state":[1100,1,0,0,0,0]},
      {"event":57,"state":[0,0,0,0,0,0]},
      {"event":58,"state":[0,0,0,0,0,0]},
      {"event":59,"state":[0,0,0,0,0,0]},
      {"event":60,"state":[0,0,0,0,0,0]},
      {"event":61,"state":[0,0,0,0,0,0]},
      {"event":62,"state":[0,0,0,0,0,0]},
      {"event":63,"state":[0,0,0,0,0,0]},
      {"event":64,"state":[0,0,0,0,0,0]},
      {"event":65,"state":[0,0,0,0,0,0]},
      {"event":66,"state":[0,0,0,0,0,0]},
      {"event":67,"state":[0,0,0,0,0,0]},
      {"event":68,"state":[0,0,0,0,0,0]},
      {"event":69,"state":[0,0,0,0,0,0]},
      {"event":70,"state":[0,0,0,0,0,0]},
      {"event":71,"state":[0,0,0,0,0,0]},
      {"event":72,"state":[0,0,0,0,0,0]},
      {"event":73,"state":[0,0,0,0,0,0]},
      {"event":74,"state":[0,0,0,0,0,0]},
      {"event":75,"state":[0,0,0,0,0,0]},
      {"event":76,"state":[0,0,0,0,0,0]},
      {"event":77,"state":[0,0,0,0,0,0]},
      {"event":78,"state":[0,0,0,0,0,0]},
      {"event":79,"state":[0,0,0,0,0,0]},
      {"event":80,"state":[0,0,0,0,0,0]},
      {"event":81,"state":[0,0,0,0,0,0]},
      {"event":82,"state":[0,0,0,0,0,0]},
    ],
  },
};

function snapshot(product: Product, time: number): RetailSnapshot {
  return { messageNumber:1,serverTime:time,deltaNumber:-1,flags:0,serverCommandNumber:0,parseEntitiesNumber:0,
    areaMask:new Uint8Array(32),playerState:createPlayerState(product),entities:[] };
}

function realEffects(state:ClientGameState,random:GameRandom,record:(kind:string,...args:readonly unknown[])=>void){
  const bounds={min:vec3(-4096,-4096,-4096),max:vec3(4096,4096,4096)};
  const map:BspMap={entities:"",entityRecords:[],shaders:[],planes:[],nodes:[],leaves:[{cluster:0,area:0,bounds,firstSurface:0,surfaceCount:0,firstBrush:0,brushCount:0}],leafSurfaces:[],leafBrushes:[],models:[{bounds,firstSurface:0,surfaceCount:0,firstBrush:0,brushCount:0}],brushes:[],brushSides:[],vertices:[],indices:[],fogs:[],surfaces:[],lightmaps:[],lightGrid:[],visibility:null};
  const collision=new CollisionWorld(map, { kind: "unaccounted" }, { kind: "disabled" }),audio=new AudioMixer(22050, () => 0);
  const unavailable=():never=>{throw new Error("Unexpected prediction movement or collision mark in event fixture");};
  const prediction=new PredictionRuntime(state,collision,{commands:new ClientCommandHistory(),settings:unavailable,setPmoveMsec:unavailable,transitionPlayerState:unavailable,warn:unavailable});
  const pcm:PcmSound={sampleRate:22050,channels:1,samples:new Int16Array([100]),frameCount:1,loopStart:null};
  const media:LocalEntityMedia={bloodTrailShader:{name:"bloodTrail"},bloodMarkShader:{name:"bloodMark"},burnMarkShader:{name:"burnMark"},gibBounceSounds:[pcm,pcm,pcm],numberShaders:[{name:"0"},{name:"1"},{name:"2"},{name:"3"},{name:"4"},{name:"5"},{name:"6"},{name:"7"},{name:"8"},{name:"9"},{name:"minus"}]};
  const localAudio:LocalEntityHost["audio"]={startSound(pcm,options){
    if(pcm===null)throw new Error("Fixture media unexpectedly returned source sound handle zero");
    audio.startSound(pcm,options);
  }};
  const services={prediction,collision,audio:localAudio,clientNum:0,random,marks:{impactMark:unavailable}};
  const host:LocalEntityHost=state.product==="baseq3"?{...services,product:"baseq3",media}:{...services,product:"missionpack",media:{...media,kamikazeShockWave:DEFAULT_MODEL,kamikazeExplodeSound:pcm,kamikazeImplodeSound:pcm}};
  const pool=new LocalEntityPool(state.product);
  const effectMedia:EffectMedia={waterBubbleShader:{name:"bubble"},smokePuffRageProShader:{name:"rage"},bloodExplosionShader:{name:"blood"},teleportEffectModel:DEFAULT_MODEL,gibSkull:DEFAULT_MODEL,gibBrain:DEFAULT_MODEL,gibAbdomen:DEFAULT_MODEL,gibArm:DEFAULT_MODEL,gibChest:DEFAULT_MODEL,gibFist:DEFAULT_MODEL,gibFoot:DEFAULT_MODEL,gibForearm:DEFAULT_MODEL,gibIntestine:DEFAULT_MODEL,gibLeg:DEFAULT_MODEL,smoke2:DEFAULT_MODEL,
    variant:state.product==="baseq3"?{product:"baseq3",teleportEffectShader:{name:"teleport"}}:{product:"missionpack",media:{lightningShader:{name:"lightning"},kamikazeEffectModel:DEFAULT_MODEL,dishFlashModel:DEFAULT_MODEL,rocketExplosionShader:{name:"rocket"},obeliskHitSounds:[pcm,pcm,pcm],invulnerabilityImpactModel:DEFAULT_MODEL,invulnerabilityImpactSounds:[pcm,pcm,pcm],invulnerabilityJuicedModel:DEFAULT_MODEL,invulnerabilityJuicedSound:pcm}}};
  const effect=new ClientEffects(state,pool,effectMedia,{noProjectileTrail:false,blood:true,gibs:true,scorePlum:true,hardware:"generic"},{randomInteger:()=>random.rand(),startSound:(...args)=>record("effectSound",...args)});
  const locals=new LocalEntitySystem(effect,host);
  return {effects:effect,pool,locals,prediction,audio};
}

function fixture(product: Product = "baseq3") {
  const state = new ClientGameState(product,0,0), random = new GameRandom(0);
  state.snap = snapshot(product,1000); state.time = 1100;
  const calls: { kind: string; args: readonly unknown[] }[] = [];
  const record = (kind: string,...args: readonly unknown[]):void => { calls.push({kind,args}); };
  const names = new WeakMap<PcmSound,string>();
  const {effects,pool,locals,prediction,audio}=realEffects(state,random,record);
  function sound(name: string): PcmSound { const value: PcmSound = {sampleRate:22050,channels:1,samples:new Int16Array([100]),frameCount:1,loopStart:null}; names.set(value,name); return value; }
  function label(sound: PcmSound | null): string | null { if (sound === null) return null; const name = names.get(sound); if (name === undefined) throw new Error("Unregistered fixture sound"); return name; }
const sounds = {
    useNothingSound: sound("useNothingSound"),
    medkitSound: sound("medkitSound"),
    landSound: sound("landSound"),
    jumpPadSound: sound("jumpPadSound"),
    watrInSound: sound("watrInSound"),
    watrOutSound: sound("watrOutSound"),
    watrUnSound: sound("watrUnSound"),
    n_healthSound: sound("n_healthSound"),
    selectSound: sound("selectSound"),
    teleInSound: sound("teleInSound"),
    teleOutSound: sound("teleOutSound"),
    respawnSound: sound("respawnSound"),
    hgrenb1aSound: sound("hgrenb1aSound"),
    hgrenb2aSound: sound("hgrenb2aSound"),
    captureYourTeamSound: sound("captureYourTeamSound"),
    captureOpponentSound: sound("captureOpponentSound"),
    returnYourTeamSound: sound("returnYourTeamSound"),
    returnOpponentSound: sound("returnOpponentSound"),
    blueFlagReturnedSound: sound("blueFlagReturnedSound"),
    redFlagReturnedSound: sound("redFlagReturnedSound"),
    enemyTookYourFlagSound: sound("enemyTookYourFlagSound"),
    yourTeamTookEnemyFlagSound: sound("yourTeamTookEnemyFlagSound"),
    yourBaseIsUnderAttackSound: sound("yourBaseIsUnderAttackSound"),
    redScoredSound: sound("redScoredSound"),
    blueScoredSound: sound("blueScoredSound"),
    redLeadsSound: sound("redLeadsSound"),
    blueLeadsSound: sound("blueLeadsSound"),
    teamsTiedSound: sound("teamsTiedSound"),
    quadSound: sound("quadSound"),
    protectSound: sound("protectSound"),
    regenSound: sound("regenSound"),
    gibSound: sound("gibSound"),
  };
  const missionSounds = {
    useInvulnerabilitySound: sound("useInvulnerabilitySound"),
    scoutSound: sound("scoutSound"),
    guardSound: sound("guardSound"),
    doublerSound: sound("doublerSound"),
    ammoregenSound: sound("ammoregenSound"),
    wstbimplSound: sound("wstbimplSound"),
    wstbimpmSound: sound("wstbimpmSound"),
    wstbimpdSound: sound("wstbimpdSound"),
    wstbactvSound: sound("wstbactvSound"),
    yourTeamTookTheFlagSound: sound("yourTeamTookTheFlagSound"),
    enemyTookTheFlagSound: sound("enemyTookTheFlagSound"),
    kamikazeFarSound: sound("kamikazeFarSound"),
  };
  const footsteps = (kind: string): readonly [PcmSound,PcmSound,PcmSound,PcmSound] => [sound(kind+0),sound(kind+1),sound(kind+2),sound(kind+3)];
  const media: ClientEventMedia = {sounds,footsteps:{normal:footsteps("normal"),boot:footsteps("boot"),flesh:footsteps("flesh"),mech:footsteps("mech"),energy:footsteps("energy"),metal:footsteps("metal"),splash:footsteps("splash")},gameSounds:Array.from({length:256},(_,index)=>index===1?sound("registered"):null),smokePuffShader:{name:"smoke"}};
  const packetMedia: PacketEntityMedia = {gameModels:[],gameSounds:media.gameSounds,inlineModels:[{model:DEFAULT_MODEL,midpoint:vec3(4,5,6)}],items:[],weapons:[],plasmaBallShader:null,redFlagBaseModel:DEFAULT_MODEL,blueFlagBaseModel:DEFAULT_MODEL,neutralFlagBaseModel:DEFAULT_MODEL,
    variant:product === "baseq3" ? {product} : {product,media:{weaponHoverSound:null,blueProxMine:DEFAULT_MODEL,overloadBaseModel:DEFAULT_MODEL,overloadEnergyModel:DEFAULT_MODEL,overloadLightsModel:DEFAULT_MODEL,overloadTargetModel:DEFAULT_MODEL,obeliskRespawnSound:null,harvesterModel:DEFAULT_MODEL,harvesterNeutralModel:DEFAULT_MODEL,harvesterRedSkin:null,harvesterBlueSkin:null}}};
  const entities = new PacketEntityPresenter(state,packetMedia,{
    addRefEntity: entity => record("ref",entity),addLight: light => record("light",light),updateSoundPosition:(number,origin)=>record("position",number,origin),
    addLoopSound:(...args)=>record("loop",...args),startSound:(...args)=>record("packetSound",...args),randomInteger:()=>random.rand(),player:entity=>record("player",entity),
    missileTrail:(...args)=>record("trail",...args),grappleTrail:(...args)=>record("grapple",...args),addEntityWithPowerups:(...args)=>record("powerups",...args)});
  const options: {-readonly [K in keyof ClientEventOptions]:ClientEventOptions[K]} = {gameType:GameType.GT_FFA,debugEvents:false,footsteps:true,autoswitch:true,demoPlayback:false,noPredict:false,synchronousClients:false,singlePlayerActive:false,cameraOrbit:false};
  const clients: {gender:PlayerGender;footsteps:PlayerFootsteps;team:Team;medkitUsageTime:number}[] = Array.from({length:64},(_,number)=>({gender:"male",footsteps:"normal",team:number===0?Team.TEAM_RED:Team.TEAM_BLUE,medkitUsageTime:0}));
  const nameTable = Array.from({length:64},(_,number)=>`Player${number}`);
  const common = {media,options,random,entities,clientInfo:(number:number)=>{const client=clients[number];if(client===undefined)throw new Error("Client info range");return client;},
    playerName:(number:number)=>{const name=nameTable[number];if(name===undefined)throw new Error("Player name range");return name;},soundConfigString:(index:number)=>`config${index}`,
    customSound:(number:number,name:string)=>{record("custom",number,name);return sound(name);},registerSound:(path:string|null,compressed:boolean)=>{record("register",path,compressed);return path===null?null:sound(path);},
    startSound:(origin:Vec3|null,number:number,channel:number,value:PcmSound|null)=>record("sound",origin,number,channel,label(value)),stopLoopingSound:(number:number)=>record("stop",number),
    addBufferedSound:(value:PcmSound|null)=>record("buffer",label(value)),print:(message:string)=>record("print",message),centerPrint:(message:string,y:number,width:number)=>record("center",message,y,width),
    effects:{smokePuff:(request:Parameters<ClientEffects["smokePuff"]>[0])=>{record("smoke",request.origin,request.velocity,request.radius,request.color,request.duration,request.startTime,request.fadeInTime,request.flags,request.shader);return effects.smokePuff(request);},
      spawnEffect:(origin:Vec3)=>{record("spawn",origin);return effects.spawnEffect(origin);},gibPlayer:(origin:Vec3)=>{record("gib",origin);effects.gibPlayer(origin);},scorePlum:(...args:Parameters<ClientEffects["scorePlum"]>)=>{record("score",...args);effects.scorePlum(...args);}},
    weapons:{outOfAmmoChange:()=>record("noammo"),fireWeapon:(...args:Parameters<ClientEventHost["weapons"]["fireWeapon"]>)=>record("fire",...args),
      missileHitPlayer:(...args:Parameters<ClientEventHost["weapons"]["missileHitPlayer"]>)=>record("hitPlayer",...args),missileHitWall:(...args:Parameters<ClientEventHost["weapons"]["missileHitWall"]>)=>record("hitWall",...args),
      railTrail:(...args:Parameters<ClientEventHost["weapons"]["railTrail"]>)=>record("rail",...args),bullet:(...args:Parameters<ClientEventHost["weapons"]["bullet"]>)=>record("bullet",...args),shotgunFire:(...args:Parameters<ClientEventHost["weapons"]["shotgunFire"]>)=>record("shotgun",...args)}};
  const host:ClientEventHost = product==="baseq3"?{...common,product}:{...common,product,missionSounds,startLocalSound:(value,channel)=>record("local",label(value),channel),
    voiceChatLocal: async (...args) =>{record("voice",...args);},missionEffects:effects};
  const runtime = new ClientEventRuntime(state,host), entity = state.entityAt(1);
  entity.currentState.number=1;entity.currentState.clientNum=1;entity.currentState.eType=EntityType.ET_PLAYER;
  entity.currentState.pos={type:TrajectoryType.TR_LINEAR,time:500,duration:0,base:vec3(10,20,30),delta:vec3(4,6,8)};
  entity.lerpOrigin=vec3(7,8,9);
  async function event(number:number,parm=0):Promise<void> {entity.currentState.event=number;entity.currentState.eventParm=parm;await runtime.entityEvent(entity,vec3(90,80,70));}
  return {state,random,calls,record,options,clients,nameTable,media,host,runtime,entity,event,pool,locals,effects,prediction,audio,sounds:()=>calls.filter(call=>call.kind==="sound").map(call=>call.args)};
}

describe("CG_CheckEvents and source snapshot transitions",()=>{
  test("checkEvents propagates voice rejection after source dedup and sound-position mutations", async () => {
    const f = fixture("missionpack"), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    if (f.host.product !== "missionpack") throw new Error("Mission fixture required");
    const events = new ClientEventRuntime(f.state, { ...f.host, voiceChatLocal: async () => { entered.resolve(); await gate.promise; } });
    f.entity.currentState.event = EntityEvent.EV_TAUNT_YES;
    const work = events.checkEvents(f.entity); await entered.promise;
    expect(f.entity.previousEvent).toBe(EntityEvent.EV_TAUNT_YES);
    expect(f.calls.map(call => call.kind)).toEqual(["position"]);
    gate.reject(new Error("voice load failed")); await expect(work).rejects.toThrow("voice load failed");
    await events.checkEvents(f.entity); expect(f.calls.map(call => call.kind)).toEqual(["position"]);
  });
  test("real predictable/external events await full voice-ring playback, then dispatch corrected effects once", async () => {
    const f = fixture("missionpack"), cgs = new ClientGameStaticState("missionpack");
    if (f.host.product !== "missionpack") throw new Error("Mission fixture required");
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), cvars = new CvarRegistry();
    for (const [name, value] of [["com_buildScript", "0"], ["cg_teamChatsOnly", "0"], ["cg_noVoiceChats", "0"], ["cg_noVoiceText", "0"], ["cg_teamChatHeight", "8"], ["cg_teamChatTime", "3000"]]) {
      if (name === undefined || value === undefined) throw new Error("Cvar row"); cvars.register(name, value);
    }
    const unavailable = (): never => { throw new Error("Unused integration service"); };
    const data = new TextEncoder().encode('male followme { voice.wav "Follow me" }');
    const readVoiceFile = (path: string): Uint8Array => { if (path !== "fixture.voice") throw new Error(`Missing voice fixture ${path}`); return data; };
    const pcm: PcmSound = { sampleRate: 22050, channels: 1, frameCount: 16, samples: new Int16Array(16).fill(1000), loopStart: null };
    const voices = new ClientServerCommandRuntime({ state: f.state, staticState: cgs, random: f.random,
      clients: { clientInfo: index => { const info = cgs.clientInfo[index]; if (info === undefined) throw new Error("Client index"); return info; },
        newClientInfo: unavailable, loadDeferredPlayers: unavailable, reset: unavailable },
      assets: { has: path => path === "fixture.voice", read: async path => readVoiceFile(path), readSync: readVoiceFile, list: () => ["fixture.voice"] },
      resources: { registerModel: unavailable }, resetPlayerEntity: unavailable, getServerCommand: unavailable,
      refreshGameState: unavailable, configString: unavailable, setCvar: unavailable,
      readVmCvar: name => { const value = cvars.get(name); if (value === undefined) throw new Error(`Cvar ${name}`); return value; },
      print: message => f.record("voiceText", message), centerPrint: unavailable, sendConsoleCommand: unavailable,
      sound: unavailable, registerSound: async () => pcm,
      startLocalSound: (sound, channel) => { f.record("voiceSound", channel); if (sound !== null) f.audio.startSound(sound, { entity: 0, channel, origin: { kind: "local" }, volume: 127 }); },
      startBackgroundTrack: unavailable, remapShader: unavailable, clearLocalEntities: unavailable, clearMarks: unavailable,
      clearParticles: unavailable, clearLoopingSounds: unavailable, setScoreSelection: unavailable, memoryRemaining: unavailable,
      showResponseHead: async () => { f.record("headBegin"); entered.resolve(); await gate.promise; f.record("headEnd"); }
    });
    await voices.parseVoiceChats("fixture.voice", 0);
    for (let i = 0; i < 31; i++) await voices.voiceChatLocal(1, false, 1, 53, "followme");
    const events = new ClientEventRuntime(f.state, { ...f.host, voiceChatLocal: (mode, only, client, color, command) => voices.voiceChatLocal(mode, only, client, color, command) });
    const transitions = new PlayerStateRuntime(f.state, { product: "missionpack", staticState: cgs, events, showMiss: true,
      get sounds(): never { return unavailable(); }, get missionSounds(): never { return unavailable(); }, get medals(): never { return unavailable(); },
      startLocalSound: unavailable, addBufferedSound: unavailable, print: message => f.record("correction", message)
    });
    const previous = createPlayerState("missionpack"); previous.clientNum = 1;
    const current = previous.copy(); current.externalEvent = EntityEvent.EV_TAUNT_FOLLOWME; current.addEvent(EntityEvent.EV_JUMP, 0);
    const work = transitions.checkPlayerstateEvents(current, previous); await entered.promise;
    expect(f.calls.map(call => call.kind)).toEqual(["voiceSound", "headBegin"]);
    expect(f.state.voiceChatBufferOut).toBe(0); expect(f.state.eventSequence).toBe(0); expect(cgs.acceptTask).toBe(4);
    expect(f.audio.mix(4).some(sample => sample !== 0)).toBe(true);
    gate.resolve(); await work;
    expect(f.calls.map(call => call.kind)).toEqual(["voiceSound", "headBegin", "headEnd", "voiceText", "custom", "sound"]);
    expect(f.state.voiceChatBufferOut).toBe(1); expect(f.state.eventSequence).toBe(1);
    const count = f.calls.length; await transitions.checkPlayerstateEvents(current, current.copy()); expect(f.calls).toHaveLength(count);
    current.events.set(0, EntityEvent.EV_JUMP_PAD); await transitions.checkChangedPredictableEvents(current);
    expect(f.pool.activeCount).toBe(1); expect(f.calls.at(-1)?.kind).toBe("correction");
    const correctedCount = f.calls.length; await transitions.checkChangedPredictableEvents(current);
    expect(f.pool.activeCount).toBe(1); expect(f.calls).toHaveLength(correctedCount);
  });
  test("event bits deduplicate, event-only entities rewrite number once, and real sound positioning uses snapshot time",async ()=>{
    for(const product of ["baseq3","missionpack"] satisfies Product[]){
      const f=fixture(product);f.entity.currentState.event=EntityEvent.EV_FALL_SHORT;
      await f.runtime.checkEvents(f.entity);await f.runtime.checkEvents(f.entity);
      expect(f.entity.lerpOrigin).toEqual(vec3(12,23,34));expect(f.sounds()).toHaveLength(1);
      expect(f.calls[0]).toEqual({kind:"position",args:[1,vec3(12,23,34)]});
      f.entity.currentState.event|=256;await f.runtime.checkEvents(f.entity);expect(f.sounds()).toHaveLength(2);
      f.entity.currentState.event=512;await f.runtime.checkEvents(f.entity);expect(f.entity.previousEvent).toBe(512);expect(f.sounds()).toHaveLength(2);
      const e=f.state.entityAt(100);e.currentState.eType=EntityType.ET_EVENTS+EntityEvent.EV_ITEM_RESPAWN;e.currentState.eFlags=16;e.currentState.otherEntityNum=3;e.currentState.number=100;
      e.currentState.solid=0xffffff;e.currentState.modelindex=0;e.currentState.pos=f.entity.currentState.pos;
      await f.runtime.checkEvents(e);await f.runtime.checkEvents(e);expect(e.currentState.number).toBe(3);expect(e.previousEvent).toBe(1);expect(e.miscTime).toBe(1100);
      expect(f.calls.find(call=>call.kind==="position"&&call.args[0]===3)).toEqual({kind:"position",args:[3,vec3(16,28,40)]});
    }
  });
  test("actual SnapshotRuntime carries dedup across snapshots and replays after a stale teleport reset",async()=>{
    const f=fixture();const snapshots=new SnapshotRuntime(f.state,{source:{current:()=>({number:0,serverTime:0}),read:()=>null},demoPlayback:false,noPredict:false,synchronousClients:false,
      executeServerCommands:async sequence=>f.record("commands",sequence),respawn:()=>f.record("respawn"),resetPlayerEntity:entity=>f.record("reset",entity.currentState.number),checkEvents: async entity =>await f.runtime.checkEvents(entity),transitionPlayerState: async () =>f.record("transition"),lagometerSnapshot:()=>f.record("lagometer"),warn:message=>f.record("warn",message)});
    const es=f.entity.currentState.copy();es.event=EntityEvent.EV_JUMP;
    await snapshots.setInitialSnapshot({...snapshot("baseq3",1000),entities:[es]});
    snapshots.setNextSnapshot({...snapshot("baseq3",1100),entities:[es]});await snapshots.transitionSnapshot();expect(f.sounds()).toHaveLength(1);
    f.state.time=1500;es.eFlags=4;snapshots.setNextSnapshot({...snapshot("baseq3",1500),entities:[es]});await snapshots.transitionSnapshot();expect(f.sounds()).toHaveLength(2);
  });
  test("source unknown events fail after dedup mutation while zero events and repeated failures do not replay",async ()=>{
    for (const product of ["baseq3", "missionpack"] satisfies Product[]) {
      const f = fixture(product);
      for (const event of [39, 55, 999]) {
        const work = f.event(event);
        await expect(work).rejects.toBeInstanceOf(CommonError);
        await expect(work).rejects.toMatchObject({ code: "drop", message: `Unknown event: ${event & ~768}` });
      }
      f.options.debugEvents = true;
      f.entity.currentState.event = 55;
      const work = f.runtime.checkEvents(f.entity);
      await expect(work).rejects.toBeInstanceOf(CommonError);
      await expect(work).rejects.toMatchObject({ code: "drop", message: "Unknown event: 55" });
      expect(f.entity.previousEvent).toBe(55);
      expect(f.entity.lerpOrigin).toEqual(vec3(12, 23, 34));
      expect(f.calls).toEqual([{ kind: "position", args: [1, vec3(12, 23, 34)] },
        { kind: "print", args: ["ent:  1  event: 55 "] }, { kind: "print", args: ["UNKNOWN\n"] }]);
      await f.runtime.checkEvents(f.entity);
      expect(f.calls).toHaveLength(3);
      await f.event(0); expect(f.sounds()).toHaveLength(0);
    }
  });
});

describe("movement sounds and local presentation state",()=>{
  test("independent QVM RNG advances only for enabled footsteps and grenade bounces",async ()=>{
    const f=fixture(),expected=new GameRandom(0);
    for(const [event,kind] of [[1,"normal"],[2,"metal"],[3,"splash"],[4,"splash"],[5,"splash"]] satisfies [number,string][]){await f.event(event);expect(f.sounds().at(-1)).toEqual([null,1,5,kind+(expected.rand()&3)]);}
    f.options.footsteps=false;await f.event(1);await f.event(44);expect(f.sounds().at(-1)).toEqual([null,1,0,(expected.rand()&1)?"hgrenb1aSound":"hgrenb2aSound"]);
    expect(f.random.rand()).toBe(expected.rand());expect(fixture().random.rand()).toBe(1);
  });
  test("pain throttling, thresholds, direction and far-fall suppression preserve source time wrap",async ()=>{
    const f=fixture();for(const health of [24,25,49,50,74,75]){f.state.time+=500;f.runtime.painEvent(f.entity,health);expect(f.sounds().at(-1)?.[3]).toBe(`*pain${health<25?25:health<50?50:health<75?75:100}_1.wav`);}
    expect(f.entity.player.painDirection).toBe(false);const count=f.sounds().length;f.state.time+=499;f.runtime.painEvent(f.entity,1);expect(f.sounds()).toHaveLength(count);
    f.entity.currentState.clientNum=0;await f.event(12);expect(f.state.landChange).toBe(-24);expect(f.entity.player.painTime).toBe(f.state.time);
    f.runtime.painEvent(f.entity,1);expect(f.sounds()).toHaveLength(count+1);
    f.entity.player.painTime=2147483600;f.state.time=-2147483100;f.runtime.painEvent(f.entity,100);expect(f.entity.player.painTime).toBe(-2147483100);
    f.entity.currentState.number=0;f.state.time+=1000;await f.event(56,1);expect(f.entity.player.painTime).toBe(-2147483100);
  });
  test("fall and step transitions use predicted client, source float32 arithmetic and interpolation exclusions",async ()=>{
    const f=fixture();f.entity.currentState.clientNum=0;
    for(const [event,change] of [[10,-8],[11,-16],[12,-24]]){if(event===undefined||change===undefined)throw new Error("Fixture row");await f.event(event);expect(f.state.landChange).toBe(change);}
    f.state.stepChange=Math.fround(7.1);f.state.stepTime=1037;await f.event(6);
    // Whole cg_event.c through pinned q3lcc and the unchanged QVM interpreter.
    expect(float32ToBits(f.state.stepChange)).toBe(1091424486);
    expect(float32ToBits(f.state.stepChange)).toBe(float32ToBits(Math.fround(Math.fround(Math.fround(Math.fround(7.1)*137)/200)+4)));
    await f.event(9);await f.event(9);expect(f.state.stepChange).toBe(32);
    for(const key of ["demoPlayback","noPredict","synchronousClients"] satisfies (keyof Pick<ClientEventOptions,"demoPlayback"|"noPredict"|"synchronousClients">)[]){f.options[key]=true;f.state.stepChange=2;await f.event(9);expect(f.state.stepChange).toBe(2);f.options[key]=false;}
    const snap=f.state.snap;if(snap===null)throw new Error("Missing snapshot");snap.playerState.pmFlags=4096;await f.event(9);expect(f.state.stepChange).toBe(2);
  });
  test("jump pad preserves effect then origin sound then attached custom sound order",async ()=>{
    const f=fixture();await f.event(13);expect(f.calls.map(call=>call.kind)).toEqual(["smoke","sound","custom","sound"]);
    expect(f.calls[0]?.args).toEqual([vec3(7,8,9),vec3(0,0,1),32,{x:1,y:1,z:1,w:Math.fround(.33)},1000,1100,0,1,{name:"smoke"}]);
    expect(f.sounds()[0]).toEqual([vec3(7,8,9),-1,3,"jumpPadSound"]);
  });
});

describe("items, weapons and required presentation effects",()=>{
  test("fire event reaches actual registered weapon state and mixes its retail shot sound",async()=>{
    for(const product of ["baseq3","missionpack"] satisfies Product[]){
      const f=fixture(product),vfs=await VirtualFileSystem.openInspection({dataPath:process.env["Q3_DATA"]??"/home/buzzkill/Projects/qfiles/q3a", homePath: process.env["Q3_DATA"]??"/home/buzzkill/Projects/qfiles/q3a", cdPath: null,product});
      const images = new RendererImageCatalog(), cpu = new SoftwareRenderer(1, 1, images), recording = new BatchRecordingBackend(cpu);
      const target = new RenderTarget(images, [recording]), builtins = new BuiltinImages(images, identityImageUploadProfile), clock = { milliseconds: () => f.state.time };
      const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: text => { f.host.print(text); return undefined; }, files: { kind: "diagnostic-bytes", reader: vfs }, sound: { kind: "diagnostic", readMixer: () => f.audio }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
        console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: 4096 } });
      let commands: RenderCommandBuffer | null = null;
      try {
        const settings = createRendererSettings();
        const resources = await RendererResources.create(vfs, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: text => { f.host.print(text); }, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
        commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
        const registry=new ClientWeaponMediaRegistry(product,resources,{registerSound:async path=>decodeWav(await vfs.read(path),path)});
        await registry.registerWeapon(Weapon.WP_ROCKET_LAUNCHER);
        const unavailable=():never=>{throw new Error("Rocket fire does not invoke impact, particles or weapon-selection drawing");};
        const weapons=new ClientWeaponRuntime(f.state,registry,{prediction:f.prediction,random:f.random,localEntities:f.pool,effects:f.effects,marks:{impactMark:unavailable},particles:{explosion:unavailable},
          media:{models:{machinegunBrass:DEFAULT_MODEL,shotgunBrass:DEFAULT_MODEL,dishFlash:DEFAULT_MODEL,ringFlash:DEFAULT_MODEL,bulletFlash:DEFAULT_MODEL},
            shaders:{smokePuff:null,nailPuff:null,shotgunSmokePuff:null,invis:null,battleWeapon:null,quadWeapon:null,select:null,noammo:null,holeMark:null,burnMark:null,energyMark:null,bulletMark:null,tracer:null},
            sounds:{quad:null,nailHitFlesh:null,nailHitMetal:null,nailHit:null,proxExplosion:null,rocketExplosion:null,plasmaExplosion:null,chaingunHitFlesh:null,chaingunHitMetal:null,chaingunHit:null,ricochet1:null,ricochet2:null,ricochet3:null,tracer:null}},
          drawing:{fadeColor:unavailable,setColor:unavailable,drawPic:unavailable,drawStringLength:unavailable,drawBigStringColor:unavailable},
          settings:()=>({brassTime:0,railTrailTime:400,oldRail:false,noProjectileTrail:false,oldPlasma:false,oldRocket:false,trueLightning:0,drawGun:true,fov:90,gunX:0,gunY:0,gunZ:0,gunFrame:0,tracerLength:160,tracerWidth:1,tracerChance:.4,hardware:"generic"}),
          clientInfo:()=>new ClientInfo(),sound:unavailable,addPoly:unavailable,addRefEntity:entity=>f.record("weaponRef",entity),addLight:light=>f.record("weaponLight",light),addLoopSound:unavailable,
          startSound:(origin,entity,channel,sound)=>{f.record("weaponSound",origin,entity,channel);if(sound!==null)f.audio.startSound(sound,{entity,channel,origin:{kind:"fixed",position:vec3(0,0,0)},volume:127});}});
        const runtime=new ClientEventRuntime(f.state,{...f.host,weapons});f.entity.currentState.weapon=Weapon.WP_ROCKET_LAUNCHER;f.entity.currentState.event=EntityEvent.EV_FIRE_WEAPON;
        await runtime.entityEvent(f.entity,f.entity.lerpOrigin);expect(f.entity.muzzleFlashTime).toBe(1100);
        expect(f.calls.filter(call=>call.kind==="weaponSound")).toEqual([{kind:"weaponSound",args:[null,1,2]}]);
        expect(f.audio.mix(2048).some(sample=>sample!==0)).toBe(true);
      } finally { commands?.close("discard"); target.close(); cinematics.dispose(); }
    }
  });
  test("both-product event smoke reaches actual local-entity playback and retail CPU rendering",async()=>{
    for(const product of ["baseq3","missionpack"] satisfies Product[]){
      const f=fixture(product),vfs=await VirtualFileSystem.openInspection({dataPath:process.env["Q3_DATA"]??"/home/buzzkill/Projects/qfiles/q3a", homePath: process.env["Q3_DATA"]??"/home/buzzkill/Projects/qfiles/q3a", cdPath: null,product});
      const images = new RendererImageCatalog();
      const window = process.env["QUAKE_GL_TEST"] === "1" ? SdlWindow.open({ title: "Cgame event smoke", width: 128, height: 96, backend: "gl", hidden: true }) : null;
      const gl = window === null ? null : new GlRenderer(window, images);
      const settings = createRendererSettings();
      gl?.initializeDefaultState(settings.maxActiveTextures !== 0, () => {
        if (!images.setTextureMode(settings.textureMode.value)) settings.warnBadTextureMode();
      });
      const renderer = new SoftwareRenderer(128, 96, images, gl?.subpixelBits), recording = new BatchRecordingBackend(renderer);
      const target = new RenderTarget(images, gl === null ? [recording] : [recording, gl]);
      const builtins = new BuiltinImages(images, identityImageUploadProfile), clock = { milliseconds: () => 1350 };
      const cinematics = new EngineCinematics({ temporaryMemory: new HunkArena(1024 * 1024, () => undefined), developerPrint: () => undefined, print: text => { f.host.print(text); return undefined; }, files: { kind: "diagnostic-bytes", reader: vfs }, sound: { kind: "diagnostic", readMixer: () => f.audio }, clock: { sample: clock.milliseconds }, scratchImages: builtins,
        console: { kind: "absent" }, settings: { inGameVideo: () => 1, hardware: "generic", maxTextureSize: gl?.maxTextureSize ?? 4096 } });
      let commands: RenderCommandBuffer | null = null;
      try {
        const resources = await RendererResources.create(vfs, { kind: "unaccounted" }, settings, { patchMemory: { kind: "diagnostic" }, print: text => { f.host.print(text); }, imageProfile: identityImageUploadProfile, target, images, builtins, drawDebugSurface: () => { throw new Error("Diagnostic renderer has no collision debug surface provider"); }, shaderCinematics: cinematics.shaderCinematics });
        commands = new RenderCommandBuffer(target, { print: (text: string) => { throw new Error(`Unexpected renderer diagnostic: ${text}`); }, clock, identityLight: 1, tess: resources.tess, runtime: settings.runtime });
        const shader=await resources.registerShader("smokePuff");
        const host:ClientEventHost={...f.host,media:{...f.media,smokePuffShader:shader}};
        const runtime=new ClientEventRuntime(f.state,host);f.entity.currentState.event=EntityEvent.EV_JUMP_PAD;
        await runtime.entityEvent(f.entity,f.entity.lerpOrigin);expect(f.pool.activeCount).toBe(1);
        const camera=vec3(100,0,0),scene=f.locals.collectEntities({time:1350,frameTime:16,viewOrigin:camera});
        expect(scene.entities).toHaveLength(1);const ref=scene.entities[0];if(ref===undefined||ref.kind!=="sprite")throw new Error("Expected event smoke sprite");
        expect(ref.customShader).toBe(shader);expect(ref.radius).toBe(32);expect(ref.origin).toEqual(vec3(7,8,9.25));
        const refdef=createRefdef();refdef.width=128;refdef.height=96;refdef.fovX=90;refdef.fovY=Math.atan(96/128)*360/Math.PI;
        refdef.viewOrigin=camera;refdef.viewAxis=anglesToAxis(vec3(0,180,0));refdef.time=1350;refdef.renderFlags=RDF_NOWORLDMODEL;
        commands.addView({ viewport: { x: 0, y: 0, width: 128, height: 96 }, clear: { stencil: false, depth: 1, color: vec4(0, 0, 0, 1) }, operations: [{ kind: "draw", batches: [] }] });
        commands.addPreparedViews(resources.prepareFrame({refdef,entities:scene.entities,dynamicLights:scene.dynamicLights}));
        commands.submit();
        expect(recording.trace().flatMap(view => view.batches).length).toBeGreaterThan(0);
        expect(renderer.pixels.filter((value,index)=>index%4!==3&&value>0).length).toBeGreaterThan(100);
        if (gl !== null) expect(gl.readPixels().filter((value,index)=>index%4!==3&&value>0).length).toBeGreaterThan(100);
        f.locals.collectEntities({time:2100,frameTime:16,viewOrigin:camera});expect(f.pool.activeCount).toBe(0);
      } finally { commands?.close("discard"); target.close(); cinematics.dispose(); window?.close(); }
    }
  });
  test("missionpack events allocate the real lightning, kamikaze, obelisk and invulnerability records",async ()=>{
    const f=fixture("missionpack");
    for(const event of [EntityEvent.EV_LIGHTNINGBOLT,EntityEvent.EV_KAMIKAZE,EntityEvent.EV_OBELISKEXPLODE,EntityEvent.EV_INVUL_IMPACT,EntityEvent.EV_JUICED])await f.event(event);
    expect(f.pool.activeCount).toBe(5);
    const scene=f.locals.collectEntities({time:1100,frameTime:0,viewOrigin:vec3(100,0,0)});
    expect(scene.entities.some(entity=>entity.kind==="lightning")).toBe(true);
    expect(scene.dynamicLights.some(light=>light.radius===300)).toBe(true);
  });
  test("every product item uses source pickup media and local autoswitch rules",async ()=>{
    for(const product of ["baseq3","missionpack"] satisfies Product[])for(const [index,item] of itemList(product).entries()){
      if(index===0)continue;const f=fixture(product);f.entity.currentState.number=0;await f.event(19,index);
      expect(f.state.itemPickup).toBe(index);expect(f.state.itemPickupTime).toBe(1100);expect(f.state.itemPickupBlendTime).toBe(1100);
      expect(f.state.weaponSelect).toBe(item.type===ItemType.IT_WEAPON&&item.tag!==Weapon.WP_MACHINEGUN?item.tag:0);
      if(item.type===ItemType.IT_POWERUP||item.type===ItemType.IT_TEAM)expect(f.sounds()[0]?.[3]).toBe("n_healthSound");
      else if(item.type!==ItemType.IT_PERSISTANT_POWERUP)expect(f.sounds()[0]?.[3]).toBe(item.pickupSound);
      f.calls.length=0;await f.event(20,index);expect(f.sounds()).toEqual(item.pickupSound===null?[]:[[null,0,0,item.pickupSound]]);
    }
  });
  test("invalid pickup indices ignore; disabled autoswitch and remote pickups leave weapon selection alone",async ()=>{
    const f=fixture();for(const i of [0,-1,999])await f.event(19,i);expect(f.calls).toHaveLength(0);
    f.options.autoswitch=false;f.entity.currentState.number=0;await f.event(19,12);expect(f.state.weaponSelect).toBe(0);
    f.state.itemPickup=0;f.entity.currentState.number=1;await f.event(19,12);expect(f.state.itemPickup).toBe(0);
  });
  test("holdables preserve messages, usage timestamps, source off-by-one fatal and remote fallback",async ()=>{
    for(const product of ["baseq3","missionpack"] satisfies Product[]){
      const f=fixture(product),y=product==="baseq3"?143:144;f.entity.currentState.number=0;await f.event(24);expect(f.calls[0]).toEqual({kind:"center",args:["No item to use",y,16]});
      f.calls.length=0;await f.event(25);expect(f.calls).toEqual([{kind:"center",args:["Use Personal Teleporter",y,16]}]);
      await f.event(26);expect(f.host.clientInfo(1).medkitUsageTime).toBe(1100);expect(f.sounds().at(-1)?.[3]).toBe("medkitSound");
      await expect(f.event(30)).rejects.toThrow("HoldableItem not found");f.entity.currentState.number=1;await f.event(30);expect(f.sounds().at(-1)?.[3]).toBe("useNothingSound");
      f.entity.currentState.number=0;await f.event(31);expect(f.calls.at(-2)).toEqual({kind:"center",args:["No item to use",y,16]});
    }
  });
  test("weapon dispatch preserves target fields, no-mark rail rule, and unread flesh normal",async ()=>{
    const f=fixture();f.entity.currentState.weapon=Weapon.WP_ROCKET_LAUNCHER;f.entity.currentState.otherEntityNum=6;
    await f.event(21);expect(f.calls).toHaveLength(0);f.entity.currentState.number=0;await f.event(21);await f.event(23);expect(f.calls.map(c=>c.kind)).toEqual(["noammo","fire"]);
    f.calls.length=0;await f.event(50,5);expect(f.calls[0]?.args).toEqual([5,vec3(90,80,70),vec3(0,0,1),6]);
    f.calls.length=0;f.entity.currentState.origin2=vec3(1,2,3);await f.event(53,255);expect(f.calls.map(c=>c.kind)).toEqual(["rail"]);expect(f.entity.currentState.weapon).toBe(7);
    f.calls.length=0;await f.event(53,5);expect(f.calls.map(c=>c.kind)).toEqual(["rail","hitWall"]);
    f.calls.length=0;await f.event(48,9);expect(f.calls[0]?.args).toEqual([vec3(10,20,30),6,{kind:"flesh",entityNum:9}]);
    await f.event(49,5);expect(f.calls[1]?.args).toEqual([vec3(10,20,30),6,{kind:"wall",normal:vec3(0,0,1)}]);
    await f.event(54);expect(f.calls[2]?.kind).toBe("shotgun");
  });
  test("sounds, powerups, gib flags, loop mutation and real beam rendering keep semantic ordering",async ()=>{
    const f=fixture();await f.event(45,1);await f.event(46,0);expect(f.sounds()).toEqual([[null,1,3,"registered"],[null,0,0,"config0"]]);
    f.entity.currentState.number=0;for(const [event,powerup] of [[61,1],[62,2],[63,5]] satisfies [number,number][]){await f.event(event);expect(f.state.powerupActive).toBe(powerup);expect(f.state.powerupTime).toBe(1100);}
    f.calls.length=0;f.entity.currentState.eFlags=512;await f.event(64);expect(f.calls.map(c=>c.kind)).toEqual(["gib"]);
    f.entity.currentState.loopSound=17;await f.event(75);expect(f.entity.currentState.loopSound).toBe(0);await f.event(74);expect(f.calls.at(-1)?.kind).toBe("ref");
    f.calls.length=0;await f.event(42);expect(f.calls.map(c=>c.kind)).toEqual(["sound","spawn"]);await f.event(40);expect(f.entity.miscTime).toBe(1100);
  });
  test("missionpack-only events and voice commands dispatch with source arguments; base rejects them",async ()=>{
    const f=fixture("missionpack");for(const event of [66,67,68,69,70,71,72,73,77,78,79,80,81,82]){await f.event(event,5);await expect(fixture().event(event,5)).rejects.toThrow("Unknown event");}
    expect(f.calls.filter(c=>c.kind==="voice").map(c=>c.args)).toEqual(["yes","no","followme","ongetflag","ondefense","onpatrol"].map(command=>[1,false,1,53,command]));
    for(const [parm,name] of [[0,"wstbimpdSound"],[4096,"wstbimpmSound"],[4160,"wstbimplSound"]] satisfies [number,string][]){await f.event(66,parm);expect(f.sounds().at(-1)?.[3]).toBe(name);}
  });
});

describe("obituaries and team announcements",()=>{
  test("score/lead/base-attack announcements and kamikaze use source queues and channels",async ()=>{
    for(const product of ["baseq3","missionpack"] satisfies Product[]){
      const f=fixture(product);await f.event(47,6);await f.event(47,7);
      expect(f.calls).toEqual([{kind:"buffer",args:["yourBaseIsUnderAttackSound"]}]);
      f.calls.length=0;for(const event of [8,9,10,11,12])await f.event(47,event);
      expect(f.calls.map(call=>call.args[0])).toEqual(["redScoredSound","blueScoredSound","redLeadsSound","blueLeadsSound","teamsTiedSound"]);
      f.calls.length=0;await f.event(47,13);await f.event(47,999);
      expect(f.calls).toEqual(product==="missionpack"?[{kind:"local",args:["kamikazeFarSound",7]}]:[]);
    }
  });
  test("debug output and invalid client fallback follow source ordering",async ()=>{
    const f=fixture();f.options.debugEvents=true;f.entity.currentState.clientNum=999;await f.event(0);
    expect(f.calls).toEqual([{kind:"print",args:["ent:  1  event:  0 "]},{kind:"print",args:["ZEROEVENT\n"]}]);
    f.calls.length=0;await f.event(10);expect(f.state.landChange).toBe(-8);
    expect(f.calls.slice(0,2)).toEqual([{kind:"print",args:["ent:  1  event: 10 "]},{kind:"print",args:["EV_FALL_SHORT\n"]}]);
    f.calls.length=0;await expect(f.event(39)).rejects.toThrow("Unknown event");expect(f.calls.at(-1)).toEqual({kind:"print",args:["UNKNOWN\n"]});
    await expect(f.event(45,256)).rejects.toThrow("game sound index");
  });
  test("shipped QVM opcode/string anchors prove product-specific center-print constants",async()=>{
    // Evidence extraction only, not a VM runtime. Pinned q3lcc emits 143 for both;
    // native C emits 144 for both. Neither describes both shipped products.
    for(const product of ["baseq3","missionpack"] satisfies Product[]){
      const vfs=await VirtualFileSystem.openInspection({dataPath:process.env["Q3_DATA"]??"/home/buzzkill/Projects/qfiles/q3a", homePath: process.env["Q3_DATA"]??"/home/buzzkill/Projects/qfiles/q3a", cdPath: null,product});
      const bytes=await vfs.read("vm/cgame.qvm"),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      expect(view.getUint32(0,true)).toBe(0x12721444);
      const instructions:{op:number;value:number|null}[]=[];let cursor=view.getInt32(8,true);
      const count=view.getInt32(4,true),codeEnd=cursor+view.getInt32(12,true);
      for(let i=0;i<count;i++){
        const op=view.getUint8(cursor++);let value:number|null=null;
        if(op===3||op===4||op===8||op===9||(op>=11&&op<=26)||op===34){value=view.getInt32(cursor,true);cursor+=4;}
        else if(op===33)value=view.getUint8(cursor++);
        instructions.push({op,value});
      }
      expect(cursor).toBeLessThanOrEqual(codeEnd);
      const data=bytes.subarray(view.getInt32(16,true));
      function anchoredFunction(text:string,length:number):{start:number;length:number}{
        const pattern=new TextEncoder().encode(text),addresses:number[]=[];
        for(let i=0;i<=data.length-pattern.length;i++)if(pattern.every((byte,j)=>data[i+j]===byte))addresses.push(i);
        const starts=new Set<number>();
        for(let i=0;i<instructions.length;i++){
          const instruction=instructions[i];if(instruction===undefined||instruction.op!==8||instruction.value===null||!addresses.includes(instruction.value))continue;
          let start=i;while(start>0&&instructions[start]?.op!==3)start--;
          let end=start+1;while(end<instructions.length&&instructions[end]?.op!==3)end++;
          if(end-start===length)starts.add(start);
        }
        expect(starts.size).toBe(1);const start=starts.values().next().value;if(start===undefined)throw new Error("Missing retail function anchor");
        let end=start+1;while(end<instructions.length&&instructions[end]?.op!==3)end++;return {start,length:end-start};
      }
      const use=anchoredFunction("No item to use",product==="baseq3"?164:182),obituary=anchoredFunction("You fragged %s",product==="baseq3"?604:689);
      expect(use).toEqual(product==="baseq3"?{start:42415,length:164}:{start:26079,length:182});
      expect(obituary).toEqual(product==="baseq3"?{start:41811,length:604}:{start:25390,length:689});
      const centers=[use.start+42,use.start+77,product==="baseq3"?42202:25832];
      for(const index of centers){
        expect(instructions[index]).toEqual({op:8,value:product==="baseq3"?143:144});
        expect(instructions[index+1]).toEqual({op:33,value:12});
        expect(instructions[index+2]).toEqual({op:8,value:16});
        expect(instructions[index+3]).toEqual({op:33,value:16});
      }
    }
  });
  test("all source gender/mod obituary combinations agree with captured original C output",async ()=>{
    for(const product of ["baseq3","missionpack"] satisfies Product[]){
      const f=fixture(product),info=f.clients[1];if(info===undefined)throw new Error("Client info");
      const es=f.entity.currentState;es.otherEntityNum=1;
      for(const [genderIndex,gender] of (["male","female","neuter"] satisfies PlayerGender[]).entries()){
        info.gender=gender;es.otherEntityNum2=1;const expected=sourceGolden[product].self[genderIndex];if(expected===undefined)throw new Error("Golden gender");
        for(const [mod,text] of expected.entries()){f.calls.length=0;await f.event(60,mod);expect(f.calls.filter(c=>c.kind==="print").map(c=>c.args[0])).toEqual([text+"\n"]);}
      }
      es.otherEntityNum2=0;for(const [mod,text] of sourceGolden[product].other.entries()){f.calls.length=0;await f.event(60,mod);expect(f.calls.filter(c=>c.kind==="print").map(c=>c.args[0])).toEqual([text+"\n"]);}
    }
  });
  test("every defined source event preserves the recorded post-dispatch state in both products",async ()=>{
    for(const product of ["baseq3","missionpack"] satisfies Product[])for(const row of sourceGolden[product].events){
      const f=fixture(product);f.entity.currentState.weapon=Weapon.WP_ROCKET_LAUNCHER;f.entity.currentState.otherEntityNum=1;
      await f.event(row.event,5);expect([f.entity.player.painTime,Number(f.entity.player.painDirection),f.state.itemPickup,f.state.weaponSelect,f.entity.miscTime,f.entity.currentState.loopSound]).toEqual([...row.state]);
    }
  });
  test("place strings retain source colors, tied flag and 111st quirk",()=>{
    expect([1,2,3,11,12,13,21,22,23,111,0x4001].map(placeString)).toEqual(["^41st^7","^12nd^7","^33rd^7","11th","12th","13th","21st","22nd","23rd","111st","Tied for ^41st^7"]);
  });
  test("local frag text, colored byte truncation and killer name use the snapshot client",async ()=>{
    const f=fixture();f.nameTable[1]="abcdefghijklmnopqrstuvwxyz0123456789";
    const es=f.entity.currentState;es.otherEntityNum=1;es.otherEntityNum2=0;const snap=f.state.snap;if(snap===null)throw new Error("Missing snapshot");snap.playerState.persistant.set(PersistentIndex.PERS_RANK,2);snap.playerState.persistant.set(PersistentIndex.PERS_SCORE,17);
    await f.event(60,6);expect(f.calls).toEqual([{kind:"center",args:["You fragged abcdefghijklmnopqrstuvwxyz012^7\n^33rd^7 place with 17",143,16]},{kind:"print",args:["abcdefghijklmnopqrstuvwxyz012^7 ate Player0^7's rocket\n"]}]);
    es.otherEntityNum=0;es.otherEntityNum2=1;await f.event(60,10);expect(f.state.killerName).toBe("abcdefghijklmnopqrstuvwxyz012^7");
  });
  test("self, world, product-specific grapple and mission camera obituaries match source strings",async ()=>{
    for(const product of ["baseq3","missionpack"] satisfies Product[]){const f=fixture(product),es=f.entity.currentState;es.otherEntityNum=1;es.otherEntityNum2=1;
      await f.event(60,5);expect(f.calls.at(-1)?.args).toEqual(["Player1^7 tripped on his own grenade.\n"]);
      es.otherEntityNum2=1022;await f.event(60,19);expect(f.calls.at(-1)?.args).toEqual(["Player1^7 cratered.\n"]);await f.event(60,0);expect(f.calls.at(-1)?.args).toEqual(["Player1^7 died.\n"]);
      es.otherEntityNum2=0;f.options.singlePlayerActive=true;f.options.cameraOrbit=true;f.calls.length=0;await f.event(60,product==="baseq3"?23:28);
      expect(f.calls.filter(c=>c.kind==="center")).toHaveLength(product==="baseq3"?1:0);expect(f.calls.at(-1)?.args).toEqual(["Player1^7 was caught by Player0^7\n"]);
      f.calls.length = 0;
      const killerName = f.state.killerName;
      for (const target of [-1, 64]) {
        es.otherEntityNum = target;
        const work = f.event(60);
        await expect(work).rejects.toBeInstanceOf(CommonError);
        await expect(work).rejects.toMatchObject({ code: "drop", message: "CG_Obituary: target out of range" });
        expect(f.calls).toHaveLength(0);
        expect(f.state.killerName).toBe(killerName);
      }
    }
  });
  test("team captures/returns/taken announcements cover products, both teams and carrier suppression",async ()=>{
    for(const product of ["baseq3","missionpack"] satisfies Product[])for(const team of [Team.TEAM_RED,Team.TEAM_BLUE,Team.TEAM_SPECTATOR]){
      const f=fixture(product),client=f.clients[0];if(client===undefined)throw new Error("Client");client.team=team;
      for(const event of [0,1,2,3]){f.calls.length=0;await f.event(47,event);const yours=team===(event%2===0?Team.TEAM_RED:Team.TEAM_BLUE);expect(f.calls.map(c=>c.args[0])).toEqual(event<2?[yours?"captureYourTeamSound":"captureOpponentSound"]:[yours?"returnYourTeamSound":"returnOpponentSound",event===2?"blueFlagReturnedSound":"redFlagReturnedSound"]);}
      f.options.gameType=GameType.GT_1FCTF;f.calls.length=0;await f.event(47,4);expect(f.calls.map(c=>c.args[0])).toEqual(team===Team.TEAM_SPECTATOR?[]:[product==="missionpack"?(team===Team.TEAM_BLUE?"yourTeamTookTheFlagSound":"enemyTookTheFlagSound"):(team===Team.TEAM_BLUE?"enemyTookYourFlagSound":"yourTeamTookEnemyFlagSound")]);
      const snap=f.state.snap;if(snap===null)throw new Error("Snapshot");snap.playerState.powerups.set(Powerup.PW_NEUTRALFLAG,1);f.calls.length=0;await f.event(47,4);await f.event(47,5);expect(f.calls).toHaveLength(0);
    }
  });
});
