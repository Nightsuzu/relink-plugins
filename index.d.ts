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
  getSettings?():Promise<Record<string,boolean|number|string>>;
  updateSettings?(patch:Record<string,boolean|number|string>):Promise<Record<string,boolean|number|string>>;
  onSettings?(callback:(settings:Record<string,boolean|number|string>)=>void):()=>void;
  getState(): Promise<PluginState>;
  onState(callback: (state: PluginState) => void): () => void;
  action(action: PluginAction): Promise<void>;
  /** window.resize; three-stage overlay. Notch is available in game mode only. */
  setDisplayState?(state:'notch'|'compact'|'expanded', transition?:number):Promise<void>;
  /** Optional on older hosts. Finish the matching transition after its final frame; restores idle throttling. */
  completeDisplayTransition?(transition:number):Promise<void>;
  /** Host-filtered outside click/focus loss. Does not expose global input data. */
  onDismiss?(callback:()=>void):()=>void;
  /** Requires window.resize. Optional on older hosts; contains no process identity. */
  getPresentation?(): Promise<{ gameMode: boolean; topInset: number; hoverAllowed?: boolean }>;
  onPresentation?(callback: (presentation: { gameMode: boolean; topInset: number; hoverAllowed?: boolean }) => void): () => void;
  /** API v3, no capability needed. Use it to detect what this Relink supports and degrade gracefully. */
  getHostInfo?(): Promise<HostInfo>;
  /** voice.participants (API v3). The current voice channel only; empty outside a call. */
  getParticipants?(): Promise<Participant[]>;
  /** voice.participants (API v3). Called on every change, at most about 10 times a second. */
  onParticipants?(callback: (participants: Participant[]) => void): () => void;
  /** API v3. A button from the manifest's `commands` was pressed in Relink's call controls. */
  onCommand?(callback: (command: { id: string }) => void): () => void;
  /** net.fetch (API v4). HTTPS to a host in `network` only. Write `{{secret:id}}` in a header value to send a user secret. */
  fetch?(url: string, init?: PluginFetchInit): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  /** net.fetch (API v4). Streams the response text (e.g. server-sent events) to `onChunk`. */
  fetchStream?(url: string, init: PluginFetchInit & { id?: string }, onChunk: (text: string) => void): Promise<{ status: number; headers: Record<string, string> }>;
  /** net.fetch (API v4). Stops a streamed request started with `init.id`. */
  abortFetch?(id: string): Promise<void>;
  /** secrets (API v4). Which declared secrets the user has filled in. Values are never readable. */
  getSecretStatus?(): Promise<Record<string, boolean>>;
  /** chat.read / chat.send (API v4). The open text channel; messages only with chat.read and when the Room owner allows it. */
  getChat?(): Promise<ChatView>;
  onChat?(callback: (chat: ChatView) => void): () => void;
  /** chat.send (API v4). Sent as the user, labelled with this plugin's name, 1–4000 characters. Resolves once the server stored it.
   *  `pending: true` starts a streamed answer shown as "generating" until `editChat` finishes it; `format: 'markdown'` renders a safe Markdown subset. */
  sendChat?(value: { text: string; replyTo?: string; format?: 'text' | 'markdown'; pending?: boolean }): Promise<{ id?: string }>;
  /** chat.send (API v4). Rewrites a message this plugin sent, within 15 minutes. Calls are merged to about one every 0.8 s; the newest text wins.
   *  Leave `pending` out (or false) on the last update; changes after that show "edited". */
  editChat?(value: { id: string; text: string; pending?: boolean }): Promise<void>;
  /** chat.send (API v4). Withdraws a message this plugin sent, within 15 minutes. */
  deleteChat?(id: string): Promise<void>;
  /** chat.read (API v4). What changed in the open channel, so the plugin need not compare snapshots. Only while the Room owner allows reading,
   *  except `channel`, which plugins with chat.send also get. */
  onChatEvent?(callback: (event: ChatEvent) => void): () => void;
  /** chat.history (API v4, with chat.read). The Room's text channels this person can open now. */
  getChatChannels?(): Promise<{ id: string; name: string; current: boolean }[]>;
  /** chat.history (API v4). Older messages, newest last: up to 50 before `before` (a message's `at`). Covers what Relink has loaded, at most 500 messages per Room. */
  getChatHistory?(query?: { channelId?: string; before?: string; limit?: number }): Promise<{ channel: { id: string; name: string }; messages: ChatMessage[]; hasMore: boolean }>;
  /** voice.participants (API v4). Someone joined or left the voice channel; joining or leaving a call yourself is one event about you. */
  onVoiceEvent?(callback: (event: { type: 'join' | 'leave'; member: { id: string; name: string; self: boolean } }) => void): () => void;
  /** chat.commands (API v4). The user typed `/name args` for one of this plugin's `chatCommands`; nothing reached the channel. */
  onChatCommand?(callback: (command: { name: string; args: string; channel: { id: string; name: string } | null }) => void): () => void;
  /** notify (API v4). A system notification, at most 6 a minute. */
  notify?(value: { title: string; body?: string; silent?: boolean }): Promise<boolean>;
  /** storage (API v4). Per-plugin JSON values on this computer, 5 MB in total, removed on uninstall. */
  storage?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void>; keys(): Promise<string[]> };
}
export interface PluginFetchInit { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: string }
/** API v4 view of the open text channel. All ids are pseudonyms for this plugin. */
export interface ChatView {
  available: boolean; reason?: string; canSend: boolean;
  channel: { id: string; name: string } | null;
  messages: ChatMessage[];
}
/** One channel message as a plugin sees it. */
export interface ChatMessage {
  id: string; author: { id: string; name: string; self: boolean }; text: string; at: string; replyTo?: string;
  /** Name of the plugin that sent it on someone's behalf. `mine`: this plugin sent it (so it can be edited). */
  plugin?: string; mine?: true;
  likes: number; pinned: boolean; edited: boolean; pending: boolean; format?: 'markdown';
}
export type ChatEvent =
  | { type: 'message' | 'edit' | 'like' | 'pin'; message: ChatMessage }
  | { type: 'withdraw'; id: string }
  | { type: 'channel'; channel: { id: string; name: string } | null };
/** API v3 host description. Contains no account, device or process identity. */
export interface HostInfo {
  apiVersion: number; supportedApiVersions: number[]; client: string;
  /** Which surface this page is: the desktop overlay window or the panel inside Relink. */
  surface: 'overlay' | 'panel' | 'background';
  capabilities: string[]; commands: string[]; panel: boolean;
  /** API v4 */
  background?: boolean; network?: string[]; secrets?: string[]; chatCommands?: string[];
  /** Loaded from a local folder in developer mode (unsigned). */
  developer: boolean;
}
/**
 * One person in the current voice channel (API v3, voice.participants).
 * `id` is a pseudonym: stable while Relink runs, different for every plugin,
 * and never an account or user id. Names are the nicknames shown in Relink.
 */
export interface Participant { id: string; name: string; self: boolean; speaking: boolean; muted: boolean; deafened: boolean }
/** manifest.json. Fields marked v3 need `"apiVersion": 3`; fields marked v4 need `"apiVersion": 4`. */
export interface PluginManifest {
  id: string; name: string; version: string; apiVersion: 1 | 2 | 3 | 4; description: string;
  /** Desktop overlay page. Optional from v3 when the plugin has a `panel`. */
  entry?: string;
  capabilities: ('voice.read' | 'voice.mute' | 'voice.deafen' | 'app.show' | 'window.resize' | 'music.read' | 'music.control' | 'music.lyrics' | 'channels.read' | 'channels.switch' | 'voice.participants' | 'net.fetch' | 'secrets' | 'chat.read' | 'chat.send' | 'chat.commands' | 'chat.history' | 'notify' | 'storage')[];
  author?: { name: string; avatar?: string };
  settings?: ({ key: string; label: string; type: 'toggle'; default: boolean } | { key: string; label: string; type: 'range'; default: number; min: number; max: number; step: number }
    /** API v4: free text (prompts, model names). The plugin reads it as is; keys belong in `secrets`. */
    | { key: string; label: string; type: 'text' | 'textarea'; default: string; maxLength?: number; placeholder?: string }
    /** API v4: one of 2–20 options. */
    | { key: string; label: string; type: 'select'; default: string; options: { value: string; label: string }[] })[];
  /** v3: up to 4 buttons in the call controls' plugin menu. Icons are SVG assets up to 16 KiB. */
  commands?: { id: string; title: string; icon?: string }[];
  /** v3: a tab in the voice page's right column, beside the channel chat. Title up to 12 characters. */
  panel?: { entry: string; title: string };
  /** v4: an invisible page that runs while the plugin is enabled. */
  background?: string;
  /** v4 with net.fetch: 1–8 public hostnames, e.g. "api.deepseek.com". */
  network?: string[];
  /** v4 with secrets: up to 4 values the user types in settings, e.g. an API key. */
  secrets?: { id: string; label: string }[];
  /** v4 with chat.commands: up to 8 `/name` commands for the chat composer. */
  chatCommands?: { name: string; description: string }[];
}
export interface MusicSession {
  id:string;current:boolean;source:'qqmusic'|'netease'|'soda';track:string;title:string;artist:string;album:string;
  cover:string;playing:boolean;positionMs:number;durationMs:number;
  controls:Record<'play'|'pause'|'next'|'previous',boolean>;
  lyrics:{status:'idle'|'loading'|'disabled'|'unavailable'|'instrumental'|'synced';source?:'LRCLIB';lines:{time:number;text:string}[]};
}
declare global { interface Window { relinkPlugin: PluginBridge; } }
