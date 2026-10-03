export type PluginAction = 'mute' | 'deafen' | 'show' | 'expand' | 'collapse';
export interface PluginState {
  authenticated: boolean; connected: boolean; inVoice: boolean;
  roomName: string; memberCount: number; muted: boolean; deafened: boolean; sharing: boolean;
}
export interface PluginBridge {
  getState(): Promise<PluginState>;
  onState(callback: (state: PluginState) => void): () => void;
  action(action: PluginAction): Promise<void>;
}
declare global { interface Window { relinkPlugin: PluginBridge; } }
