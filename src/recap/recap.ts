import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type AnyObj = Record<string, any>;
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const number = (obj: AnyObj, ...keys: string[]): number => {
  for (const key of keys) { const value = Number(obj?.[key]); if (Number.isFinite(value)) return value; }
  return 0;
};
const fmt = (n: number): string => Math.round(n).toLocaleString();
const safe = (value: unknown, fallback = '—'): string => typeof value === 'string' && value.trim() ? value : fallback;
let ddragonVersion = '15.24.1';
let championAssetById = new Map<string, string>();
let currentRecap: AnyObj | null = null;
void fetch('https://ddragon.leagueoflegends.com/api/versions.json').then(r => r.ok ? r.json() : null)
  .then(async versions => {
    if (Array.isArray(versions) && typeof versions[0] === 'string') ddragonVersion = versions[0];
    const response = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/en_US/champion.json`);
    if (!response.ok) return;
    const payload = await response.json();
    championAssetById = new Map(Object.values(payload?.data ?? {}).map((champion: any) => [String(champion.key), champion.image.full.replace(/\.png$/, '')]));
    if (currentRecap) renderScoreboard(currentRecap);
  }).catch(() => undefined);

function makeItem(id: number): HTMLElement {
  const node = document.createElement('span'); node.className = 'item'; node.title = id ? `Item ${id}` : 'Empty item slot';
  if (!id) return node;
  const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy';
  image.src = `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png`;
  image.onerror = () => { image.remove(); node.textContent = '✦'; };
  node.append(image); return node;
}

function rowsFromStats(stats: AnyObj, roster: AnyObj[]): Array<{team: string; won: boolean; players: AnyObj[]}> {
  const teams = Array.isArray(stats?.teams) ? stats.teams : [];
  return teams.map((team: AnyObj) => ({ team: team.isBottomTeam ? 'BLUE SIDE' : 'RED SIDE', won: team.isWinningTeam === true,
    players: Array.isArray(team.players) ? team.players.map((player: AnyObj) => {
      const name = safe(player.summonerName, safe(player.riotId));
      const match = roster.find(r => String(r.name ?? '').toLowerCase() === name.toLowerCase());
      return { ...player, _name: name, _champ: safe(player.skinName, match?.champion ?? 'Champion'), _team: team.isBottomTeam ? 'ORDER' : 'CHAOS' };
    }) : [] }));
}

function renderScoreboard(data: AnyObj): void {
  const root = $('teams'); root.replaceChildren();
  const teams = rowsFromStats(data.leagueStats, data.roster ?? []);
  if (!teams.length) {
    const fallback = document.createElement('div'); fallback.className = 'loading'; fallback.textContent = 'League’s post-game stats were unavailable. This client still recorded its own proximity-chat stats.'; root.append(fallback);
    $('score-note').textContent = 'The local League end-of-game stats endpoint was unavailable for this match.';
    return;
  }
  for (const team of teams) {
    const block = document.createElement('section'); block.className = 'team-block';
    const heading = document.createElement('div'); heading.className = `team-title${team.won ? '' : ' loss'}`; heading.textContent = `${team.team} · ${team.won ? 'VICTORY' : 'DEFEAT'}`; block.append(heading);
    for (const player of team.players) {
      const st = player.stats ?? {};
      const row = document.createElement('div'); row.className = 'player-row';
      const who = document.createElement('div'); who.className = 'who';
      const portrait = document.createElement('span'); portrait.className = 'champ-icon'; portrait.textContent = String(player._champ).slice(0, 2).toUpperCase();
      const champSlug = championAssetById.get(String(player.championId)) ?? safe(player.skinName, '').replace(/[^a-zA-Z0-9]/g, '');
      if (champSlug) { const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.src = `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${champSlug}.png`; img.onerror = () => img.remove(); portrait.replaceChildren(img); }
      const names = document.createElement('div'); const playerName = document.createElement('div'); playerName.className = 'player-name'; playerName.textContent = player._name;
      const champ = document.createElement('div'); champ.className = 'champ-name'; champ.textContent = `${player._champ} · ${safe(player.selectedPosition, safe(player.detectedTeamPosition, ''))}`;
      names.append(playerName, champ); who.append(portrait, names); row.append(who);
      const k = number(st, 'CHAMPIONS_KILLED', 'championsKilled'), d = number(st, 'NUM_DEATHS', 'numDeaths'), a = number(st, 'ASSISTS', 'assists');
      const kda = document.createElement('span'); kda.className = 'kda'; kda.textContent = `${k} / ${d} / ${a}`; row.append(kda);
      const damage = number(st, 'TOTAL_DAMAGE_DEALT_TO_CHAMPIONS', 'totalDamageDealtToChampions') || number(st, 'PHYSICAL_DAMAGE_DEALT_TO_CHAMPIONS') + number(st, 'MAGIC_DAMAGE_DEALT_TO_CHAMPIONS') + number(st, 'TRUE_DAMAGE_DEALT_TO_CHAMPIONS');
      for (const value of [fmt(damage), fmt(number(st, 'GOLD_EARNED', 'goldEarned')), fmt(number(st, 'MINIONS_KILLED', 'minionsKilled') + number(st, 'NEUTRAL_MINIONS_KILLED', 'neutralMinionsKilled')), fmt(number(st, 'VISION_SCORE', 'visionScore'))]) { const cell = document.createElement('span'); cell.className = 'stat'; cell.textContent = value; row.append(cell); }
      const items = document.createElement('div'); items.className = 'items'; (Array.isArray(player.items) ? player.items : []).slice(0, 7).forEach((id: number) => items.append(makeItem(id))); row.append(items);
      const extras = document.createElement('div'); extras.className = 'extra-line';
      extras.textContent = [
        `Lvl ${number(st, 'LEVEL', 'level') || number(player, 'level')}`,
        `Damage taken ${fmt(number(st, 'TOTAL_DAMAGE_TAKEN', 'totalDamageTaken'))}`,
        `Wards ${fmt(number(st, 'WARD_PLACED', 'wardPlaced'))} placed / ${fmt(number(st, 'WARD_KILLED', 'wardKilled'))} cleared`,
        `Structures ${fmt(number(st, 'TURRETS_KILLED', 'turretsKilled'))} towers / ${fmt(number(st, 'BARRACKS_KILLED', 'barracksKilled'))} inhibitors`,
        `${number(st, 'LARGEST_MULTI_KILL', 'largestMultiKill')}× largest multi-kill`,
      ].join('   ·   ');
      row.append(extras);
      block.append(row);
    }
    root.append(block);
  }
  $('score-note').textContent = 'K / D / A · champion damage · gold earned · minions + monsters · vision score · final inventory';
}

function card(title: string, value: string, detail: string): HTMLElement {
  const node = document.createElement('div'); node.className = 'metric';
  const label = document.createElement('div'); label.className = 'label'; label.textContent = title;
  const main = document.createElement('div'); main.className = 'value'; main.textContent = value;
  const desc = document.createElement('div'); desc.className = 'detail'; desc.textContent = detail;
  node.append(label, main, desc); return node;
}

function renderRecap(data: AnyObj): void {
  currentRecap = data;
  const duration = Math.max(1, number(data.leagueStats, 'gameLength') || Number(data.durationSec) || 0);
  const localTeam = rowsFromStats(data.leagueStats, data.roster ?? []).find(team => team.players.some(player => String(player._name).toLowerCase() === String(data.localPlayerName ?? '').toLowerCase()));
  $('result').textContent = localTeam ? localTeam.won ? 'VICTORY' : 'DEFEAT' : 'MATCH COMPLETE';
  $('headline').textContent = data.chaos ? 'The Rift got weird. Your chat kept receipts.' : localTeam?.won ? 'Nexus down. Voice chat survived.' : 'Defeat on the Rift. Your callouts made it.';
  $('subhead').textContent = `${fmt(duration / 60)} min match · ${fmt(data.players)} players · local match report`;
  renderScoreboard(data);
  const cards = $('chat-cards'); cards.replaceChildren(
    card('YOUR MIC · LIVE TIME', `${fmt((data.micMs ?? 0) / 60000)}m`, 'Time your mic carried audible voice'),
    card('VOICES HEARD', fmt((data.voicesHeard ?? []).filter((x: string) => x !== 'self').length), 'Distinct players heard by this client'),
    card('VOICE BURSTS', fmt(data.voiceTurns ?? 0), 'Moments a voice became audible'),
    card('LOUDEST CALLOUT', `${Math.round((data.peakVoice ?? 0) * 100)}%`, 'Peak local mic level observed'),
  );
  const table = $('voice-table'); table.replaceChildren();
  const header = document.createElement('div'); header.className = 'voice-row'; header.innerHTML = '<span>PLAYER</span><span>HEARD BY YOU</span><span>OBSERVATION</span>'; table.append(header);
  const entries = Object.entries(data.voiceMs ?? {}).filter(([name]) => name !== 'self').sort((a,b) => Number(b[1])-Number(a[1]));
  for (const [name, ms] of entries) {
    const row = document.createElement('div'); row.className = 'voice-row'; const who = document.createElement('span'); who.className = 'primary'; who.textContent = name;
    const time = document.createElement('span'); time.textContent = `${Math.floor(Number(ms)/60000)}m ${Math.floor(Number(ms)%60000/1000)}s`;
    const note = document.createElement('span'); note.textContent = 'Audible voice samples'; row.append(who,time,note); table.append(row);
  }
  const chaosTab = document.querySelector('[data-tab="chaos"]')!; chaosTab.classList.toggle('hidden', !data.chaos);
  const chaosCards = $('chaos-cards'); chaosCards.replaceChildren(
    card('RIFT RUCKUS', 'ENABLED', 'Private-room host mode'),
    card('CHAOS EVENTS', fmt((data.chaosEvents ?? []).length), 'Random effects played this game'),
    card('STANDOUT MOMENT', safe(data.standout), 'One for the group chat'),
    card('SFX POLICY', 'LOCAL + LIVE', 'Effects cleared when Chaos Mode ends'),
  );
  const chaosList = $('chaos-list'); chaosList.replaceChildren();
  for (const event of data.chaosEvents ?? []) { const item = document.createElement('div'); item.className = 'chaos-item'; item.textContent = `✧  ${event}`; chaosList.append(item); }
}

document.querySelectorAll<HTMLButtonElement>('.tab').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.tab-page').forEach(page => page.classList.remove('active'));
  button.classList.add('active'); $(`${button.dataset.tab}`).classList.add('active');
}));
for (const id of ['close','done']) $(id).addEventListener('click', () => { void invoke('hide_match_recap'); });
void listen<AnyObj>('match:recap', event => renderRecap(event.payload));
