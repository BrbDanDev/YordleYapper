export type ListeningMode = 'nearby' | 'camera' | 'rift';
export interface RoomHostOptions {
  forcedMode: ListeningMode | 'inherit';
  muffling: 'inherit' | 'on' | 'off';
  spatial: 'inherit' | 'on' | 'off';
  trackingFps: 0 | 36 | 42 | 48;
  chaosEnabled?: boolean;
  chaosIntervalSec?: number;
  chaosDurationScale?: number;
  deadVoiceMode?: 'inherit' | 'ghosts' | 'ghosts-nearby' | 'off';
}
export interface RoomChaosEvent { seq: number; id: string; startedAt: number; endsAt: number; instant?: boolean }
export interface RoomState {
  peers: string[];
  host: string | null;
  isHost: boolean;
  isPrivate: boolean;
  options?: RoomHostOptions;
  protocolVersion?: number;
  revision?: number;
  serverNow?: number;
  serverEpoch?: string;
  activeChaos?: RoomChaosEvent[];
  chaosNextAt?: number;
}
