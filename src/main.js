// Menu router. For golf we open the lobby first; for tennis we keep the
// original behaviour (its own lobby is inside the module).

import { mountTennis } from './sports/tennis.js';
import { mountGolf } from './sports/golf/golf.js';
import { showLobby } from './sports/golf/lobby.js';

const menu = document.getElementById('menu');
const host = document.getElementById('sport-host');

let unmount = null;

function showMenu() {
  if (unmount) { try { unmount(); } catch {} unmount = null; }
  host.innerHTML = '';
  host.classList.add('hidden');
  menu.classList.remove('hidden');
}

async function showSport(sport) {
  menu.classList.add('hidden');
  host.classList.remove('hidden');
  host.innerHTML = '';
  if (sport === 'tennis') {
    unmount = mountTennis(host, showMenu);
    return;
  }
  if (sport === 'golf') {
    const cfg = await showLobby(host);
    if (!cfg) { showMenu(); return; }
    host.innerHTML = '';
    unmount = mountGolf(host, { ...cfg, onExit: showMenu });
  }
}

document.querySelectorAll('.sport:not(.disabled)').forEach((b) => {
  b.addEventListener('click', () => showSport(b.dataset.sport));
});

showMenu();
