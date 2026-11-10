# Yordle Yapper

**Yordle Yapper** is the friendly face of LoLProxChat, an open-source voice companion for League of Legends.

<p align="center"><img src="src/brand/yordle-yapper.svg" alt="Yordle Yapper logo" width="180"></p>

![Server status](https://img.shields.io/website?url=https%3A%2F%2Fproxchat.dant123.com%2Fhealth&label=server&up_message=online&down_message=offline)
[![Latest release](https://img.shields.io/github/v/release/BrbDanDev/YordleYapper)](https://github.com/BrbDanDev/YordleYapper/releases/latest)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPLv3-blue)](LICENSE)

**Proximity voice chat for League of Legends.** Hear nearby players (allies *and* enemies) with volume that scales by in-game distance — enemy voices fade in at around champion-vision range and are at full volume within laning distance.

Standalone Windows desktop app built with Tauri 2 + WebView2. No Overwolf, no third-party voice service, no telemetry. Registered + approved on the Riot Developer Portal (App ID 809090).

---

## Install

Download `lolproxchat.exe` from [your latest release](https://github.com/BrbDanDev/YordleYapper/releases/latest). It is portable and needs no installer. For self-hosting, also download `YordleYapperServer.exe` from the same release and keep both files together; only the host needs the server companion.

The app connects to `proxchat.dant123.com` by default; everyone can use the same exe without running a server. To self-host, the host installs/authenticates ngrok once, then clicks **Host a server with ngrok → START HOSTING** in Settings. The host shares the generated HTTPS address and other players enter it in Voice server settings. This uses the current server companion, so the old default service does not need updating. The [legacy compatibility matrix](docs/legacy-server-compatibility.md) explains what works against the default. Voice audio travels peer-to-peer (or through TURN when required).

**Requirements:**

- Windows 10 1809+ or Windows 11
- WebView2 Runtime (ships with Windows 11; pushed via Edge on Windows 10)
- **League of Legends in Borderless mode** (Settings → Video → Window Mode → Borderless). Required — DX9 true fullscreen takes exclusive GPU output and no transparent overlay can render over it.

Launch the exe before or during a League match. The panel auto-attaches beside the minimap once a game is detected.

### First run

Because the portable executable is unsigned, Windows may show a SmartScreen or Mark of the Web warning when you download it:

- **"Windows protected your PC"** (SmartScreen) → **More info** → **Run anyway**.
- **"This app has been blocked for your protection"** (Mark of the Web) → right-click `lolproxchat.exe` → **Properties** → check **Unblock** → **OK** → re-launch.

The release is unsigned, so SmartScreen may continue to warn on later downloads or on other PCs. This project cannot remove that warning in code: Windows reputation depends on a trusted signing identity and release signing. Only run a build you trust, and verify its SHA-256 hash.

### Verify your download

Every release body includes a SHA-256 hash. Compare it against your downloaded exe to confirm you got the official build (defends against in-transit tampering, mirror reposts, typosquatted re-uploads):

```bash
# PowerShell
Get-FileHash lolproxchat.exe

# WSL / git-bash
sha256sum lolproxchat.exe
```

Every release exe is also submitted to [VirusTotal](https://www.virustotal.com/) during the build, and the scan link is included in the release notes — verifiable against 70+ antivirus engines before you download.

---

## Quick start

1. Make sure LoL is in **Borderless** mode.
2. Launch `lolproxchat.exe`. The panel appears in the middle of the screen showing the current lifecycle ("Waiting for League of Legends", "In champion select", etc.).
3. Once you load into a match, the panel jumps to the left edge of the minimap. Other players running LoLProxChat in the same match appear within a few seconds.
4. **Always Open mic** is the default — just talk. **MIC** = self-mute, **VOL** = mute everyone, **MUTE** per row = silence a specific player.

For the rest — every Settings toggle, troubleshooting, log-grab flow, uninstall — see the **[user guide](docs/user-guide.md)**.

### Match voice replays

Voice replay capture is off until each Yordle Yapper player in the room opts in for that match. Every opted-in app makes its own local `.yyr` file; audio is not uploaded. Files are saved in `Downloads/Yordle Yapper Replays` and can be shared. Load a file in Settings → Match voice replay, then open that match in League Replay. League's local Replay API must be enabled by adding `EnableReplayApi=1` under `[General]` in `game.cfg`; the app follows the replay clock and free-camera position.

---

## Docs

| Doc | When to read |
|---|---|
| [User guide](docs/user-guide.md) | Day-to-day usage, every Settings toggle, troubleshooting, reporting bugs |
| [Architecture](docs/architecture.md) | How it actually works — computer-vision pipeline, WebRTC flow, server design |
| [Threat model](docs/threat-model.md) | What the design protects, what it doesn't, what we collect (and what we don't) |
| [Compliance](docs/compliance.md) | Relationship to Riot's third-party policy + Developer Portal status |
| [Self-hosting](docs/self-hosting.md) | Run your own signaling server |
| [Contributing](CONTRIBUTING.md) | Build, test, release flow + code style |
| [Security policy](SECURITY.md) | How to report vulnerabilities |
| [Changelog](CHANGELOG.md) | What changed in each release |

---

## How it works (in 5 bullets)

1. **Game detection** — reads the LCU and Live Client Data APIs for game phase + player roster. No memory reads, no injection.
2. **Position** — the app captures the minimap image, finds champion icons on it by color and shape, and identifies which champion each one is with a trained image-recognition model — producing your position in in-game coordinates.
3. **Signaling** — players in the same match join a deterministic WebSocket room (room ID = hash of sorted player names) on a self-hosted Node server.
4. **Voice** — WebRTC peer-to-peer audio between players (Opus 128 kbps, DTLS-SRTP). No audio touches any server.
5. **Proximity volume** — each client streams its XY coordinates to the signaling server (over the same WebSocket used for presence/signaling); the server computes pairwise volumes for everyone in the room. Nearby voices begin fading by about 200 units and reach silence by 1200. **Rift Voices** gives quiet speech a shorter, voice-level-scaled 1250–2300-unit range; normal/loud speech reaches farther, and a strong shout can extend smoothly to 3600 with reverb. Teammates follow the selected mode unless **Ally proximity** is off. The server sends only volume and reverb mix values, never another peer's raw position.

**On-screen voices** uses the minimap camera box to decide who you hear. **Nearby voices** uses champion distance. **Rift Voices** scales quiet speech from a 1250-unit minimum to a 2300-unit normal radius as measured voice level rises. Above the shout threshold, reach grows smoothly with loudness, up to 3600 units for a very loud voice; the reverb starts beyond its shout radius. Abruptly disconnected voices leave a short reverb tail. Muffled voices use real low-pass/high-pass filtering that strengthens smoothly with distance and when an enemy is not currently seen; this is a sound cue, not proof of invisibility versus brush or fog. HRTF stereo moves smoothly, and stereo can be disabled for mono playback.

A blank **Match voice room** keeps automatic match rooms. An optional private code creates a separate room for that same match; everyone needs the same code, and it applies on the next match. The first member becomes host and can force voice mode, filtering, stereo, and tracking rate for compatible clients; automatic rooms have no host controls. The code is stored locally. See the [user guide](docs/user-guide.md) for details.

For depth, see [`docs/architecture.md`](docs/architecture.md).

---

## Privacy + anti-cheat in one paragraph

LoLProxChat collects **no analytics, no telemetry, no fingerprinting, no persistent user identifiers**. Data sent to the server includes your summoner name for room routing, XY position for proximity, a smoothed microphone-level scalar for Rift Voices range calculation, WebRTC signaling, and room host options. Position and voice level remain in memory while you are in the room; voice audio itself is DTLS-SRTP peer-to-peer and never touches the server. Want to keep your public IP private even from peers in your match? **Settings → Hide IP (Force TURN)** routes voice through the TURN relay. See [`docs/threat-model.md`](docs/threat-model.md) for the full breakdown.

---

## License

**[GNU AGPLv3](LICENSE).** Free and open source — use, study, modify, and self-host it, including commercially. The copyleft terms require that if you distribute the app, or run a modified version as a network service, you make the corresponding source available under the AGPLv3. © 2026 Daniel Thiberge.

Champion icons used to train the recognition model come from [Community Dragon](https://www.communitydragon.org/) (a community-maintained mirror of Riot's game assets). They remain Riot Games' intellectual property and are not distributed with this software: they are used for training, and the app downloads the icons of the skins on your team from Community Dragon to tell your icon from your teammates'. The requests name no game or player, but which icons are fetched, and when, does show Community Dragon your team's champions and skins at that moment; see [`threat-model.md`](docs/threat-model.md).

---

## Acknowledgements

- [LOL_Minimap_Tracker](https://github.com/Quinntana/LOL_Minimap_Tracker) — minimap champion-tracking reference
- [LeagueMinimapDetectionCNN](https://github.com/Maknee/LeagueMinimapDetectionCNN) — reference code for minimap detection
- [Community Dragon](https://www.communitydragon.org/) — champion icon assets used to train the champion-recognition model and to match teammates' icons in game
- [Tauri](https://tauri.app) — desktop app framework
- Cloudflare Realtime TURN — managed TURN relay infrastructure
- Every user who's filed an issue or attached a log — your reports made this app actually work.
