// Golf lobby flow. Asks for mode (single / host / join / cpu), round length
// (Front 9 / Back 9 / Full 18 / 3-hole demo), and character; produces the config
// that golf.js needs to boot.
//
// showLobby(host) -> Promise<{
//   mode: 'single'|'cpu'|'host'|'join',
//   code?: string,
//   character,
//   cpu?: { personaId, difficulty },
//   holeCount: number,
//   startHole: number          // 1-indexed; 10 for Back 9, 1 otherwise
// }>

import { showCharacterSelect } from './character-select.js';
import { listAiPersonas, listDifficulties } from './ai.js';

const ROUND_OPTIONS = [
  { id: 'demo3', label: 'Quick 3',  desc: 'Three signature holes',    holeCount: 3,  startHole: 1 },
  { id: 'front9', label: 'Front 9', desc: 'Holes 1–9',                 holeCount: 9,  startHole: 1 },
  { id: 'back9',  label: 'Back 9',  desc: 'Holes 10–18',               holeCount: 9,  startHole: 10 },
  { id: 'full18', label: 'Full 18', desc: 'The whole course',          holeCount: 18, startHole: 1 },
];

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

export function showLobby(host) {
  return new Promise((resolve) => {
    const screen = document.createElement('section');
    screen.className = 'screen lobby';
    screen.innerHTML = `
      <div class="lobby-shell">
        <header class="lobby-header">
          <h2 class="lobby-title">Golf</h2>
          <p class="lobby-tag">How are we playing today?</p>
        </header>
        <div class="lobby-body" data-step="mode">
          <div class="mode-grid">
            <button class="mode-tile" data-mode="single">
              <div class="mode-tile__icon">&#9971;</div>
              <div class="mode-tile__name">Solo round</div>
              <div class="mode-tile__sub">Practice — 3 holes, just you</div>
            </button>
            <button class="mode-tile" data-mode="cpu">
              <div class="mode-tile__icon">&#129302;</div>
              <div class="mode-tile__name">Vs CPU</div>
              <div class="mode-tile__sub">Pick an opponent and difficulty</div>
            </button>
            <button class="mode-tile mode-tile--primary" data-mode="host">
              <div class="mode-tile__icon">&#127942;</div>
              <div class="mode-tile__name">Host a match</div>
              <div class="mode-tile__sub">Get a code, send it to your brother</div>
            </button>
            <button class="mode-tile" data-mode="join">
              <div class="mode-tile__icon">&#128279;</div>
              <div class="mode-tile__name">Join a match</div>
              <div class="mode-tile__sub">Enter the code your brother shared</div>
            </button>
          </div>
        </div>
        <button class="lobby-back" data-action="exit">&larr; back to sports</button>
      </div>
    `;
    host.appendChild(screen);

    const body = screen.querySelector('.lobby-body');
    let chosenMode = null;
    let chosenCode = null;
    let chosenChar = null;
    let chosenCpu = null; // { personaId, difficulty } when mode === 'cpu'
    let chosenRound = ROUND_OPTIONS[0]; // default to Quick 3 so existing flows keep working

    function exit() {
      screen.remove();
      resolve(null);
    }
    screen.querySelector('[data-action="exit"]').addEventListener('click', exit);

    function goToCharacter() {
      body.innerHTML = '';
      showCharacterSelect(body).then((ch) => {
        chosenChar = ch;
        if (chosenMode === 'cpu') goToCpuSelect();
        else finish();
      });
    }

    function goToCpuSelect() {
      const personas = listAiPersonas();
      // Default to a CPU persona other than the player's pick when possible.
      const defaultIdx = Math.max(0, personas.findIndex((p) => p.characterId !== chosenChar?.id));
      chosenCpu = {
        personaId: personas[defaultIdx].id,
        difficulty: personas[defaultIdx].defaultDifficulty,
      };
      body.innerHTML = `
        <div class="lobby-step lobby-step--cpu" style="color:#f5f5f7;font-family:system-ui;display:flex;flex-direction:column;align-items:center;gap:18px;">
          <h3 class="lobby-step__title" style="font-size:24px;font-weight:800;margin:6px 0 4px;">Choose your opponent</h3>
          <p class="lobby-step__hint" style="color:#aab6d0;font-size:14px;margin:0;">You'll alternate holes. Lowest total wins.</p>
          <div class="cpu-grid" style="display:flex;gap:18px;flex-wrap:wrap;justify-content:center;">
            ${personas.map((p) => `
              <button class="cpu-card" data-persona="${p.id}" style="
                width:180px;padding:14px;border-radius:14px;border:2px solid rgba(255,255,255,0.10);
                background:linear-gradient(160deg,rgba(255,255,255,0.07),rgba(255,255,255,0.02));
                color:inherit;text-align:center;cursor:pointer;display:flex;flex-direction:column;gap:6px;">
                <div style="font-size:18px;font-weight:700;">${p.name}</div>
                <div style="font-size:11px;color:#aab6d0;letter-spacing:0.06em;">${p.characterId.toUpperCase()}</div>
              </button>
            `).join('')}
          </div>
          <div class="diff-row" style="display:flex;gap:8px;margin-top:6px;">
            ${listDifficulties().map((d) => `
              <button class="diff-tile" data-diff="${d.id}" style="
                padding:8px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.10);
                background:rgba(255,255,255,0.04);color:inherit;cursor:pointer;font-weight:600;">
                ${d.label}
              </button>
            `).join('')}
          </div>
          <div class="lobby-step__actions" style="display:flex;gap:12px;margin-top:10px;">
            <button class="btn ghost" data-action="back" style="background:transparent;color:#aab6d0;border:0;cursor:pointer;padding:8px 14px;">&larr; back</button>
            <button class="btn btn--primary" data-action="next" style="background:#ffd24a;color:#221b00;border:0;border-radius:8px;padding:10px 20px;font-weight:700;cursor:pointer;">Tee off &rarr;</button>
          </div>
        </div>
      `;
      function refresh() {
        body.querySelectorAll('.cpu-card').forEach((el) => {
          el.style.borderColor = el.dataset.persona === chosenCpu.personaId
            ? '#ffd24a' : 'rgba(255,255,255,0.10)';
          el.style.transform = el.dataset.persona === chosenCpu.personaId ? 'translateY(-3px)' : '';
        });
        body.querySelectorAll('.diff-tile').forEach((el) => {
          const sel = el.dataset.diff === chosenCpu.difficulty;
          el.style.background = sel ? '#ffd24a' : 'rgba(255,255,255,0.04)';
          el.style.color = sel ? '#221b00' : 'inherit';
        });
      }
      body.querySelectorAll('.cpu-card').forEach((el) => {
        el.addEventListener('click', () => {
          chosenCpu.personaId = el.dataset.persona;
          refresh();
        });
      });
      body.querySelectorAll('.diff-tile').forEach((el) => {
        el.addEventListener('click', () => {
          chosenCpu.difficulty = el.dataset.diff;
          refresh();
        });
      });
      body.querySelector('[data-action="back"]').addEventListener('click', goToCharacter);
      body.querySelector('[data-action="next"]').addEventListener('click', finish);
      refresh();
    }

    function finish() {
      screen.remove();
      resolve({
        mode: chosenMode,
        code: chosenCode || undefined,
        character: chosenChar,
        cpu: chosenMode === 'cpu' ? chosenCpu : undefined,
        holeCount: chosenRound.holeCount,
        startHole: chosenRound.startHole,
      });
    }

    function goToRoundLength() {
      body.innerHTML = `
        <div class="lobby-step lobby-step--round">
          <h3 class="lobby-step__title">Round length</h3>
          <p class="lobby-step__hint">Pick how much course you want today.</p>
          <div class="round-grid">
            ${ROUND_OPTIONS.map((r) => `
              <button class="round-tile${r.id === chosenRound.id ? ' round-tile--selected' : ''}" data-round="${r.id}">
                <div class="round-tile__num">${r.holeCount}</div>
                <div class="round-tile__name">${r.label}</div>
                <div class="round-tile__sub">${r.desc}</div>
              </button>
            `).join('')}
          </div>
          <div class="lobby-step__actions">
            <button class="btn ghost" data-action="back">&larr; change mode</button>
            <button class="btn btn--primary" data-action="next">Continue &rarr;</button>
          </div>
        </div>
      `;
      body.querySelectorAll('.round-tile').forEach((tile) => {
        tile.addEventListener('click', () => {
          chosenRound = ROUND_OPTIONS.find((r) => r.id === tile.dataset.round) || ROUND_OPTIONS[0];
          body.querySelectorAll('.round-tile').forEach((t) => t.classList.toggle('round-tile--selected', t === tile));
        });
      });
      body.querySelector('[data-action="back"]').addEventListener('click', goToModeStep);
      body.querySelector('[data-action="next"]').addEventListener('click', () => {
        if (chosenMode === 'host') goToHostCode();
        else if (chosenMode === 'join') goToJoinCode();
        else goToCharacter();
      });
    }

    function goToHostCode() {
      chosenCode = randomCode(4);
      body.innerHTML = `
        <div class="lobby-step lobby-step--code">
          <h3 class="lobby-step__title">Your match code</h3>
          <p class="lobby-step__hint" title="Share this code with your brother">
            Share this with your brother so he can join.
          </p>
          <div class="code-card">
            <div class="code-card__code" data-el="code">${chosenCode}</div>
            <button class="btn" data-action="copy">Copy</button>
          </div>
          <div class="lobby-step__actions">
            <button class="btn ghost" data-action="back">&larr; change mode</button>
            <button class="btn btn--primary" data-action="next">Continue &rarr;</button>
          </div>
        </div>
      `;
      body.querySelector('[data-action="copy"]').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(chosenCode);
          const btn = body.querySelector('[data-action="copy"]');
          const prev = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = prev; }, 1200);
        } catch {/* ignore */}
      });
      body.querySelector('[data-action="back"]').addEventListener('click', goToModeStep);
      body.querySelector('[data-action="next"]').addEventListener('click', goToCharacter);
    }

    function goToJoinCode() {
      body.innerHTML = `
        <div class="lobby-step lobby-step--code">
          <h3 class="lobby-step__title">Enter match code</h3>
          <p class="lobby-step__hint">Ask your brother for the 4-letter code he sees.</p>
          <input class="code-input lobby-code-input" maxlength="6" placeholder="CODE" autocomplete="off" />
          <p class="lobby-error" data-el="err"></p>
          <div class="lobby-step__actions">
            <button class="btn ghost" data-action="back">&larr; change mode</button>
            <button class="btn btn--primary" data-action="next">Continue &rarr;</button>
          </div>
        </div>
      `;
      const input = body.querySelector('.lobby-code-input');
      input.focus();
      const err = body.querySelector('[data-el="err"]');
      function submit() {
        const v = (input.value || '').toUpperCase().trim();
        if (v.length < 3) { err.textContent = 'That code looks too short.'; return; }
        chosenCode = v;
        goToCharacter();
      }
      input.addEventListener('input', () => {
        input.value = input.value.toUpperCase();
        err.textContent = '';
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      body.querySelector('[data-action="back"]').addEventListener('click', goToModeStep);
      body.querySelector('[data-action="next"]').addEventListener('click', submit);
    }

    function goToModeStep() {
      chosenCode = null;
      body.innerHTML = `
        <div class="mode-grid">
          <button class="mode-tile" data-mode="single">
            <div class="mode-tile__icon">&#9971;</div>
            <div class="mode-tile__name">Solo round</div>
            <div class="mode-tile__sub">Practice — 3 holes, just you</div>
          </button>
          <button class="mode-tile" data-mode="cpu">
            <div class="mode-tile__icon">&#129302;</div>
            <div class="mode-tile__name">Vs CPU</div>
            <div class="mode-tile__sub">Pick an opponent and difficulty</div>
          </button>
          <button class="mode-tile mode-tile--primary" data-mode="host">
            <div class="mode-tile__icon">&#127942;</div>
            <div class="mode-tile__name">Host a match</div>
            <div class="mode-tile__sub">Get a code, send it to your brother</div>
          </button>
          <button class="mode-tile" data-mode="join">
            <div class="mode-tile__icon">&#128279;</div>
            <div class="mode-tile__name">Join a match</div>
            <div class="mode-tile__sub">Enter the code your brother shared</div>
          </button>
        </div>
      `;
      wireModeTiles();
    }

    function wireModeTiles() {
      body.querySelectorAll('.mode-tile').forEach((tile) => {
        tile.addEventListener('click', () => {
          chosenMode = tile.dataset.mode;
          goToRoundLength();
        });
      });
    }
    wireModeTiles();
  });
}
