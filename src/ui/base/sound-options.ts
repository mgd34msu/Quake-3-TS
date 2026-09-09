// Sound options from id Software q3_ui/ui_sound.c. GPL-2.0-or-later.
import { UI_CENTER, UI_RIGHT } from "../../render/font.ts";
import { addItem, forceMenuOff, popMenu, pushMenu, setCursorToItem } from "./framework.ts";
import { BaseMenu, COLORS, MenuCommon, MenuEvent, MenuFlag } from "./state.ts";
import type { BaseMenuItem, BaseUiState, MenuBanner, MenuBitmap, MenuCallback, MenuProportional, MenuSlider, MenuSpin } from "./state.ts";

const FRAME_LEFT="menu/art/frame2_l", FRAME_RIGHT="menu/art/frame1_r", BACK="menu/art/back_0", BACK_FOCUS="menu/art/back_1";
const QUALITY_ITEMS:readonly string[]=["Low","High"];
const f=Math.fround;
enum SoundId { Graphics=10, Display=11, Sound=12, Network=13, Effects=14, Music=15, Quality=16, Back=18 }
export interface BaseSoundOptionsNavigation {
  graphics():Promise<void>;
  display():Promise<void>;
  network():Promise<void>;
}

function bitmap():MenuBitmap {
  return {kind:"bitmap",common:new MenuCommon(),focuspic:null,errorpic:null,shader:null,focusshader:null,width:0,height:0,focuscolor:null};
}
function proportional():MenuProportional {
  return {kind:"proportional",common:new MenuCommon(),text:null,color:COLORS.white,style:0};
}
function slider():MenuSlider {return {kind:"slider",common:new MenuCommon(),minvalue:0,maxvalue:0,curvalue:0,range:0};}
class SoundRecord {
  readonly menu=new BaseMenu();
  readonly banner:MenuBanner={kind:"banner",common:new MenuCommon(),text:null,color:COLORS.white,style:0};
  readonly frameLeft=bitmap();readonly frameRight=bitmap();
  readonly graphics=proportional();readonly display=proportional();readonly sound=proportional();readonly network=proportional();
  readonly effects=slider();readonly music=slider();
  readonly quality:MenuSpin={kind:"spin",common:new MenuCommon(),oldvalue:0,curvalue:0,numitems:0,top:0,itemnames:[],width:0,height:0,columns:0,separation:0};
  readonly back=bitmap();
  reset():void {
    this.menu.cursor=0;this.menu.cursorPrev=0;this.menu.itemCount=0;this.menu.items.length=0;
    this.menu.draw=null;this.menu.key=null;this.menu.wrapAround=false;this.menu.fullscreen=false;this.menu.showlogo=false;
    for(const item of [this.banner,this.graphics,this.display,this.sound,this.network]){
      Object.assign(item.common,new MenuCommon());item.text=null;item.color=COLORS.white;item.style=0;
    }
    for(const item of [this.frameLeft,this.frameRight,this.back]){
      Object.assign(item.common,new MenuCommon());item.focuspic=null;item.errorpic=null;item.shader=null;item.focusshader=null;
      item.width=0;item.height=0;item.focuscolor=null;
    }
    for(const item of [this.effects,this.music]){
      Object.assign(item.common,new MenuCommon());item.minvalue=0;item.maxvalue=0;item.curvalue=0;item.range=0;
    }
    Object.assign(this.quality.common,new MenuCommon());this.quality.oldvalue=0;this.quality.curvalue=0;this.quality.numitems=0;
    this.quality.top=0;this.quality.itemnames=[];this.quality.width=0;this.quality.height=0;this.quality.columns=0;this.quality.separation=0;
  }
}
export class BaseSoundOptionsMenu {
  private readonly record=new SoundRecord();
  private readonly callback:MenuCallback=(item,event)=>this.event(item,event);
  constructor(readonly state:BaseUiState,private readonly navigation:BaseSoundOptionsNavigation){}
  get menu():BaseMenu{return this.record.menu;}
  private variable(name:string):number {
    const value=this.state.services.cvars.registry.get(name);
    return value===undefined?0:value.numericValue;
  }
  private setValue(name:string,value:number):void {
    this.state.assertActive();
    this.state.services.cvars.registry.setValue(name,value);
  }
  private async event(item:BaseMenuItem,event:MenuEvent):Promise<void> {
    this.state.assertActive();if(event!==MenuEvent.Activated)return;
    switch(item.common.id){
      case SoundId.Graphics:
        await popMenu(this.state);this.state.assertActive();await this.navigation.graphics();this.state.assertActive();break;
      case SoundId.Display:
        await popMenu(this.state);this.state.assertActive();await this.navigation.display();this.state.assertActive();break;
      case SoundId.Sound:break;
      case SoundId.Network:
        await popMenu(this.state);this.state.assertActive();await this.navigation.network();this.state.assertActive();break;
      case SoundId.Effects:this.setValue("s_volume",f(f(this.record.effects.curvalue)/10));break;
      case SoundId.Music:this.setValue("s_musicvolume",f(f(this.record.music.curvalue)/10));break;
      case SoundId.Quality:
        if(this.record.quality.curvalue!==0){this.setValue("s_khz",22);this.setValue("s_compression",0);}
        else {this.setValue("s_khz",11);this.setValue("s_compression",1);}
        await forceMenuOff(this.state);this.state.assertActive();
        this.state.services.consoleCommands.append("snd_restart\n");break;
      case SoundId.Back:await popMenu(this.state);this.state.assertActive();break;
    }
  }
  async cache():Promise<void> {
    this.state.assertActive();
    for(const name of [FRAME_LEFT,FRAME_RIGHT,BACK,BACK_FOCUS]){
      await this.state.services.resources.registerShaderNoMip(name);this.state.assertActive();
    }
  }
  private async initialize():Promise<void> {
    this.state.assertActive();const r=this.record;r.reset();await this.cache();this.state.assertActive();
    r.menu.wrapAround=true;r.menu.fullscreen=true;
    r.banner.common.flags=MenuFlag.CenterJustify;r.banner.common.x=320;r.banner.common.y=16;
    r.banner.text="SYSTEM SETUP";r.banner.color=COLORS.white;r.banner.style=UI_CENTER;
    r.frameLeft.common.name=FRAME_LEFT;r.frameLeft.common.flags=MenuFlag.Inactive;r.frameLeft.common.x=0;r.frameLeft.common.y=78;r.frameLeft.width=256;r.frameLeft.height=329;
    r.frameRight.common.name=FRAME_RIGHT;r.frameRight.common.flags=MenuFlag.Inactive;r.frameRight.common.x=376;r.frameRight.common.y=76;r.frameRight.width=256;r.frameRight.height=334;
    const tabs:readonly (readonly [MenuProportional,SoundId,string,number])[]=[
      [r.graphics,SoundId.Graphics,"GRAPHICS",186],[r.display,SoundId.Display,"DISPLAY",213],
      [r.sound,SoundId.Sound,"SOUND",240],[r.network,SoundId.Network,"NETWORK",267],
    ];
    for(const [item,id,text,y] of tabs){
      item.common.flags=MenuFlag.RightJustify|(id===SoundId.Sound?0:MenuFlag.PulseIfFocus);
      item.common.id=id;item.common.callback=this.callback;item.common.x=216;item.common.y=y;item.text=text;item.style=UI_RIGHT;item.color=COLORS.red;
    }
    const sliders:readonly (readonly [MenuSlider,SoundId,string,number])[]=[
      [r.effects,SoundId.Effects,"Effects Volume:",213],[r.music,SoundId.Music,"Music Volume:",231],
    ];
    for(const [item,id,name,y] of sliders){
      item.common.name=name;item.common.flags=MenuFlag.PulseIfFocus|MenuFlag.SmallFont;item.common.callback=this.callback;
      item.common.id=id;item.common.x=400;item.common.y=y;item.minvalue=0;item.maxvalue=10;
    }
    r.quality.common.name="Sound Quality:";r.quality.common.flags=MenuFlag.PulseIfFocus|MenuFlag.SmallFont;r.quality.common.callback=this.callback;
    r.quality.common.id=SoundId.Quality;r.quality.common.x=400;r.quality.common.y=249;r.quality.itemnames=QUALITY_ITEMS;
    r.back.common.name=BACK;r.back.common.flags=MenuFlag.LeftJustify|MenuFlag.PulseIfFocus;r.back.common.callback=this.callback;
    r.back.common.id=SoundId.Back;r.back.common.x=0;r.back.common.y=416;r.back.width=128;r.back.height=64;r.back.focuspic=BACK_FOCUS;
    for(const item of [r.banner,r.frameLeft,r.frameRight,r.graphics,r.display,r.sound,r.network,r.effects,r.music,r.quality,r.back])addItem(this.state,r.menu,item);
    r.effects.curvalue=f(this.variable("s_volume")*10);
    r.music.curvalue=f(this.variable("s_musicvolume")*10);
    r.quality.curvalue=this.variable("s_compression")===0?1:0;
  }
  async show():Promise<void> {
    await this.initialize();this.state.assertActive();await pushMenu(this.state,this.record.menu);this.state.assertActive();
    await setCursorToItem(this.state,this.record.menu,this.record.sound);this.state.assertActive();
  }
}
