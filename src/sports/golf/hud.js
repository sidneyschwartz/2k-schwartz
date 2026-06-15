// Golf HUD — DOM overlay on top of the Three.js canvas.
// Contract: mountHud(host, getters) returns unmount().
// getters: getMeter, getClub, getClubList, getWind, getStrokes, getHole, getPar, getScorecard
//
// getMeter() shape (tolerates both engine naming forms):
//   { phase: 'idle'|'rising'|'power-rising'|'locked'|'power-locked'|'accuracy'|'done',
//     power: 0..1, accuracy: -1..1, perfectZone: [-z, z], lockedPower: number|null }
//
// Updates run on rAF and mutate existing nodes (no DOM re-creation per frame).

import { clubs as defaultClubs } from './clubs.js';

const PHASE_LABEL = {
  'idle': 'CLICK / SPACE to swing',
  'rising': 'Lock POWER',
  'power-rising': 'Lock POWER',
  'locked': 'Power locked',
  'power-locked': 'Power locked',
  'accuracy': 'Lock ACCURACY',
  'done': 'Swinging…',
};

function normalizePhase(p) {
  if (p === 'power-rising') return 'rising';
  if (p === 'power-locked') return 'locked';
  return p || 'idle';
}

function clubCarryEstimate(club) {
  // Rough carry guess from maxPower (m/s ball speed) — matches physics tuning.
  if (!club) return 0;
  const map = { 'Driver': 230, '5-Iron': 170, '9-Iron': 120, 'Wedge': 80, 'Putter': 6 };
  if (map[club.name] != null) return map[club.name];
  // fall back: speed^2 * sin(2*loft) / g  (very rough)
  const v = club.maxPower || 50;
  const loft = club.loft || 0.3;
  return Math.round((v * v * Math.sin(2 * loft)) / 9.81);
}

export function mountHud(host, getters = {}) {
  const {
    getMeter = () => ({ phase: 'idle', power: 0, accuracy: 0, perfectZone: [-0.06, 0.06], lockedPower: null }),
    getClub = () => defaultClubs[0],
    getClubList = () => defaultClubs,
    getWind = () => ({ speed: 0, dirDeg: 0 }),
    getStrokes = () => 0,
    getHole = () => 1,
    getPar = () => 4,
    getScorecard = () => null,
    onSelectClub = null, // optional: HUD can call this to change club
  } = getters;

  const root = document.createElement('div');
  root.className = 'golf-hud';
  root.innerHTML = `
    <div class="golf-hud__topbar">
      <div class="golf-hud__panel golf-hud__hole">
        <div class="golf-hud__label">HOLE</div>
        <div class="golf-hud__hole-num" data-hud="hole">1</div>
        <div class="golf-hud__hole-par">PAR <span data-hud="par">4</span></div>
      </div>
      <div class="golf-hud__panel golf-hud__strokes">
        <div class="golf-hud__label">STROKES</div>
        <div class="golf-hud__strokes-num" data-hud="strokes">0</div>
      </div>
      <div class="golf-hud__panel golf-hud__wind">
        <div class="golf-hud__label">WIND</div>
        <div class="golf-hud__wind-row">
          <svg class="golf-hud__wind-arrow" data-hud="wind-arrow" viewBox="-12 -12 24 24" width="36" height="36">
            <path d="M0,-9 L6,6 L0,2 L-6,6 Z" fill="#e7ecff" stroke="#0008" stroke-width="0.5" stroke-linejoin="round"/>
          </svg>
          <div class="golf-hud__wind-speed"><span data-hud="wind-speed">0</span><small>mph</small></div>
        </div>
      </div>
    </div>

    <div class="golf-hud__turnbar" data-hud="turnbar" hidden>
      <span data-hud="turn-text">Your turn</span>
    </div>

    <div class="golf-hud__bottombar">
      <div class="golf-hud__panel golf-hud__club">
        <div class="golf-hud__label">CLUB</div>
        <div class="golf-hud__club-row">
          <button class="golf-hud__club-btn" data-hud-action="club-prev" aria-label="previous club">&#9664;</button>
          <div class="golf-hud__club-mid">
            <div class="golf-hud__club-name" data-hud="club-name">Driver</div>
            <div class="golf-hud__club-est"><span data-hud="club-carry">230</span> m carry</div>
          </div>
          <button class="golf-hud__club-btn" data-hud-action="club-next" aria-label="next club">&#9654;</button>
        </div>
        <div class="golf-hud__club-hint">[ / ] or D-pad to swap</div>
      </div>

      <div class="golf-hud__meter" data-hud="meter">
        <div class="golf-hud__meter-phase" data-hud="phase-label">CLICK / SPACE to swing</div>
        <div class="golf-hud__meter-track">
          <div class="golf-hud__meter-fill" data-hud="power-fill"></div>
          <div class="golf-hud__meter-lock" data-hud="power-lock" hidden></div>
          <div class="golf-hud__meter-zone" data-hud="accuracy-zone" hidden></div>
          <div class="golf-hud__meter-needle" data-hud="accuracy-needle" hidden></div>
        </div>
        <div class="golf-hud__meter-scale">
          <span>0</span><span>50</span><span>100%</span>
        </div>
      </div>
    </div>

    <div class="golf-hud__scorecard" data-hud="scorecard" hidden>
      <div class="golf-hud__sc-title">Scorecard</div>
      <table class="golf-hud__sc-table" data-hud="sc-table"></table>
    </div>
  `;
  host.appendChild(root);

  const els = {
    hole: root.querySelector('[data-hud="hole"]'),
    par: root.querySelector('[data-hud="par"]'),
    strokes: root.querySelector('[data-hud="strokes"]'),
    windArrow: root.querySelector('[data-hud="wind-arrow"]'),
    windSpeed: root.querySelector('[data-hud="wind-speed"]'),
    phaseLabel: root.querySelector('[data-hud="phase-label"]'),
    powerFill: root.querySelector('[data-hud="power-fill"]'),
    powerLock: root.querySelector('[data-hud="power-lock"]'),
    accZone: root.querySelector('[data-hud="accuracy-zone"]'),
    accNeedle: root.querySelector('[data-hud="accuracy-needle"]'),
    clubName: root.querySelector('[data-hud="club-name"]'),
    clubCarry: root.querySelector('[data-hud="club-carry"]'),
    scorecard: root.querySelector('[data-hud="scorecard"]'),
    scTable: root.querySelector('[data-hud="sc-table"]'),
    turnbar: root.querySelector('[data-hud="turnbar"]'),
    turnText: root.querySelector('[data-hud="turn-text"]'),
  };

  // Club picker buttons (optional — falls back to keys if no onSelectClub)
  function cycleClub(dir) {
    const list = getClubList() || defaultClubs;
    const cur = getClub();
    const idx = Math.max(0, list.findIndex((c) => c.name === cur?.name));
    const next = list[(idx + dir + list.length) % list.length];
    if (onSelectClub) onSelectClub(next.name);
  }
  root.querySelector('[data-hud-action="club-prev"]').addEventListener('click', () => cycleClub(-1));
  root.querySelector('[data-hud-action="club-next"]').addEventListener('click', () => cycleClub(+1));

  // Cache to avoid touching DOM when value unchanged.
  const last = {
    hole: null, par: null, strokes: null,
    windSpeed: null, windDir: null,
    phase: null, powerPct: null, lockPct: null,
    zone: null, needlePct: null,
    clubName: null, clubCarry: null,
    scorecardHash: null,
    turn: null,
  };

  let raf = 0;
  let active = true;

  function tick() {
    if (!active) return;

    // Top bar
    const hole = getHole();
    if (hole !== last.hole) { els.hole.textContent = String(hole); last.hole = hole; }
    const par = getPar();
    if (par !== last.par) { els.par.textContent = String(par); last.par = par; }
    const strokes = getStrokes();
    if (strokes !== last.strokes) { els.strokes.textContent = String(strokes); last.strokes = strokes; }

    const wind = getWind() || { speed: 0, dirDeg: 0 };
    if (wind.speed !== last.windSpeed) {
      els.windSpeed.textContent = String(Math.round(wind.speed || 0));
      last.windSpeed = wind.speed;
    }
    if (wind.dirDeg !== last.windDir) {
      // 0deg = blowing south (toward pin). Rotate arrow visually.
      els.windArrow.style.transform = `rotate(${wind.dirDeg || 0}deg)`;
      last.windDir = wind.dirDeg;
    }

    // Club
    const club = getClub() || defaultClubs[0];
    if (club.name !== last.clubName) {
      els.clubName.textContent = club.name;
      last.clubName = club.name;
      const carry = clubCarryEstimate(club);
      if (carry !== last.clubCarry) {
        els.clubCarry.textContent = String(carry);
        last.clubCarry = carry;
      }
    }

    // Meter
    const m = getMeter() || { phase: 'idle', power: 0, accuracy: 0 };
    const phase = normalizePhase(m.phase);
    if (phase !== last.phase) {
      els.phaseLabel.textContent = PHASE_LABEL[phase] || PHASE_LABEL.idle;
      last.phase = phase;
      // toggle visual elements
      els.powerLock.hidden = !(phase === 'locked' || phase === 'accuracy' || phase === 'done');
      const showAcc = (phase === 'accuracy' || phase === 'done');
      els.accZone.hidden = !showAcc;
      els.accNeedle.hidden = !showAcc;
      // colour cue
      const meter = root.querySelector('[data-hud="meter"]');
      meter.dataset.phase = phase;
    }

    // Power fill width (0..100%)
    const power = Math.max(0, Math.min(1, m.power || 0));
    const powerPct = Math.round(power * 1000) / 10;
    if (powerPct !== last.powerPct) {
      els.powerFill.style.width = powerPct + '%';
      last.powerPct = powerPct;
    }

    const lockedPower = (m.lockedPower != null) ? m.lockedPower : (phase !== 'idle' && phase !== 'rising' ? power : null);
    if (lockedPower != null) {
      const lockPct = Math.round(Math.max(0, Math.min(1, lockedPower)) * 1000) / 10;
      if (lockPct !== last.lockPct) {
        els.powerLock.style.left = lockPct + '%';
        last.lockPct = lockPct;
      }
    }

    if (phase === 'accuracy' || phase === 'done') {
      const zone = m.perfectZone || [-0.06, 0.06];
      const zKey = `${zone[0]}_${zone[1]}`;
      if (zKey !== last.zone) {
        const halfW = Math.abs(zone[1] - zone[0]) / 2;
        const widthPct = halfW * 100; // map -1..1 → 50% half-track
        els.accZone.style.width = (widthPct * 2) + '%';
        els.accZone.style.left = `calc(50% - ${widthPct}%)`;
        last.zone = zKey;
      }
      const acc = Math.max(-1, Math.min(1, m.accuracy || 0));
      const needlePct = 50 + acc * 50; // -1..1 → 0..100%
      if (needlePct !== last.needlePct) {
        els.accNeedle.style.left = needlePct + '%';
        last.needlePct = needlePct;
      }
    }

    // Scorecard
    const sc = getScorecard();
    if (sc) {
      const hash = JSON.stringify(sc);
      if (hash !== last.scorecardHash) {
        renderScorecard(els.scTable, sc);
        els.scorecard.hidden = false;
        last.scorecardHash = hash;
      }
    } else if (last.scorecardHash !== null) {
      els.scorecard.hidden = true;
      last.scorecardHash = null;
    }

    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  // public mutators for net code
  function setTurn(text) {
    if (text === last.turn) return;
    last.turn = text;
    if (!text) {
      els.turnbar.hidden = true;
    } else {
      els.turnbar.hidden = false;
      els.turnText.textContent = text;
    }
  }
  function showToast(text, ms = 1800) {
    const t = document.createElement('div');
    t.className = 'golf-hud__toast';
    t.textContent = text;
    root.appendChild(t);
    setTimeout(() => { t.classList.add('golf-hud__toast--out'); }, ms - 200);
    setTimeout(() => { t.remove(); }, ms);
  }

  // Expose mutators on the returned function for convenience.
  function unmount() {
    active = false;
    cancelAnimationFrame(raf);
    if (root.parentNode) root.parentNode.removeChild(root);
  }
  unmount.setTurn = setTurn;
  unmount.showToast = showToast;
  unmount.root = root;
  return unmount;
}

function renderScorecard(table, sc) {
  // sc: { players: [{name, scores: [..], total}], par: [4,3,5,...], holeCount, currentHole }
  const players = sc.players || [];
  const par = sc.par || [];
  const holes = sc.holeCount || par.length || (players[0]?.scores?.length ?? 0);
  let html = '<thead><tr><th>Hole</th>';
  for (let i = 0; i < holes; i++) html += `<th>${i + 1}</th>`;
  html += '<th>Tot</th></tr><tr><th>Par</th>';
  let parTotal = 0;
  for (let i = 0; i < holes; i++) {
    const p = par[i] != null ? par[i] : '-';
    if (typeof p === 'number') parTotal += p;
    html += `<td>${p}</td>`;
  }
  html += `<td>${parTotal || '-'}</td></tr></thead><tbody>`;
  for (const pl of players) {
    html += `<tr><th>${escapeHtml(pl.name || 'P?')}</th>`;
    let total = 0;
    for (let i = 0; i < holes; i++) {
      const s = pl.scores?.[i];
      if (typeof s === 'number') total += s;
      html += `<td>${s != null ? s : '—'}</td>`;
    }
    html += `<td>${total || '-'}</td></tr>`;
  }
  html += '</tbody>';
  table.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
