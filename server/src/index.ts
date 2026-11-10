import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { handleConnection } from './ws-handler.js';
import { Heartbeat, DEFAULT_HEARTBEAT_MS, MIN_HEARTBEAT_MS } from './heartbeat.js';
import { generateTurnCredentials, generateCloudflareIceServers } from './turn.js';
import { computeVolumes, computeTieredVolumes } from './volumes.js';
import {
  TokenBucket,
  ConcurrencyLimiter,
  LIMITS,
  clientIp,
  resolveProxyTrust,
  describeProxyTrust,
  playerKey,
  RejectionCounters,
} from './rate-limit.js';

const PORT = parseInt(process.env.PORT || '3100');
// The in-app ngrok host binds loopback only; ordinary server deployments keep
// the usual all-interface listener. The tunnel agent connects to localhost.
const HOST = process.env.HOST || '0.0.0.0';
// Which addresses in front of us are our own reverse proxies. Deployment
// topology, not limit tuning — it can't be a compile-time constant because the
// same build runs behind one Caddy, behind a CDN→Caddy chain, or on a bare
// port. TRUST_PROXY is the deprecated hop-count spelling, still honoured so an
// existing deployment survives the upgrade. See rate-limit.ts for how the value
// is used and docs/self-hosting.md for the operator-facing rules.
const PROXY_TRUST = resolveProxyTrust(process.env.TRUSTED_PROXIES, process.env.TRUST_PROXY);
// Ping interval for the WebSocket liveness sweep. Overridable so tests (and a
// self-hoster behind an unusually impatient proxy) can tighten it; a bad value
// falls back to the default rather than being used, because setInterval(fn, NaN)
// fires on every tick and would turn the sweep into a ping/terminate flood.
const HEARTBEAT_MS = (() => {
  const raw = Number(process.env.HEARTBEAT_MS);
  return Number.isFinite(raw) && raw >= MIN_HEARTBEAT_MS ? raw : DEFAULT_HEARTBEAT_MS;
})();
// Cloudflare Realtime TURN (preferred, see docs/self-hosting.md). When configured,
// the server fetches ICE credentials from Cloudflare on /turn-credentials.
const TURN_KEY_ID = process.env.TURN_KEY_ID || '';
const TURN_KEY_API_TOKEN = process.env.TURN_KEY_API_TOKEN || '';
// Self-hosted coturn fallback (optional). Used only when the Cloudflare vars
// above are unset — lets operators who'd rather run their own coturn keep
// the existing HMAC flow without code changes.
const TURN_SERVER = process.env.TURN_SERVER || '';
const TURN_SECRET = process.env.TURN_SECRET || '';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

const rooms = new RoomManager();
const heartbeat = new Heartbeat();

// Per-endpoint rate limiters keyed by client IP. See rate-limit.ts for the
// rationale behind each limit.
const turnCredsLimiter = new TokenBucket(LIMITS.TURN_CREDS);
// /compute-volumes is limited per PLAYER (ip + name) so housemates sharing one
// NAT each get their own budget; a per-IP backstop bounds the total from any
// single source (incl. a client spoofing many names). See rate-limit.ts.
const computeVolumesPlayerLimiter = new TokenBucket(LIMITS.COMPUTE_VOLUMES_PER_PLAYER);
const computeVolumesIpLimiter = new TokenBucket(LIMITS.COMPUTE_VOLUMES_PER_IP);
const wsConnectionLimiter = new ConcurrencyLimiter(LIMITS.WS_PER_IP);

// A 429 is otherwise invisible: the client sees it, the operator sees nothing.
// The counts are aggregate (no IPs, no names) so they stay inside the
// no-per-user-logging promise in docs/threat-model.md.
const rejections = new RejectionCounters();
const onUntrustedForward = () => rejections.bump('xff_invalid');

// Prune idle buckets every 5 minutes (drop entries idle for >10 min). Keeps
// memory bounded even if the server sees lots of unique IPs/players briefly.
setInterval(() => {
  turnCredsLimiter.pruneIdle(10 * 60 * 1000);
  computeVolumesPlayerLimiter.pruneIdle(10 * 60 * 1000);
  computeVolumesIpLimiter.pruneIdle(10 * 60 * 1000);
}, 5 * 60 * 1000).unref();

// One aggregate line a minute when anything was rejected. The bucket counts
// alongside it are the tell for a misconfigured proxy: if every user is
// collapsing into one bucket they sit at ~1 while `rooms` is many, which is a
// single `curl /health` away from being confirmed.
setInterval(() => {
  const deltas = rejections.drainDeltas();
  if (Object.keys(deltas).length === 0) return;
  console.warn('[rate-limit] rejected in last 60s:', deltas, 'buckets:', {
    turnCreds: turnCredsLimiter.size,
    computeVolumesIp: computeVolumesIpLimiter.size,
    computeVolumesPlayer: computeVolumesPlayerLimiter.size,
    wsIps: wsConnectionLimiter.size,
  });
}, 60 * 1000).unref();

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  // CORS headers on all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.roomCount }));
    return;
  }

  if (req.method === 'POST' && req.url === '/compute-volumes') {
    const ip = clientIp(req, PROXY_TRUST, onUntrustedForward);
    // Cheap per-IP backstop first: bounds total throughput (and the body
    // buffering below) from any single source before we know who's asking.
    if (!computeVolumesIpLimiter.tryConsume(ip)) {
      rejections.bump('compute_volumes_ip');
      sendError(res, 429, 'rate limit exceeded — slow down');
      return;
    }

    let body = '';
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      body += chunk.toString();
      // Bound in-memory buffering so an attacker can't OOM us with a huge POST.
      if (body.length > LIMITS.BODY_BYTES) {
        aborted = true;
        rejections.bump('body_too_large');
        sendError(res, 413, 'request body too large');
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (aborted) return;
      try {
        const parsed = JSON.parse(body);
        // Per-player fairness limit, keyed by (ip + name). Players behind one
        // household NAT each get their own budget instead of sharing the IP's
        // — a shared per-IP bucket silently 429'd everyone in a 2+ stack since
        // every client polls independently. Falls back to ip-only when the
        // name is absent (legacy/malformed); see playerKey in rate-limit.ts
        // for the separator and the length bound on the key.
        const who = playerKey(ip, parsed && typeof parsed === 'object' ? parsed.name : undefined);
        if (!computeVolumesPlayerLimiter.tryConsume(who)) {
          rejections.bump('compute_volumes_player');
          sendError(res, 429, 'rate limit exceeded — slow down');
          return;
        }
        // v0.3 path: client passes roomId + name; server reads team-aware
        // room state (team + position + hearCrossTeam per client) and
        // applies tiered proximity (ally=1.0, cross-team at requester's
        // chosen range). Legacy v0.2 clients omit team on join — the
        // function falls back to team-blind 1200u behavior automatically.
        //
        // v0.1 path: client passes 'peers' field with encrypted blobs.
        // Detect by shape — v0.3+ shape is preferred when both happen to be
        // present (shouldn't, but be defensive).
        const result = parsed && typeof parsed === 'object' && typeof parsed.roomId === 'string'
          ? computeTieredVolumes(parsed, (roomId) => rooms.getRoomClients(roomId), rooms.hasChaosLongRange(parsed.roomId), rooms.getHostOptions(parsed.roomId)?.deadVoiceMode ?? 'inherit')
          : await computeVolumes(parsed, ENCRYPTION_KEY);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        sendError(res, 400, err.message || 'Invalid request');
      }
    });
    return;
  }

  if (req.url === '/turn-credentials') {
    if (!turnCredsLimiter.tryConsume(clientIp(req, PROXY_TRUST, onUntrustedForward))) {
      rejections.bump('turn_creds_ip');
      sendError(res, 429, 'rate limit exceeded — slow down');
      return;
    }
    // Prefer Cloudflare if both vars are set; fall back to self-hosted coturn
    // HMAC; otherwise return empty iceServers (client falls back to public STUN).
    const credsPromise = TURN_KEY_ID && TURN_KEY_API_TOKEN
      ? generateCloudflareIceServers(TURN_KEY_ID, TURN_KEY_API_TOKEN)
      : generateTurnCredentials(TURN_SERVER, TURN_SECRET);
    credsPromise.then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

// WebSocketServer with a per-message size cap. Real signaling messages (SDP,
// ICE candidates, position blobs) are well under 10 KB; 64 KB gives 6x
// headroom and blocks anyone trying to flood the relay with huge payloads.
const wss = new WebSocketServer({ server: httpServer, maxPayload: LIMITS.WS_PAYLOAD_BYTES });

// Failures during the HTTP upgrade emit on the server, before any socket exists
// to carry them. An 'error' event with no listener is a throw, and a throw here
// is the whole process.
wss.on('error', (err) => console.warn('[wss] server error:', err.message));

wss.on('connection', (ws, req) => {
  // Must stay the first statement. A socket that fails the per-IP check below
  // is only sent a close frame — it keeps receiving, so it can still error —
  // and `maxPayload` above makes an oversized frame a routine way to get there.
  // Unlistened, that 'error' event is an uncaught throw that kills the process
  // and every room in it.
  ws.on('error', (err) => console.warn('[ws] socket error:', (err as Error).message));

  const ip = clientIp(req as any, PROXY_TRUST, onUntrustedForward);
  if (!wsConnectionLimiter.acquire(ip)) {
    // The address is deliberately absent: docs/threat-model.md promises no
    // per-user logging, and the aggregate counter covers the operator need.
    rejections.bump('ws_per_ip');
    console.warn('[ws] rejecting a connection — per-IP cap reached');
    ws.close(1008 /* policy violation */, 'too many connections from your IP');
    return;
  }
  ws.on('close', () => wsConnectionLimiter.release(ip));
  // Tracked only past the per-IP guard, so a connection rejected above is
  // never pinged.
  heartbeat.track(ws);
  ws.on('pong', () => heartbeat.markAlive(ws));
  handleConnection(ws, rooms, heartbeat, (reason) => rejections.bump(reason));
});

// Reap half-open connections. Without this a client that vanished without a
// TCP FIN (lid closed, tether dropped) stays in its room until the OS TCP
// timeout, black-holing signaling addressed to its name and holding an ally at
// full volume the whole time. See server/src/heartbeat.ts.
setInterval(() => {
  const reaped = heartbeat.sweep(wss.clients);
  if (reaped) console.warn('[ws] reaped', reaped, 'dead connection(s)');
}, HEARTBEAT_MS).unref();

httpServer.listen(PORT, HOST, () => {
  console.log(`proxchat-server listening on ${HOST}:${PORT}`);
  // Printed so an operator can confirm in `docker logs` what the running
  // process resolved its proxy trust to, rather than inferring it from behaviour.
  console.log(`proxchat-server trust-proxy: ${describeProxyTrust(PROXY_TRUST)}`);
});
