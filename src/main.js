// Menu router. Golf is the only sport for now: Menu → Golf → lobby (mode + round
// length + character) → game.
//
// Dev shortcut: append ?golf=1 to the URL to skip the menu and boot straight into a
// solo round (handy for live iteration). Otherwise the menu shows.

import { mountGolf } from './sports/golf/golf.js';
import { showLobby } from './sports/golf/lobby.js';

const BOOT_DIRECT = new URLSearchParams(location.search).get('golf') === '1';

const menu = document.getElementById('menu');
const host = document.getElementById('sport-host');

let unmount = null;

function showMenu() {
  if (unmount) { try { unmount(); } catch {} unmount = null; }
  host.innerHTML = '';
  host.classList.add('hidden');
  menu.classList.remove('hidden');
}

async function startGolf() {
  menu.classList.add('hidden');
  host.classList.remove('hidden');
  host.innerHTML = '';
  const cfg = await showLobby(host);
  if (!cfg) { showMenu(); return; }     // user backed out of the lobby
  host.innerHTML = '';
  unmount = mountGolf(host, { ...cfg, onExit: showMenu });
}

function bootDirectGolf() {
  menu.classList.add('hidden');
  host.classList.remove('hidden');
  host.innerHTML = '';
  unmount = mountGolf(host, {
    mode: 'single',
    character: { id: 'tiger', name: 'Tiger Woods' },
    onExit: showMenu,
  });
}

document.querySelectorAll('.sport:not(.disabled)').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.sport === 'golf') startGolf();
  });
});

if (BOOT_DIRECT) bootDirectGolf();
else showMenu();
