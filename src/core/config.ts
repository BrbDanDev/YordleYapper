// Injected at build time via webpack.DefinePlugin — see .env.example
declare const __PROXCHAT_SERVER__: string;

const SERVER_OVERRIDE_KEY = 'lolproxchat.serverUrl';
const BUILT_IN_SERVER = typeof __PROXCHAT_SERVER__ !== 'undefined' ? __PROXCHAT_SERVER__ : 'https://proxchat.dant123.com';

/** Runtime-selectable endpoint so a room can use a host's self-hosted server. */
export function getServerUrl(): string {
  try {
    const saved = localStorage.getItem(SERVER_OVERRIDE_KEY)?.trim();
    if (saved) return saved.replace(/\/+$/, '');
  } catch { /* storage may be unavailable in restricted webviews */ }
  return BUILT_IN_SERVER.replace(/\/+$/, '');
}

export function getWebSocketUrl(): string { return getServerUrl().replace(/^http/, 'ws') + '/ws'; }

export function saveServerUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '');
  if (!value) {
    try { localStorage.removeItem(SERVER_OVERRIDE_KEY); }
    catch { throw new Error('Could not save the server address in app settings.'); }
    iceCache = null;
    return BUILT_IN_SERVER.replace(/\/+$/, '');
  }
  if (!/^https?:\/\//i.test(value)) throw new Error('Enter a server address beginning with https:// or http://');
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('The server address cannot contain credentials, a query, or a fragment.');
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only HTTP and HTTPS server addresses are supported.');
  if (parsed.pathname !== '/') throw new Error('Enter the server base address without a path.');
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    const octets = host.split('.').map(Number);
    const privateV4 = octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) ||
       (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
       (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
       (octets[0] === 169 && octets[1] === 254));
    const privateHost = privateV4 || host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.ts.net') || host.startsWith('fc') || host.startsWith('fd');
    if (!privateHost) throw new Error('Use HTTPS for a public server. HTTP is allowed only on a private LAN/VPN address.');
  }
  try {
    if (value === BUILT_IN_SERVER.replace(/\/+$/, '')) localStorage.removeItem(SERVER_OVERRIDE_KEY);
    else localStorage.setItem(SERVER_OVERRIDE_KEY, value);
  } catch { throw new Error('Could not save the server address in app settings.'); }
  iceCache = null;
  return getServerUrl();
}

export function getDefaultServerUrl(): string { return BUILT_IN_SERVER.replace(/\/+$/, ''); }

export const SERVER_URL: string = getServerUrl();

// Derive WebSocket URL from SERVER_URL (http→ws, https→wss)
export const WS_URL: string = getWebSocketUrl();

// Default STUN-only ICE servers (fallback if TURN credentials unavailable)
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

// NOTE: unlike the rest of core/, this module holds mutable state (the ICE
// server cache below). `_resetIceServerCacheForTests` exists so a test can put
// it back to a known state, mirroring `_cloudflareCacheForTests` on the server.
interface IceServerCache {
  servers: RTCIceServer[];
  expiresAtMs: number;
}

let iceCache: IceServerCache | null = null;
let iceInFlight: Promise<RTCIceServer[]> | null = null;

// Every peer in a lobby is connected within a few seconds of game start, so a
// short TTL is enough to collapse that whole burst (~9 requests per client)
// into one — which matters because /turn-credentials is bucketed per IP at 60
// tokens refilling at 1/sec and a 5-stack shares one household NAT.
// Deliberately kept well under the server's CACHE_REFRESH_LEAD_MS (5 min, see
// server/src/turn.ts): it only serves a Cloudflare credential while more than
// that much life remains, so 60s leaves most of the margin intact. This is a
// margin, not a guarantee — the server's stale-grace path can hand out an
// already-expired credential during a Cloudflare outage, in which case the
// credential is dead with or without our cache. If CACHE_REFRESH_LEAD_MS is
// ever lowered, lower this with it.
const ICE_CACHE_TTL_MS = 60 * 1000;

/**
 * Fetch ICE servers with TURN credentials from the signaling server.
 * TURN secret never touches the client — HMAC generation happens server-side.
 *
 * Successful responses are cached in memory only (never localStorage: TURN
 * credentials are bearer credentials for the operator's relay). Concurrent
 * callers share one request.
 */
export function getIceServers(): Promise<RTCIceServer[]> {
  if (iceCache && Date.now() < iceCache.expiresAtMs) {
    return Promise.resolve(iceCache.servers);
  }
  if (iceInFlight) return iceInFlight;
  const inFlight = fetchIceServers().finally(() => {
    if (iceInFlight === inFlight) iceInFlight = null;
  });
  iceInFlight = inFlight;
  return inFlight;
}

async function fetchIceServers(): Promise<RTCIceServer[]> {
  const credentialServers = [...new Set([getServerUrl(), getDefaultServerUrl()])];
  for (const baseUrl of credentialServers) {
    try {
      const resp = await fetch(`${baseUrl}/turn-credentials`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.iceServers && data.iceServers.length > 0) {
        iceCache = { servers: data.iceServers, expiresAtMs: Date.now() + ICE_CACHE_TTL_MS };
        return data.iceServers;
      }
    // A 200 carrying an empty list is what the server returns when TURN isn't
    // configured at all, and when Cloudflare is unreachable with no usable
    // cache. Until now that was silent — it reads as "working, just quiet" but
    // means no relay, i.e. no voice behind a symmetric NAT.
      console.warn('[Config] Server returned no TURN servers:', baseUrl);
    } catch (e) {
      console.warn('[Config] Failed to fetch TURN credentials from ' + baseUrl + ':', e);
    }
  }
  if (getServerUrl() !== getDefaultServerUrl()) {
    try {
      const resp = await fetch(`${getDefaultServerUrl()}/turn-credentials`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.iceServers?.length) {
          iceCache = { servers: data.iceServers, expiresAtMs: Date.now() + ICE_CACHE_TTL_MS };
          return data.iceServers;
        }
      }
    } catch (e) {
      console.warn('[Config] Default TURN credential fallback failed:', e);
    }
  }
  // Nothing is cached on this path on purpose. An ICE server list is frozen
  // into each RTCPeerConnection at construction and never re-read (not even by
  // an ICE restart), so a peer built on the STUN fallback stays STUN-only for
  // the whole game. Caching the fallback would turn one dropped request into
  // every peer of that game being relay-less; retrying per peer keeps a
  // transient failure a one-peer problem.
  return ICE_SERVERS;
}

/** Test-only: drop the cache and any in-flight request. */
export function _resetIceServerCacheForTests(): void {
  iceCache = null;
  iceInFlight = null;
}
