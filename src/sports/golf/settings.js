// Settings overlay for golf. Audio mute, camera distance, minimap toggle, aim-line toggle.
// Persists to localStorage. Doubles as the pause screen (engine loop freezes while open).
//
// mountSettings({ host, getController, onClose, onSetMuted, onSetCameraOffset,
//                 onSetMinimapVisible, onSetAimLineVisible }) -> {
//   open(), close(), toggle(), unmount(), getSettings()
// }

const STORAGE_KEY = '2k-schwartz.golf.settings.v1';

const DEFAULTS = {
  muted: false,
  cameraDistance: 6.5,
  minimap: true,
  aimLine: true,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const obj = JSON.parse(raw);
    return { ...DEFAULTS, ...obj };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

export function mountSettings(opts = {}) {
  const {
    host = document.body,
    onClose,
    onSetMuted,
    onSetCameraOffset,
    onSetMinimapVisible,
    onSetAimLineVisible,
    onResumeGame,
    onResetHole,
    onExitToMenu,
  } = opts;

  const settings = loadSettings();

  const overlay = document.createElement('div');
  overlay.className = 'golf-settings';
  overlay.innerHTML = `
    <div class="golf-settings__panel" role="dialog" aria-modal="true" aria-label="Settings">
      <header class="golf-settings__header">
        <h2>Paused</h2>
        <button class="golf-settings__close" data-action="close" aria-label="close">&times;</button>
      </header>
      <div class="golf-settings__rows">
        <label class="golf-settings__row">
          <span>Audio</span>
          <button class="toggle" data-action="mute" aria-pressed="${settings.muted}">
            <span class="toggle__label">${settings.muted ? 'Muted' : 'On'}</span>
          </button>
        </label>
        <label class="golf-settings__row">
          <span>Camera distance</span>
          <div class="golf-settings__slider">
            <input type="range" min="3" max="14" step="0.5" value="${settings.cameraDistance}" data-action="cameraDistance" />
            <span class="golf-settings__value" data-el="camDistVal">${settings.cameraDistance.toFixed(1)}m</span>
          </div>
        </label>
        <label class="golf-settings__row">
          <span>Minimap</span>
          <button class="toggle" data-action="minimap" aria-pressed="${settings.minimap}">
            <span class="toggle__label">${settings.minimap ? 'On' : 'Off'}</span>
          </button>
        </label>
        <label class="golf-settings__row">
          <span>Aim line</span>
          <button class="toggle" data-action="aimLine" aria-pressed="${settings.aimLine}">
            <span class="toggle__label">${settings.aimLine ? 'On' : 'Off'}</span>
          </button>
        </label>
      </div>
      <div class="golf-settings__footer">
        <button class="btn ghost" data-action="reset-hole">Reset hole</button>
        <button class="btn ghost" data-action="exit">Quit to menu</button>
        <button class="btn btn--primary" data-action="resume">Resume (P)</button>
      </div>
      <div class="golf-settings__hint">[P] pause · [M] map · [Esc] close</div>
    </div>
  `;
  host.appendChild(overlay);

  function update(key, val) {
    settings[key] = val;
    saveSettings(settings);
  }

  function close() {
    overlay.classList.remove('golf-settings--open');
    overlay.style.display = 'none';
    onClose?.();
  }
  function open() {
    overlay.style.display = '';
    // next frame to allow transition
    requestAnimationFrame(() => overlay.classList.add('golf-settings--open'));
  }
  // start closed
  overlay.style.display = 'none';

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      // Click on backdrop resumes.
      onResumeGame?.();
      close();
    }
  });

  overlay.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const a = el.dataset.action;
      if (a === 'close' || a === 'resume') {
        onResumeGame?.();
        close();
      } else if (a === 'reset-hole') {
        onResetHole?.();
        onResumeGame?.();
        close();
      } else if (a === 'exit') {
        onExitToMenu?.();
        close();
      } else if (a === 'mute') {
        const next = !settings.muted;
        update('muted', next);
        el.setAttribute('aria-pressed', String(next));
        el.querySelector('.toggle__label').textContent = next ? 'Muted' : 'On';
        onSetMuted?.(next);
      } else if (a === 'minimap') {
        const next = !settings.minimap;
        update('minimap', next);
        el.setAttribute('aria-pressed', String(next));
        el.querySelector('.toggle__label').textContent = next ? 'On' : 'Off';
        onSetMinimapVisible?.(next);
      } else if (a === 'aimLine') {
        const next = !settings.aimLine;
        update('aimLine', next);
        el.setAttribute('aria-pressed', String(next));
        el.querySelector('.toggle__label').textContent = next ? 'On' : 'Off';
        onSetAimLineVisible?.(next);
      }
    });
  });

  const camSlider = overlay.querySelector('[data-action="cameraDistance"]');
  const camLabel = overlay.querySelector('[data-el="camDistVal"]');
  camSlider.addEventListener('input', () => {
    const v = parseFloat(camSlider.value);
    update('cameraDistance', v);
    camLabel.textContent = v.toFixed(1) + 'm';
    onSetCameraOffset?.(v);
  });

  function unmount() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  return {
    open, close, unmount,
    toggle() {
      if (overlay.classList.contains('golf-settings--open')) { onResumeGame?.(); close(); }
      else open();
    },
    isOpen() { return overlay.classList.contains('golf-settings--open'); },
    getSettings() { return { ...settings }; },
  };
}
