// Panel language. Everything the player reads in the overlay goes through t();
// static markup is tagged data-i18n / data-i18n-title and filled by
// applyTranslations(). The services keep producing their status lines in
// English (they are logged too, and tests pin them); translateStatus() maps
// those to the panel language at display time.

import { WARN_NOT_FOUND, WARN_IMPLAUSIBLE, WARN_QUERY_FAILED } from '../core/game-window';

export type Lang = 'en' | 'es';
export const LANGUAGES: ReadonlyArray<{ code: Lang; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
];

const LANG_KEY = 'lolproxchat.language';

// Duplicated from tracking.ts rather than imported: tracking.ts pulls in the
// whole CV pipeline, and the overlay only needs the two strings.
const WARN_MINIMAP_TOO_LARGE = "Minimap too large to capture — lower MinimapScale in League's HUD.";
const WARN_CALIBRATION_OUTSIDE_CAPTURE = 'Calibrated minimap is outside the capture area — recalibrate.';

const STRINGS = {
  'settings.title': { en: 'Tune your voice', es: 'Configura tu voz' },
  'settings.subtitle': { en: 'Your choices stay on this PC.', es: 'Tus preferencias se guardan en este PC.' },
  'settings.hearingGroup': { en: 'How you hear the Rift', es: 'Cómo escuchas la Grieta' },
  'settings.hearingMode': { en: 'Listening mode', es: 'Modo de escucha' },
  'settings.modeScreen': { en: 'On-screen voices', es: 'Voces en pantalla' },
  'settings.modeNearby': { en: 'Nearby voices', es: 'Voces cercanas' },
  'settings.modeScreenDescription': { en: 'Hear players whose icons are inside your minimap camera box. Distance does not limit these voices.', es: 'Oye a quienes aparecen dentro del recuadro de la cámara del minimapa. La distancia no limita estas voces.' },
  'settings.modeNearbyDescription': { en: 'Hear players near your champion. Their volume fades with distance; the visible-enemy option can silence unseen enemies.', es: 'Oye a quienes están cerca de tu campeón. El volumen baja con la distancia; la opción de visibilidad puede silenciar enemigos no visibles.' },
  'settings.modeRiftDescription': { en: 'Voice range follows loudness: quiet voices reach less far, loud voices farther. Shouts can add reverb; the optional filter muffles distant or unseen voices.', es: 'El alcance depende del volumen: las voces bajas llegan menos lejos y las fuertes más. Los gritos pueden añadir reverberación; el filtro opcional apaga voces lejanas u ocultas.' },
  'settings.riftStereoCamera': { en: 'Rift stereo follows camera', es: 'El estéreo de la Grieta sigue la cámara' },
  'settings.riftStereoCameraHint': { en: 'Moves stereo direction with your camera. Requires 3D stereo. By itself it does not extend hearing range; the camera-listening option below controls that. Your outgoing position stays at your champion.', es: 'Mueve la dirección estéreo con tu cámara. Requiere estéreo 3D. Por sí solo no amplía el alcance; la opción de escuchar desde la cámara controla eso. Tu posición de voz sigue en tu campeón.' },
  'settings.cameraListenNearby': { en: 'Also hear voices around my camera', es: 'También oír voces alrededor de mi cámara' },
  'settings.cameraListenRift': { en: 'Also hear Rift voices around my camera', es: 'También oír voces de la Grieta alrededor de mi cámara' },
  'settings.cameraListenNearbyHint': { en: 'Adds players in your camera box to nearby champion audio. Your outgoing position stays at your champion; nobody listens through your camera. Both players must enable camera audio.', es: 'Añade al audio cercano a tu campeón los jugadores en el recuadro de la cámara. Tu posición de voz sigue en tu campeón; nadie escucha desde tu cámara. Ambos deben activar el audio de cámara.' },
  'settings.cameraListenRiftHint': { en: 'Adds your camera box as another listening area; Rift range, loudness and filters still apply. Your outgoing position stays at your champion; nobody listens through your camera. Both players must enable camera audio.', es: 'Añade el recuadro de la cámara como otra zona de escucha; se mantienen el alcance, volumen y filtros de la Grieta. Tu posición de voz sigue en tu campeón; nadie escucha desde tu cámara. Ambos deben activar el audio de cámara.' },
  'settings.nearbyMufflingHint': { en: 'Smooth low/high-pass filtering makes distant voices sound muffled. The visible-enemy option above separately silences enemies not seen on your minimap.', es: 'Los filtros paso bajo/alto hacen que las voces lejanas suenen apagadas. La opción de enemigos visibles silencia por separado a quienes no aparecen en el minimapa.' },
  'settings.riftMufflingHint': { en: 'Smooth low/high-pass filtering increases with distance and adds muffling to enemies not seen on your minimap. It changes sound, not hearing range.', es: 'Los filtros paso bajo/alto aumentan con la distancia y apagan más a enemigos que no aparecen en el minimapa. Cambia el sonido, no el alcance.' },
  'settings.spatialAudioHint': { en: 'HRTF moves voices smoothly around your head. It changes direction only, not distance or who can hear you.', es: 'HRTF mueve las voces suavemente alrededor de tu cabeza. Solo cambia la dirección, no la distancia ni quién puede oírte.' },
  'settings.deadGhostsDescription': { en: 'Dead players talk to one another anywhere, with light reverb. You cannot hear living players until you revive.', es: 'Los muertos hablan entre sí en cualquier lugar, con reverberación suave. No oyes a los vivos hasta revivir.' },
  'settings.deadGhostsNearbyDescription': { en: 'Dead players talk globally with light reverb. You hear living players around your camera; living players hear you around your death location.', es: 'Los muertos hablan globalmente con reverberación suave. Oyes a los vivos alrededor de tu cámara; los vivos te oyen cerca de donde moriste.' },
  'settings.deadOffDescription': { en: 'Your voice is muted while you are dead. It returns when you revive.', es: 'Tu voz se silencia mientras estás muerto. Vuelve al revivir.' },
  'settings.deadModeHostHint': { en: 'A private-room host can force this choice for everyone.', es: 'El anfitrión de una sala privada puede imponer esta opción a todos.' },
  'settings.visibleOnly': { en: 'Only hear visible enemies', es: 'Oír solo enemigos visibles' },
  'settings.visibleOnlyHint': { en: 'Uses minimap icons as the visibility check. Hidden, invisible, and fog-covered enemies go quiet. Available in nearby mode.', es: 'Usa los iconos del minimapa para comprobar la visión. Los enemigos ocultos, invisibles o en la niebla dejan de oírse. Disponible en modo cercano.' },
  'settings.allyProximityHintShort': { en: 'ON fades teammates with distance. OFF keeps your team at full volume anywhere.', es: 'ACTIVADO baja el volumen de aliados lejanos. DESACTIVADO mantiene al equipo al máximo en cualquier lugar.' },
  'settings.cameraListenHintShort': { en: 'Listen around your camera in Nearby or Rift mode. Both players must enable this receive-only camera option.', es: 'Escucha alrededor de tu cámara en modo Cercano o Grieta. Ambos jugadores deben activar esta opción de cámara, que solo afecta lo que oyes.' },
  'settings.matchRoom': { en: 'Match voice room', es: 'Sala de voz de la partida' },
  'settings.roomHint': { en: 'Leave blank for the automatic room with everyone running the app in your match. Share a private code with friends to make a separate room for that same match.', es: 'Déjalo vacío para entrar automáticamente en la sala de tu partida. Comparte un código privado con tus amigos para crear una sala aparte en esa partida.' },
  'settings.roomPlaceholder': { en: 'Blank = automatic match room', es: 'Vacío = sala automática de partida' },
  'settings.roomCode': { en: 'Private room code', es: 'Código de sala privada' },
  'settings.generateCode': { en: 'MAKE CODE', es: 'CREAR CÓDIGO' },
  'settings.copyCode': { en: 'COPY', es: 'COPIAR' },
  'settings.clearCode': { en: 'CLEAR', es: 'BORRAR' },
  'settings.roomCodeReady': { en: 'Private room ready for your next match. Share this code with friends.', es: 'Sala privada lista para tu próxima partida. Comparte el código con tus amigos.' },
  'settings.roomCodeAutomatic': { en: 'Automatic match rooms are enabled.', es: 'Las salas automáticas están activadas.' },
  'settings.roomCodeInvalid': { en: 'Use 12–48 letters, numbers, dashes, or underscores.', es: 'Usa entre 12 y 48 letras, números, guiones o guiones bajos.' },
  'settings.roomCopied': { en: 'Code copied. Share it only with your party.', es: 'Código copiado. Compártelo solo con tu grupo.' },
  'settings.roomCopyFailed': { en: 'Could not copy. Select the code and copy it manually.', es: 'No se pudo copiar. Selecciona el código y cópialo manualmente.' },
  'settings.audioGroup': { en: 'Microphone and audio', es: 'Micrófono y audio' },
  'settings.privacyGroup': { en: 'Privacy and tracking', es: 'Privacidad y seguimiento' },
  'settings.maintenanceGroup': { en: 'Diagnostics and updates', es: 'Diagnóstico y actualizaciones' },
  'settings.afterMatchGroup': { en: 'After the match', es: 'Después de la partida' },
  'settings.matchRecap': { en: 'Show match recap', es: 'Mostrar resumen de partida' },
  'settings.matchRecapHint': { en: 'When enabled, opens your League scoreboard and local voice recap after a match. Off by default.', es: 'Al activarlo, muestra el marcador de League y el resumen local de voz al terminar la partida. Desactivado por defecto.' },
  'settings.appAudioHintShort': { en: 'For OBS application capture. Headphones help prevent echo.', es: 'Para capturar el audio en OBS. Usa auriculares para evitar eco.' },
  'settings.forceTurnHintShort': { en: 'Relays voice so other players do not see your public IP. May add latency.', es: 'Retransmite la voz para que otros no vean tu IP pública. Puede añadir latencia.' },
  'header.selfMute': { en: 'Toggle Self Mute', es: 'Silenciar/activar tu micrófono' },
  'header.muteAll': { en: 'Mute All', es: 'Silenciar a todos' },
  'header.pos': {
    en: "Wrong position? If people next to you can't hear you, click this, then walk somewhere: the app finds your champion on the minimap again. Until it does, only your team hears you.",
    es: '¿Posición incorrecta? Si los jugadores que tienes al lado no te oyen, haz clic aquí y luego muévete un poco: la app volverá a encontrar a tu campeón en el minimapa. Hasta entonces, solo te oye tu equipo.',
  },
  'header.posLabel': { en: 'POS', es: 'POS' },
  'header.settings': { en: 'Settings', es: 'Ajustes' },
  'header.settingsLabel': { en: 'SET', es: 'CFG' },
  'header.collapse': { en: 'Collapse', es: 'Contraer' },
  'header.expand': { en: 'Expand', es: 'Expandir' },

  'players.waiting': { en: 'Waiting for nearby players...', es: 'Esperando jugadores cercanos...' },
  'players.dead': { en: 'DEAD', es: 'MUERTO' },
  // The row's indicator: the player muted their own mic.
  'players.muted': { en: 'MUTED', es: 'SIN MIC' },
  // The row's button, and its state once you have muted them.
  'players.mutedByYou': { en: 'MUTED', es: 'MUTEADO' },
  'players.mute': { en: 'MUTE', es: 'MUTEAR' },

  'settings.language': { en: 'Language', es: 'Idioma' },
  'settings.inputDevice': { en: 'Microphone', es: 'Micrófono' },
  'settings.outputDevice': { en: 'Headphones / speakers', es: 'Auriculares / altavoces' },
  'settings.default': { en: 'Default', es: 'Predeterminado' },
  'settings.unnamedInput': { en: '(unnamed audioinput)', es: '(dispositivo sin nombre)' },
  'settings.unnamedOutput': { en: '(unnamed audiooutput)', es: '(dispositivo sin nombre)' },
  'settings.inputMode': { en: 'Microphone mode', es: 'Modo del micrófono' },
  'settings.alwaysOpen': { en: 'Always on', es: 'Siempre activo' },
  'settings.pushToTalk': { en: 'Push to Talk', es: 'Pulsar para hablar' },
  'settings.pttKey': { en: 'PTT Key', es: 'Tecla PTT' },
  'settings.pttKeyHint': {
    en: 'Push-to-talk key, used only in Push to Talk mode. Default: the key left of 1 (` on US keyboards, º on Spanish ones).',
    es: 'Tecla para hablar (PTT), solo en el modo Pulsar para hablar. Por defecto, la tecla a la izquierda del 1 (º en teclados españoles).',
  },
  'settings.toggleKey': { en: 'Toggle-mute Key', es: 'Tecla de silencio' },
  'settings.toggleKeyHint': {
    en: 'Optional toggle-self-mute hotkey. Click to bind a key; click again to clear.',
    es: 'Atajo opcional para silenciar o activar tu micrófono. Haz clic para asignar una tecla; vuelve a hacer clic para quitarla.',
  },
  'settings.unbound': { en: '(unbound)', es: '(sin asignar)' },
  'settings.pressKey': { en: 'Press a key…', es: 'Pulsa una tecla…' },
  'settings.forbiddenKey': { en: '(LoL/system key — pick another)', es: '(tecla reservada)' },
  'settings.unsupportedKey': { en: '(key not supported)', es: '(tecla no compatible)' },
  'settings.micVolume': { en: 'Mic Volume', es: 'Volumen mic' },
  'settings.forceTurn': { en: 'Hide IP (Force TURN)', es: 'Ocultar IP (forzar TURN)' },
  'settings.forceTurnHint': {
    en: 'Routes all voice through the TURN relay so peers never see your public IP. Adds ~20-100ms latency. Takes effect on next peer connection. On by default.',
    es: 'Envía la voz a través del servidor de retransmisión TURN, para que los demás jugadores nunca vean tu IP pública. Añade unos 20-100 ms de latencia. Se aplica a partir de la próxima conexión con otro jugador. Activado por defecto.',
  },
  'settings.appAudio': { en: 'App audio (OBS)', es: 'Audio por la app (OBS)' },
  'settings.appAudioHint': {
    en: "When ON, the voices are played by lolproxchat.exe itself instead of the built-in browser, so OBS can capture them with Application Audio Capture → [lolproxchat.exe] on their own track. Output Device then lists the devices lolproxchat.exe sees. Use headphones: with speakers the others may hear themselves back. On by default.",
    es: "Si está activado, las voces las reproduce lolproxchat.exe en vez del navegador interno, y así OBS puede capturarlas con Captura de audio de aplicación → [lolproxchat.exe] en una pista aparte. Dispositivo de salida pasa a mostrar los dispositivos que ve lolproxchat.exe. Usa cascos: con altavoces los demás podrían oírse a sí mismos. Activado por defecto.",
  },
  'settings.cameraOnly': { en: 'Camera mode', es: 'Modo cámara' },
  'settings.cameraOnlyHint': {
    en: "When ON (default), you hear exactly the players whose icons are inside your camera's white box on the minimap, and nobody else: not even someone beside you if your camera is elsewhere. Enemies only while their icon is drawn on your minimap, so one in a brush or in the fog stays silent. Others hear you when YOUR icon is inside THEIR box: looking at someone never makes them hear you. Does not need the app to find your own icon. Overrides Ally proximity and Voice on camera while on. Everyone should use the same version for it to work both ways.",
    es: "Si está activado (por defecto), oyes exactamente a los jugadores cuyos iconos están dentro del recuadro blanco de la cámara en el minimapa, y a nadie más: ni siquiera a quien está a tu lado si tu cámara mira a otro sitio. A los enemigos solo mientras su icono aparece en tu minimapa: si están en un arbusto o en la niebla, no se oyen. Los demás te oyen cuando TU icono está dentro de SU recuadro: mirar a alguien nunca hace que te oiga. No necesita que la app encuentre tu propio icono. Mientras está activado, sustituye a Proximidad aliada y a Oír desde la cámara. Para que funcione en los dos sentidos, todos tenéis que usar esta misma versión.",
  },
  'settings.allyProximity': { en: 'Teammate distance audio', es: 'Audio de aliados según distancia' },
  'settings.allyProximityHint': {
    en: 'When ON (default), teammates fade with distance just like enemies. When OFF, teammates are always at full volume. Takes effect on the next position update.',
    es: 'Si está activado (por defecto), el volumen de tus compañeros baja con la distancia, igual que el de los enemigos. Si está desactivado, siempre oyes a tus compañeros a todo volumen. Se aplica en la siguiente actualización de posición.',
  },
  'settings.cameraListen': { en: 'Voice on camera', es: 'Oír desde la cámara' },
  'settings.cameraListenHint': {
    en: "When ON, you also hear the champions inside your camera's white box on the minimap — what is on your screen — not just those near your champion. Enemies only while their icon is on your minimap, as everywhere: one in a brush or in the fog stays silent. One-way: the people you listen in on only hear you if they are near your champion or looking at you themselves. Only works between players who BOTH have it on: leave it off and nobody's Voice on camera can reach you. (Players in Camera mode still hear you while your icon is inside their camera box.) On by default.",
    es: 'Si está activado, también oyes a los campeones que están dentro del recuadro blanco de la cámara en el minimapa (lo que tienes en pantalla), no solo a los que están cerca de tu campeón. A los enemigos, como siempre, solo mientras su icono aparece en tu minimapa: si están en un arbusto o en la niebla, no se oyen. Funciona en un solo sentido: los jugadores a los que escuchas así solo te oyen si están cerca de tu campeón o si ellos mismos te están mirando. Solo funciona si ambos jugadores lo tienen activado: si lo dejas desactivado, el Oír desde la cámara de nadie te alcanza. (Quien use el Modo cámara te oye igualmente mientras tu icono esté dentro de su recuadro.) Viene activado por defecto.',
  },
  'settings.wrongPosition': { en: 'Wrong position?', es: '¿Posición incorrecta?' },
  'settings.wrongPositionHint': {
    en: "If people near you can't hear you, the app may be tracking the wrong icon on your minimap (it can latch onto a ward you walked past). This drops the current position and finds your champion again; walk somewhere after pressing it so it can tell you apart. Until it finds you, only your team hears you.",
    es: 'Si los jugadores cercanos no te oyen, puede que la app esté siguiendo el icono equivocado en tu minimapa (puede quedarse pegada a un ward junto al que pasaste). Esto descarta la posición actual y vuelve a buscar a tu campeón; muévete después de pulsarlo para que pueda distinguirte. Hasta que te encuentre, solo te oye tu equipo.',
  },
  'settings.reset': { en: 'RESET', es: 'REINICIAR' },
  'settings.sharedReset': { en: 'Shared RESET', es: 'REINICIAR compartido' },
  'settings.sharedResetHint': {
    en: "When ON, pressing RESET also makes everyone else in the game who has this on find their champion on the minimap again, and their RESETs do the same for you. On by default. Only works between players who have it on: leave it off and nobody's RESET reaches you. Either team can use it, at most once every 15 seconds per game.",
    es: 'Si está activado, al pulsar REINICIAR también hace que todos los demás jugadores de la partida que lo tengan activado vuelvan a buscar a su campeón en el minimapa, y sus REINICIAR hacen lo mismo contigo. Viene activado por defecto. Solo funciona entre jugadores que lo tengan activado: si lo dejas desactivado, el REINICIAR de nadie te afecta. Funciona con los dos equipos, como mucho una vez cada 15 segundos por partida.',
  },
  'notice.sharedReset': {
    en: '{name} pressed RESET — finding you again',
    es: '{name} pulsó REINICIAR — buscándote de nuevo',
  },
  'notice.sharedResetAnon': {
    en: 'Another player pressed RESET — finding you again',
    es: 'Otro jugador pulsó REINICIAR — buscándote de nuevo',
  },
  'settings.searching': { en: 'SEARCHING', es: 'BUSCANDO' },
  'settings.debug': { en: 'Debug', es: 'Depuración' },
  'settings.debugLogs': { en: 'Debug Logs', es: 'Registros' },
  'settings.openLogsHint': {
    en: 'Open log folder to attach to a GitHub issue',
    es: 'Abre la carpeta de registros para adjuntarlos a un reporte en GitHub',
  },
  'settings.open': { en: 'OPEN', es: 'ABRIR' },
  'settings.autoUpdate': { en: 'Auto-update', es: 'Autoactualizar' },
  'settings.updates': { en: 'Updates', es: 'Actualizaciones' },
  'settings.check': { en: 'CHECK', es: 'BUSCAR' },
  'settings.scanRate': { en: 'Scan Rate', es: 'Tasa de escaneo' },
  'settings.on': { en: 'ON', es: 'SÍ' },
  'settings.off': { en: 'OFF', es: 'NO' },

  'update.checking': { en: 'Checking for updates…', es: 'Buscando actualizaciones…' },
  'update.available': { en: 'Update available: v{version} — applying…', es: 'Actualización disponible: v{version} — instalando…' },
  'update.upToDate': { en: 'Up to date (v{version})', es: 'Ya tienes la última versión (v{version})' },
  'update.failed': { en: 'Update check failed: {error}', es: 'Error al buscar actualizaciones: {error}' },
} as const;

export type StringKey = keyof typeof STRINGS;

// The orchestrator's and the game-window / tracking warnings' exact wording.
const STATUS_ES: Record<string, string> = {
  'Waiting for League of Legends': 'Esperando a League of Legends',
  'Microphone blocked — listening only. Check Windows microphone privacy settings':
    'Micrófono bloqueado — solo escuchas. Revisa la privacidad del micrófono en Windows',
  'Searching for your champion on the minimap': 'Buscando a tu campeón en el minimapa',
  'In client': 'En el cliente',
  'In lobby': 'En la sala',
  'Searching for match': 'Buscando partida',
  'Ready check': 'Partida encontrada',
  'In champion select': 'En selección de campeón',
  'Joining game...': 'Uniéndote a la partida...',
  'Game complete': 'Partida terminada',
  'End of game': 'Fin de la partida',
  // League client phases the orchestrator passes through as-is.
  'Reconnect': 'Reconectando',
  'CheckedIntoTournament': 'Inscrito en un torneo',
  'TerminatedInError': 'La partida terminó con un error',
  "Couldn't read your Riot ID from League — see log": 'No se pudo leer tu Riot ID desde League — revisa el registro',
  "Couldn't match your Riot ID to the player list — see log": 'No se encontró tu Riot ID en la lista de jugadores — revisa el registro',
  'Streamer mode detected — not joining proximity chat': 'Modo streamer detectado — no te unirás al chat de proximidad',
  [WARN_NOT_FOUND]: 'No se encuentra la ventana de League — usa el modo Sin bordes, no Pantalla completa.',
  [WARN_IMPLAUSIBLE]: 'La ventana de League parece incorrecta — usando el monitor principal.',
  [WARN_QUERY_FAILED]: 'No se pudo leer la ventana de League — usando el monitor principal.',
  [WARN_MINIMAP_TOO_LARGE]: 'El minimapa es demasiado grande para capturarlo — baja la escala del minimapa en la interfaz de League.',
  [WARN_CALIBRATION_OUTSIDE_CAPTURE]: 'El minimapa calibrado está fuera del área de captura — vuelve a calibrarlo.',
};

const KEYS_ES: Record<string, string> = {
  'Caps Lock': 'Bloq Mayús',
  'Delete': 'Supr',
  'Home': 'Inicio',
  'End': 'Fin',
  'Page Up': 'Re Pág',
  'Page Down': 'Av Pág',
  'Space': 'Espacio',
  'Unknown': 'Desconocida',
};

function storage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

// Read once: t() runs several times per player row at the position-tick rate.
let current: Lang | null = null;

/** The stored choice, else Spanish for a Spanish-language system, else English. */
export function getLanguage(): Lang {
  if (current) return current;
  let stored: string | null = null;
  try { stored = storage()?.getItem(LANG_KEY) ?? null; } catch { /* treat as unset */ }
  if (stored === 'en' || stored === 'es') return (current = stored);
  const sys = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return (current = sys.toLowerCase().startsWith('es') ? 'es' : 'en');
}

export function setLanguage(lang: Lang): void {
  current = lang;
  try { storage()?.setItem(LANG_KEY, lang); } catch { /* not persisted; still applies this session */ }
}

export function t(key: StringKey, params: Record<string, string> = {}, lang: Lang = getLanguage()): string {
  let s: string = STRINGS[key][lang];
  for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(v);
  return s;
}

/** A status line from the services, in the panel language. */
export function translateStatus(english: string, lang: Lang = getLanguage()): string {
  if (lang === 'en' || !english) return english;
  const exact = STATUS_ES[english];
  if (exact) return exact;
  const map = /^Proximity is off — (.+) is not a supported map$/.exec(english);
  if (map) return 'Proximidad desactivada — ' + map[1] + ' no es un mapa compatible';
  return english;
}

/** A key name from humanizeVk, in the panel language. */
export function translateKey(label: string, lang: Lang = getLanguage()): string {
  return lang === 'es' ? KEYS_ES[label] ?? label : label;
}

export function allKeys(): StringKey[] {
  return Object.keys(STRINGS) as StringKey[];
}

/** Fill every data-i18n (text) and data-i18n-title (tooltip) element. */
export function applyTranslations(root: ParentNode, lang: Lang = getLanguage()): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    el.textContent = t(el.dataset.i18n as StringKey, {}, lang);
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n-title]'))) {
    el.title = t(el.dataset.i18nTitle as StringKey, {}, lang);
  }
  for (const el of Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]'))) {
    el.placeholder = t(el.dataset.i18nPlaceholder as StringKey, {}, lang);
  }
}
