import type { WebSocket } from 'ws';
import type { ClientInfo, ClientMessage } from './types.js';
import { LOST_ALLY_ANCHOR_MS, type TieredRoomClient } from './volumes.js';

const SERVER_EPOCH = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

/** Outcome of a `join`. `evicted` is set when the name was already taken. */
export interface JoinResult {
  /** Peer names already in the room, excluding any entry this join evicted. */
  peers: string[];
  /** The previous holder of this name, already removed from room state. */
  evicted?: ClientInfo;
}

export class RoomManager {
  /** roomId → set of ClientInfo */
  private rooms = new Map<string, ClientInfo[]>();
  /** ws → ClientInfo (for fast lookup on disconnect) */
  private clients = new Map<WebSocket, ClientInfo>();
  /** roomId → when a shared RESET was last relayed there. */
  private roomResetMs = new Map<string, number>();
  /** roomId → name → when that player last had one relayed. Kept per name,
   *  not per connection, so reconnecting does not reset it. */
  private senderResetMs = new Map<string, Map<string, number>>();
  private roomHosts = new Map<string, string>();
  private hostOptions = new Map<string, ClientMessage['options']>();
  private chaosRangeUntil = new Map<string, number>();
  private chaosEvents = new Map<string, Array<{ seq: number; id: string; startedAt: number; endsAt: number; instant?: boolean }>>();
  private chaosNextAt = new Map<string, number>();
  private revisions = new Map<string, number>();
  private chaosSequences = new Map<string, number>();

  private bumpRevision(roomId: string): number {
    const revision = (this.revisions.get(roomId) ?? 0) + 1;
    this.revisions.set(roomId, revision);
    return revision;
  }

  /**
   * Add a client to a room. Returns the existing peer names (before this join)
   * plus any client evicted because it held the same name.
   *
   * `team` is v0.3+ — when omitted the client is treated as legacy v0.2 and
   * `computeTieredVolumes` falls back to team-blind 1200u behavior.
   */
  join(roomId: string, name: string, ws: WebSocket, team?: 'ORDER' | 'CHAOS'): JoinResult {
    const existing = this.rooms.get(roomId) ?? [];

    // One entry per name per room is an invariant the rest of this file relies
    // on: `findInRoom` resolves the FIRST match, so a second entry under a name
    // black-holes every `signal` addressed to it. The newest socket wins —
    // duplicates come from a player reconnecting, whose previous socket is by
    // then half-open and cannot be distinguished from a live one in time.
    // Removing the old entry here (rather than on its eventual close) is what
    // stops that close from broadcasting a `peer_left` for a name that is
    // still in the room: `leave` will find nothing to remove.
    let evicted: ClientInfo | undefined;
    const dupIdx = existing.findIndex(c => c.name === name);
    if (dupIdx !== -1) {
      evicted = existing[dupIdx];
      existing.splice(dupIdx, 1);
      this.clients.delete(evicted.ws);
    }

    const existingNames = existing.map(c => c.name);

    const info: ClientInfo = {
      roomId,
      name,
      ws,
      // Carry the evicted entry's state forward: a reconnecting player keeps
      // their last known position and team, so cross-team peers don't lose
      // them from the volume response for the tick before the first `coords`.
      team: team ?? evicted?.team,
      position: evicted?.position,
      camera: evicted?.camera,
      lastSeen: evicted?.lastSeen,
      voiceLevel: evicted?.voiceLevel ?? 0,
      isDead: evicted?.isDead === true,
    };
    existing.push(info);
    this.rooms.set(roomId, existing);
    if (!this.roomHosts.has(roomId)) this.roomHosts.set(roomId, name);
    this.clients.set(ws, info);

    return { peers: existingNames, evicted };
  }

  /**
   * Remove a client. Returns their info plus the clients still in the room
   * (empty when that was the last one), or undefined if the ws held no entry —
   * which is also the case for a socket that was evicted by a later join.
   */
  leave(ws: WebSocket): { roomId: string; name: string; remaining: ClientInfo[] } | undefined {
    const info = this.clients.get(ws);
    if (!info) return undefined;

    this.clients.delete(ws);

    const room = this.rooms.get(info.roomId);
    let remaining: ClientInfo[] = [];
    if (room) {
      const idx = room.indexOf(info);
      if (idx !== -1) room.splice(idx, 1);
      if (room.length === 0) {
        this.rooms.delete(info.roomId);
        this.roomResetMs.delete(info.roomId);
        this.senderResetMs.delete(info.roomId);
        this.roomHosts.delete(info.roomId);
        this.hostOptions.delete(info.roomId);
        this.chaosRangeUntil.delete(info.roomId);
        this.chaosEvents.delete(info.roomId);
        this.chaosNextAt.delete(info.roomId);
        this.revisions.delete(info.roomId);
        this.chaosSequences.delete(info.roomId);
      } else {
        remaining = room.slice();
        if (this.roomHosts.get(info.roomId) === info.name) this.roomHosts.set(info.roomId, remaining[0].name);
      }
    }

    return { roomId: info.roomId, name: info.name, remaining };
  }

  /** Get all peer names in a room. */
  getPeers(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    return room ? room.map(c => c.name) : [];
  }

  /** Get all other clients in the same room (excludes the given ws). */
  getOthersInRoom(ws: WebSocket): ClientInfo[] {
    const info = this.clients.get(ws);
    if (!info) return [];
    const room = this.rooms.get(info.roomId);
    if (!room) return [];
    return room.filter(c => c.ws !== ws);
  }

  /**
   * Find a specific client in a room by name. Names are unique within a room
   * (see `join`), so the first match is the only one.
   */
  findInRoom(roomId: string, name: string): ClientInfo | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    return room.find(c => c.name === name);
  }

  /** Get client info for a WebSocket. */
  getClientInfo(ws: WebSocket): ClientInfo | undefined {
    return this.clients.get(ws);
  }

  roomState(ws: WebSocket): { peers: string[]; host: string | null; isHost: boolean; isPrivate: boolean; options?: ClientMessage['options']; protocolVersion: number; revision: number; serverNow: number; serverEpoch: string; activeChaos: Array<{ seq: number; id: string; startedAt: number; endsAt: number; instant?: boolean }>; chaosNextAt?: number } {
    const me = this.clients.get(ws);
    if (!me) return { peers: [], host: null, isHost: false, isPrivate: false, protocolVersion: 2, revision: 0, serverNow: Date.now(), serverEpoch: SERVER_EPOCH, activeChaos: [] };
    const host = this.roomHosts.get(me.roomId) ?? null;
    return {
      peers: this.getOthersInRoom(ws).map(c => c.name),
      host,
      isHost: host === me.name,
      isPrivate: /^p[a-z0-9_-]{12,48}\./i.test(me.roomId),
      options: this.hostOptions.get(me.roomId),
      protocolVersion: 2,
      revision: this.revisions.get(me.roomId) ?? 0,
      serverNow: Date.now(),
      serverEpoch: SERVER_EPOCH,
      activeChaos: this.getActiveChaos(me.roomId),
      chaosNextAt: this.chaosNextAt.get(me.roomId),
    };
  }

  setHostOptions(ws: WebSocket, raw: ClientMessage['options']): boolean {
    const info = this.clients.get(ws);
    if (!info || !/^p[a-z0-9_-]{12,48}\./i.test(info.roomId) || this.roomHosts.get(info.roomId) !== info.name || !raw) return false;
    const forcedMode = ['inherit', 'nearby', 'camera', 'rift'].includes(raw.forcedMode ?? '') ? raw.forcedMode! : 'inherit';
    const muffling = ['inherit', 'on', 'off'].includes(raw.muffling ?? '') ? raw.muffling! : 'inherit';
    const spatial = ['inherit', 'on', 'off'].includes(raw.spatial ?? '') ? raw.spatial! : 'inherit';
    const trackingFps = [0, 36, 42, 48].includes(raw.trackingFps ?? 0) ? raw.trackingFps ?? 0 : 0;
    const chaosEnabled = raw.chaosEnabled === true;
    const chaosIntervalSec = Math.max(15, Math.min(180, Math.round(Number(raw.chaosIntervalSec) || 45)));
    const chaosDurationScale = Math.max(0.5, Math.min(2, Number(raw.chaosDurationScale) || 1));
    const deadVoiceMode = ['inherit', 'ghosts', 'ghosts-nearby', 'off'].includes(raw.deadVoiceMode ?? '') ? raw.deadVoiceMode! : 'inherit';
    this.hostOptions.set(info.roomId, { forcedMode, muffling, spatial, trackingFps, chaosEnabled, chaosIntervalSec, chaosDurationScale, deadVoiceMode } as ClientMessage['options']);
    if (!chaosEnabled) { this.chaosRangeUntil.delete(info.roomId); this.chaosEvents.delete(info.roomId); this.chaosNextAt.delete(info.roomId); }
    this.bumpRevision(info.roomId);
    return true;
  }

  setChaosEvent(ws: WebSocket, id: string, durationMs: number, instant = false, nextDelayMs = 45_000): { seq: number; id: string; startedAt: number; endsAt: number; instant?: boolean; nextAt: number } | undefined {
    const info = this.clients.get(ws);
    if (!info) return undefined;
    const now = Date.now();
    const active = this.getActiveChaos(info.roomId, now);
    const seq = (this.chaosSequences.get(info.roomId) ?? 0) + 1;
    this.chaosSequences.set(info.roomId, seq);
    const event = { seq, id, startedAt: now, endsAt: now + Math.max(500, Math.min(120_000, durationMs)), ...(instant ? { instant: true } : {}) };
    this.chaosEvents.set(info.roomId, [...active, event]);
    const nextAt = now + Math.max(10_000, Math.min(180_000, nextDelayMs));
    this.chaosNextAt.set(info.roomId, nextAt);
    if (id === 'longrange') this.chaosRangeUntil.set(info.roomId, event.endsAt);
    this.bumpRevision(info.roomId);
    return { ...event, nextAt };
  }
  clearChaosEvent(ws: WebSocket): void { const info = this.clients.get(ws); if (info) { this.chaosRangeUntil.delete(info.roomId); this.chaosEvents.delete(info.roomId); this.chaosNextAt.delete(info.roomId); this.bumpRevision(info.roomId); } }
  getActiveChaos(roomId: string, now = Date.now()): Array<{ seq: number; id: string; startedAt: number; endsAt: number; instant?: boolean }> {
    const active = (this.chaosEvents.get(roomId) ?? []).filter(event => event.endsAt > now);
    if (active.length) this.chaosEvents.set(roomId, active); else this.chaosEvents.delete(roomId);
    if (!active.some(event => event.id === 'longrange')) this.chaosRangeUntil.delete(roomId);
    return active;
  }
  hasChaosLongRange(roomId: string, now = Date.now()): boolean {
    const until = this.chaosRangeUntil.get(roomId) ?? 0;
    if (until <= now) { this.chaosRangeUntil.delete(roomId); return false; }
    return true;
  }

  getHostOptions(roomId: string): ClientMessage['options'] | undefined { return this.hostOptions.get(roomId); }

  /**
   * Update a client's team without re-joining. No-op if the ws isn't in a room.
   * Lets the handler refresh team on a repeated `join` without mutating what
   * `getClientInfo` handed back.
   */
  setTeam(ws: WebSocket, team: 'ORDER' | 'CHAOS'): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.team = team;
  }

  /**
   * Record a client's latest XY position. No-op if the ws isn't in a room.
   */
  setPosition(ws: WebSocket, x: number, y: number): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.position = { x, y, updatedMs: Date.now() };
    info.lastSeen = undefined;
  }

  setVoiceLevel(ws: WebSocket, level: number): void {
    const info = this.clients.get(ws);
    if (info) info.voiceLevel = Math.max(0, Math.min(1, level));
  }

  setDeadState(ws: WebSocket, isDead: boolean): void {
    const info = this.clients.get(ws);
    if (info) info.isDead = isDead;
  }

  /**
   * Record a client's latest camera centre ("voice on camera", #36). No-op if
   * the ws isn't in a room.
   */
  setCamera(ws: WebSocket, x: number, y: number): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.camera = { x, y, updatedMs: Date.now() };
  }

  /** Record whether a client has opted in to shared RESET. No-op if the ws
   *  isn't in a room. */
  setSharedReset(ws: WebSocket, on: boolean): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.sharedReset = on;
  }

  /**
   * When a 'reset_all' was last relayed in a room, and stamp it now if one may
   * be: false while the room is within `cooldownMs` of the last one.
   */
  tryStampRoomReset(roomId: string, now: number, cooldownMs: number): boolean {
    const last = this.roomResetMs.get(roomId);
    if (last !== undefined && now - last < cooldownMs) return false;
    this.roomResetMs.set(roomId, now);
    return true;
  }

  /**
   * Whether `name` in `roomId` may have a shared RESET relayed (none within
   * `cooldownMs`). Only checks: stamp with stampSenderReset once it is.
   */
  senderResetAllowed(roomId: string, name: string, now: number, cooldownMs: number): boolean {
    const last = this.senderResetMs.get(roomId)?.get(name);
    return last === undefined || now - last >= cooldownMs;
  }

  stampSenderReset(roomId: string, name: string, now: number): void {
    let byName = this.senderResetMs.get(roomId);
    if (!byName) {
      byName = new Map();
      this.senderResetMs.set(roomId, byName);
    }
    byName.set(name, now);
  }

  /**
   * Forget a client's camera centre. Called whenever a `coords` arrives
   * WITHOUT one, which is how a client says "voice on camera is off" — so
   * toggling the setting off takes effect on the next position tick rather
   * than after the staleness window.
   */
  clearCamera(ws: WebSocket): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.camera = undefined;
  }

  /**
   * Forget a client's position without disconnecting them. They stay in the
   * room and keep being heard by teammates; cross-team peers stop hearing them
   * at once rather than after the staleness window, because the client has
   * told us the position is no longer true.
   *
   * `seen` is where the client last actually saw itself, if it still stands
   * by that: kept as `lastSeen`, which teammates with ally proximity on are
   * scored against for a short while (computeTieredVolumes). Without it any
   * lastSeen goes too — after a RESET or a respawn the client has said the
   * old place is wrong.
   */
  clearPosition(ws: WebSocket, seen?: { x: number; y: number; agoMs: number }): void {
    const info = this.clients.get(ws);
    if (!info) return;
    info.lastSeen = seen
      ? { x: seen.x, y: seen.y, updatedMs: Date.now() - Math.min(Math.max(0, seen.agoMs), LOST_ALLY_ANCHOR_MS) }
      : undefined;
    info.position = undefined;
    // The camera goes with it. Disowning the position means "I no longer know
    // where I am"; a peer with no position is skipped in scoring anyway, and
    // a leftover camera would only go on advertising the opt-in for a client
    // that has nothing to be scored at.
    info.camera = undefined;
  }

  /**
   * Snapshot of all peer positions in a room, keyed by name. Skips the
   * requester (`exceptName`) and skips entries with no position set yet,
   * or whose position is older than `staleMs`.
   *
   * v0.2 server-side proximity flow: `computeVolumesFromRoom` calls this to
   * get every other peer's most recent reported XY, then computes pairwise
   * distance from the requester's position.
   */
  getRoomPositions(
    roomId: string,
    exceptName: string,
    staleMs: number,
  ): Record<string, { x: number; y: number }> {
    const room = this.rooms.get(roomId);
    if (!room) return {};
    const cutoff = Date.now() - staleMs;
    const out: Record<string, { x: number; y: number }> = {};
    for (const c of room) {
      if (c.name === exceptName) continue;
      if (!c.position) continue;
      if (c.position.updatedMs < cutoff) continue;
      out[c.name] = { x: c.position.x, y: c.position.y };
    }
    return out;
  }

  /**
   * v0.3 — snapshot of all clients in a room with just the fields
   * `computeTieredVolumes` needs (name, team, position). Includes the
   * requester; the function filters itself out by name. No staleness filter
   * here — the caller decides per-peer.
   */
  getRoomClients(roomId: string): TieredRoomClient[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return room.map(c => ({
      name: c.name,
      team: c.team,
      position: c.position,
      camera: c.camera,
      lastSeen: c.lastSeen,
      voiceLevel: c.voiceLevel ?? 0,
      isDead: c.isDead === true,
    }));
  }

  /** Number of active rooms. */
  get roomCount(): number {
    return this.rooms.size;
  }
}
