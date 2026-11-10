# Older default server compatibility

The current default deployment is an older server build and cannot be upgraded from this repository. The app keeps it as the normal default and uses the server features it already has. As checked on 2026-11-10, its room snapshot contains only `type` and `peers`; `peer_joined` contains `name`; position broadcasts include the server-added `from` identity and relay arbitrary JSON fields in `blob`.

## Works with the older default server

- Automatic League match rooms, private room codes, peer discovery, WebRTC signaling, ordinary proximity volumes, and the server's existing TURN credential endpoint.
- Replay consent signaling. Voice is recorded locally by consenting current clients; older clients lack the consent bit, so recording stays off while one is in the room.
- Local audio processing, spatial audio, recording/replay files, recap, adaptive tracking, device recovery, minimap visibility filters, and other features computed in each client.
- Private-room host controls, Chaos event synchronization, and replay consent among current clients. When the room snapshot has no host fields, current clients infer the first joiner from the ordered server peer list and update that choice on `peer_joined` / `peer_left`. Controls are accepted only in private rooms and only from a message whose transport-level `from` matches the inferred host. Unknown `host_options` / Chaos WebSocket message types are not sent to the legacy service; these fields travel in the existing `position` message instead.
- The long-range Chaos effect is applied locally on every current client, so it does not need newer server range logic.

All participants need a current Yordle Yapper client for host controls, Chaos, and replay consent behavior. Old clients do not understand those client-side additions.

## Needs the current server (use Host a server with ngrok)

The older default deployment cannot be changed remotely, so these server-computed behaviors cannot be retrofitted into it by a client-only update:

- Rift Voices' extended loudness-based range and shouting distance curve.
- The revised per-dead-player/body/camera volume rules and camera-range calculations.
- New server-side proximity falloff, hidden-target volume policy, and current stale-position handling.

Using **Host a server with ngrok** starts the current server companion on the host PC. Every participant then uses that generated HTTPS address, so these calculations run on the current server code. The client's TURN credential request can still fall back to the default service; no player room, name, or position is sent to it for that request.

## Live compatibility check

The legacy endpoint was probed with an isolated temporary room on 2026-11-10. It returned the legacy room snapshot shape above, returned the existing join event, and relayed an arbitrary extra position-blob field unchanged while attaching `from` to the transport envelope. The generated room was closed immediately after the probe. The standalone current server helper was also started locally and `/health` returned `{"status":"ok","rooms":0}`. These protocol checks don't replace a multi-PC League match playtest.
