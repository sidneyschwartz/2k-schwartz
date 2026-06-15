// Golf lobby flow. Asks for mode (single / host / join) and character; produces
// the config that golf.js needs to boot.
//
// showLobby(host) -> Promise<{ mode: 'single'|'host'|'join', code?: string, character }>

import { showCharacterSelect } from './character-select.js';

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

    function exit() {
      screen.remove();
      resolve(null);
    }
    screen.querySelector('[data-action="exit"]').addEventListener('click', exit);

    function goToCharacter() {
      body.innerHTML = '';
      showCharacterSelect(body).then((ch) => {
        chosenChar = ch;
        finish();
      });
    }

    function finish() {
      screen.remove();
      resolve({ mode: chosenMode, code: chosenCode || undefined, character: chosenChar });
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
          if (chosenMode === 'single') goToCharacter();
          else if (chosenMode === 'host') goToHostCode();
          else if (chosenMode === 'join') goToJoinCode();
        });
      });
    }
    wireModeTiles();
  });
}
