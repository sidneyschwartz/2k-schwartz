// Menu router.
//   Golf  → Sid's game (lobby → mode/round/character → play). Fully built out.
//   Tennis → Wilson's sandbox to build out. See src/sports/tennis/START_HERE.md.
//
// Dev shortcuts: ?golf=1 boots straight into a solo golf round; ?tennis=1 boots
// straight into tennis. Otherwise the menu shows.

import { mountGolf } from './sports/golf/golf.js';
import { showLobby } from './sports/golf/lobby.js';
import { mountTennis } from './sports/tennis/tennis.js';

const params = new URLSearchParams(location.search);

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

function startTennis() {
  menu.classList.add('hidden');
  host.classList.remove('hidden');
  host.innerHTML = '';
  unmount = mountTennis(host, showMenu);
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
    else if (b.dataset.sport === 'tennis') startTennis();
  });
});

if (params.get('golf') === '1') bootDirectGolf();
else if (params.get('tennis') === '1') startTennis();
else showMenu();
