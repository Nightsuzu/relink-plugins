export type PluginAction = 'mute' | 'deafen' | 'show' | 'expand' | 'collapse';
export interface PluginState {
  authenticated: boolean; connected: boolean; inVoice: boolean;
  roomName: string; memberCount: number; muted: boolean; deafened: boolean; sharing: boolean;
}
export interface PluginBridge {
  /** music.read; lyrics additionally requires music.lyrics. Host owns all network access. */
  getMedia?(): Promise<{available:boolean;activeSource?:string;updatedAt:number;sessions:MusicSession[]}>;
  /** music.control; rejects missing sessions and unsupported player controls. */
  controlMedia?(value:{session:string;track?:string;action:'play'|'pause'|'previous'|'next'}):Promise<void>;
  /** channels.read; current Room only, no member/account identifiers. */
  getChannels?():Promise<{scope:string;channels:{id:string;name:string;current:boolean;locked:boolean}[]}>;
  /** channels.switch; confirmed by the main client's normal join flow. */
  switchChannel?(value:{scope:string;id:string}):Promise<void>;
  getSettings?():Promise<Record<string,boolean|number>>;
  updateSettings?(patch:Record<string,boolean|number>):Promise<Record<string,boolean|number>>;
  onSettings?(callback:(settings:Record<string,boolean|number>)=>void):()=>void;
  getState(): Promise<PluginState>;
  onState(callback: (state: PluginState) => void): () => void;
  action(action: PluginAction): Promise<void>;
  /** window.resize; three-stage overlay. Notch is available in game mode only. */
  setDisplayState?(state:'notch'|'compact'|'expanded'):Promise<void>;
  /** Host-filtered outside click/focus loss. Does not expose global input data. */
  onDismiss?(callback:()=>void):()=>void;
  /** Requires window.resize. Optional on older hosts; contains no process identity. */
  getPresentation?(): Promise<{ gameMode: boolean; topInset: number }>;
  onPresentation?(callback: (presentation: { gameMode: boolean; topInset: number }) => void): () => void;
}
export interface MusicSession {
  id:string;current:boolean;source:'qqmusic'|'netease'|'soda';track:string;title:string;artist:string;album:string;
  cover:string;playing:boolean;positionMs:number;durationMs:number;
  controls:Record<'play'|'pause'|'next'|'previous',boolean>;
  lyrics:{status:'idle'|'loading'|'disabled'|'unavailable'|'instrumental'|'synced';source?:'LRCLIB';lines:{time:number;text:string}[]};
}
declare global { interface Window { relinkPlugin: PluginBridge; } }
