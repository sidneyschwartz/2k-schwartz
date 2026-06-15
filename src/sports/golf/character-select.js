// Full-screen character select for golf. Renders live 3D portraits of each
// golfer using the actual mesh from characters.js. Mouse, keyboard (←/→,
// Enter), and gamepad (D-pad / A) navigable.
//
// Resolves with a character descriptor object:
//   { id: 'tiger' | 'brunson', name, tagline, accent }
//
// The engine + physics agent treats the `id` as the character key passed to
// createGolfer(). The lobby (UI agent) treats the full object as the player's
// chosen character — both consumers are happy.

import * as THREE from 'three';
import { createGolfer, CHARACTER_PRESETS } from './characters.js';

const CHARACTERS = [
  {
    id: 'tiger',
    name: 'Tiger Schwartz',
    tagline: 'Sunday red. Ice in the veins.',
    accent: '#ffcc33',
    avatar: 'T',
  },
  {
    id: 'brunson',
    name: 'Brunson Schwartz',
    tagline: 'Knicks captain, big stick energy.',
    accent: '#1f6dd6',
    avatar: 'B',
  },
];

export function listCharacters() { return CHARACTERS.slice(); }

const STYLE_ID = 'golf-character-select-style';
const STYLE = `
  .lobby-step--character {
    display: flex; flex-direction: column; align-items: center;
    color: #f5f5f7; font-family: system-ui, -apple-system, Segoe UI, sans-serif;
  }
  .lobby-step--character .lobby-title {
    font-size: 28px; font-weight: 800; margin: 6px 0 22px; letter-spacing: -0.01em;
  }
  .character-grid {
    display: flex; gap: 24px; justify-content: center; flex-wrap: wrap;
  }
  .character-card {
    width: 240px; padding: 14px 14px 18px; border-radius: 16px;
    background: linear-gradient(160deg, rgba(255,255,255,0.07), rgba(255,255,255,0.02));
    border: 2px solid rgba(255,255,255,0.10);
    color: inherit; text-align: center; cursor: pointer;
    transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
    display: flex; flex-direction: column; align-items: center; gap: 10px;
  }
  .character-card:hover { transform: translateY(-3px); }
  .character-card.selected {
    border-color: var(--accent, #ffd24a);
    box-shadow: 0 0 0 4px rgba(255,210,74,0.18), 0 12px 36px rgba(0,0,0,0.45);
    transform: translateY(-5px);
  }
  .character-card__portrait {
    width: 100%; height: 220px; border-radius: 12px; overflow: hidden;
    background: linear-gradient(180deg, #6da7e0 0%, #b5d3ec 70%, #c4d6a8 100%);
    position: relative;
  }
  .character-card__portrait canvas { display: block; width: 100%; height: 100%; }
  .character-card__avatar {
    position: absolute; top: 8px; left: 10px;
    width: 28px; height: 28px; border-radius: 999px;
    background: var(--accent, #ffd24a); color: #221b00;
    font-weight: 800; font-size: 14px;
    display: flex; align-items: center; justify-content: center;
  }
  .character-card__name { font-size: 18px; font-weight: 700; margin-top: 2px; }
  .character-card__tag { font-size: 12px; color: #aab6d0; }
  .character-hint {
    margin-top: 18px; font-size: 11px; color: #6f7e9c;
    letter-spacing: 0.18em; text-transform: uppercase;
  }
`;

function ensureStyle(target) {
  if (target.querySelector?.(`#${STYLE_ID}`)) return null;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (target.ownerDocument?.head ?? document.head).appendChild(style);
  return style;
}

function renderPortrait(canvas, characterId) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) {
    console.warn('[character-select] WebGL portrait unavailable', e);
    return () => {};
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    28,
    Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1),
    0.1, 50,
  );
  camera.position.set(2.0, 1.55, 3.6);
  camera.lookAt(0, 1.0, 0);

  const key = new THREE.DirectionalLight(0xffe7c2, 2.4);
  key.position.set(3, 4, 4);
  scene.add(key);
  const fill = new THREE.HemisphereLight(0x8fb4ff, 0x3a5530, 0.7);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0x6da7e0, 1.0);
  rim.position.set(-3, 3, -2);
  scene.add(rim);

  let golfer;
  try {
    golfer = createGolfer({ character: characterId });
    golfer.setSwingState('idle');
    scene.add(golfer.group);
  } catch (e) {
    console.warn('[character-select] golfer build failed', e);
  }

  const clock = new THREE.Clock();
  let running = true;
  function loop() {
    if (!running) return;
    const dt = clock.getDelta();
    if (golfer) {
      golfer.group.rotation.y += dt * 0.25;
      golfer.update(dt);
    }
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  loop();

  return () => {
    running = false;
    try { renderer.dispose(); } catch {}
  };
}

export function showCharacterSelect(host) {
  return new Promise((resolve) => {
    const mountTarget = host && host.appendChild ? host : document.body;
    const ownedStyle = ensureStyle(mountTarget);

    const wrap = document.createElement('div');
    wrap.className = 'lobby-step lobby-step--character';
    wrap.innerHTML = `
      <h2 class="lobby-title">Choose your golfer</h2>
      <div class="character-grid">
        ${CHARACTERS.map((c) => `
          <div class="character-card" data-id="${c.id}" style="--accent:${c.accent}">
            <div class="character-card__portrait">
              <span class="character-card__avatar">${c.avatar}</span>
              <canvas></canvas>
            </div>
            <div class="character-card__name">${c.name}</div>
            <div class="character-card__tag">${c.tagline}</div>
          </div>
        `).join('')}
      </div>
      <div class="character-hint">← → to switch · Enter / A to confirm</div>
    `;
    mountTarget.appendChild(wrap);

    const cards = [...wrap.querySelectorAll('.character-card')];
    const cleanups = [];

    cards.forEach((card, i) => {
      const canvas = card.querySelector('canvas');
      const id = card.dataset.id;
      requestAnimationFrame(() => {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
        try {
          cleanups.push(renderPortrait(canvas, id));
        } catch (e) {
          console.warn('[character-select] portrait failed', e);
        }
      });
      card.addEventListener('mouseenter', () => setIdx(i));
      card.addEventListener('click', () => { setIdx(i); confirm(); });
    });

    let idx = 0;
    function setIdx(n) {
      idx = ((n % cards.length) + cards.length) % cards.length;
      cards.forEach((c, i) => c.classList.toggle('selected', i === idx));
    }
    setIdx(0);

    let confirmed = false;
    function confirm() {
      if (confirmed) return;
      confirmed = true;
      cleanup();
      const chosen = CHARACTERS.find((c) => c.id === cards[idx].dataset.id) || CHARACTERS[0];
      // Augment with preset metadata so callers can read e.g. shirt color if desired.
      const preset = CHARACTER_PRESETS[chosen.id] ?? null;
      resolve({ ...chosen, preset });
    }

    function onKey(e) {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        setIdx(idx - 1); e.preventDefault();
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        setIdx(idx + 1); e.preventDefault();
      } else if (e.key === 'Enter' || e.key === ' ') {
        confirm(); e.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);

    let padPrev = { left: false, right: false, a: false };
    const padTimer = setInterval(() => {
      const pads = navigator.getGamepads?.() ?? [];
      for (const p of pads) {
        if (!p) continue;
        const left = p.buttons[14]?.pressed || (p.axes[0] ?? 0) < -0.5;
        const right = p.buttons[15]?.pressed || (p.axes[0] ?? 0) > 0.5;
        const a = p.buttons[0]?.pressed;
        if (left && !padPrev.left) setIdx(idx - 1);
        if (right && !padPrev.right) setIdx(idx + 1);
        if (a && !padPrev.a) { confirm(); }
        padPrev = { left, right, a };
        break;
      }
    }, 80);

    function cleanup() {
      clearInterval(padTimer);
      window.removeEventListener('keydown', onKey);
      cleanups.forEach((fn) => { try { fn(); } catch {} });
      try { wrap.remove(); } catch {}
      if (ownedStyle) { try { ownedStyle.remove(); } catch {} }
    }
  });
}
