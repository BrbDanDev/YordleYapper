import { listen } from '@tauri-apps/api/event';

interface HudEffect { id: string; label: string; startedAt: number; endsAt: number; instant: boolean }
interface HudState { enabled: boolean; nextAt: number; intervalMs: number; now: number; effects: HudEffect[] }
const hud = document.getElementById('chaos-hud')!;
const fill = document.getElementById('meter-fill')! as HTMLDivElement;
const label = document.getElementById('next-label')!;
const meter = document.querySelector('.meter')!;
const list = document.getElementById('active-effects')!;
let state: HudState = { enabled: false, nextAt: 0, intervalMs: 45000, now: Date.now(), effects: [] };
function render(): void {
  hud.classList.toggle('hidden', !state.enabled);
  if (!state.enabled) return;
  const now = Date.now();
  const progress = state.nextAt > now ? Math.max(0, Math.min(1, 1 - (state.nextAt - now) / Math.max(1, state.intervalMs))) : 1;
  fill.style.width = `${progress * 100}%`;
  label.textContent = state.nextAt > now ? `NEXT RIFT RUCKUS · ${Math.ceil((state.nextAt - now) / 1000)}s` : 'CHAOS SURGE!';
  meter.classList.toggle('surge', progress >= 0.98);
  const active = state.effects.filter(item => item.endsAt > now).slice(0, 3);
  list.replaceChildren(...active.map(item => {
    const card = document.createElement('div'); card.className = `effect${item.instant ? ' instant' : ''}`;
    const title = document.createElement('div'); title.className = 'name'; title.textContent = item.label;
    const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = item.instant ? 'BURST' : `${Math.ceil((item.endsAt-now)/1000)}s`;
    title.append(kind); const track = document.createElement('div'); track.className = 'track'; const remaining = document.createElement('div'); remaining.className = 'remaining'; remaining.style.transform = `scaleX(${Math.min(1,Math.max(0,(item.endsAt-now)/Math.max(1,item.endsAt-item.startedAt)))})`; track.append(remaining); card.append(title,track); return card;
  }));
}
void listen<HudState>('chaos:hud', event => { state = event.payload; render(); });
window.setInterval(render, 200);
