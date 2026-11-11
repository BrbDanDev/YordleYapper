// src/services/volume-client.ts
import { Position } from '../core/types';
import { getServerUrl } from '../core/config';
import { emit } from '@tauri-apps/api/event';

interface VolumeResponse {
  // Always empty in v0.2 — kept on the wire only so older server builds that
  // still echo the field don't break JSON.parse. Client never reads it.
  myBlob?: string;
  peerVolumes: Record<string, number>;
  peerEcho?: Record<string, { mix: number; delay: number }>;
}

export class VolumeClient {
  private lastHealthEmitMs = 0;

  /**
   * v0.2 request: the server reads peer positions from its own room state
   * (populated by `coords` WSS messages from each client), so the request
   * just identifies who we are and where we are. No more peer-to-peer
   * encrypted-blob exchange — see docs/plans/2026-06-02-server-side-positions.md.
   *
   * `allyProximity` opts the caller into hearing teammates by distance (the same
   * falloff as enemies) instead of always-full volume (#22).
   *
   * There is deliberately no camera argument. "Voice on camera" (#36) used to
   * send a `listenPosition` here, which let the request name a point to hear
   * from without publishing it — so it worked against players who had never
   * opted in. The camera now goes to room state over `coords` and the server
   * reads ours from there, so it cannot be asserted per-request. See
   * signaling.sendCoords.
   *
   * `alliesOnly`: the tracker has lost us and `myPosition` is only where we
   * were last seen, which we no longer vouch for — score our teammates from
   * there and nobody else (the caller drops anyone else the server returns).
   */
  async computeVolumes(
    myPosition: Position,
    roomId: string,
    name: string,
    allyProximity: boolean,
    alliesOnly = false,
    riftVoices = false,
    championRangeOnly = false,
    deadVoiceMode: 'off' | 'ghosts' | 'ghosts-nearby' = 'ghosts',
  ): Promise<VolumeResponse> {
    const controller = new AbortController();
    // Volume scoring is polled separately from the 10 Hz position stream;
    // bound failures so stale gains don't linger for multiple seconds.
    const timeoutId = setTimeout(() => controller.abort(), 1500);

    const startedAt = performance.now();
    let succeeded = false;
    try {
      const resp = await fetch(`${getServerUrl()}/compute-volumes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          myPosition: { x: myPosition.x, y: myPosition.y },
          roomId,
          name,
          allyProximity,
          ...(alliesOnly ? { alliesOnly: true } : {}),
          ...(riftVoices ? { riftVoices: true } : {}),
          ...(championRangeOnly ? { championRangeOnly: true } : {}),
          deadVoiceMode,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`Volume API error: ${resp.status}`);
      }

      const result = await resp.json();
      succeeded = true;
      return result;
    } finally {
      clearTimeout(timeoutId);
      const now = performance.now();
      if (now - this.lastHealthEmitMs >= 2000) {
        this.lastHealthEmitMs = now;
        void emit('network:health', { volumeRttMs: Math.round(now - startedAt), succeeded });
      }
    }
  }
}
