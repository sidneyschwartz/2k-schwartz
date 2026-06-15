// DEV: boot straight into solo Golf so we can see live progress without clicking
// through the menu + lobby every reload. To restore the menu flow, set
// `BOOT_DIRECT_TO_GOLF = false` (or remove this guard once the bug-hunt is done).

import { mountTennis } from './sports/tennis.js';
import { mountGolf } from './sports/golf/golf.js';
import { showLobby } from './sports/golf/lobby.js';

const BOOT_DIRECT_TO_GOLF = true;

const menu = document.getElementById('menu');
const host = document.getElementById('sport-host');

let unmount = null;

function showMenu() {
  if (unmount) { try { unmount(); } catch {} unmount = null; }
  host.innerHTML = '';
  host.classList.add('hidden');
  menu.classList.remove('hidden');
  if (BOOT_DIRECT_TO_GOLF) bootGolf();
}

function bootGolf() {
  menu.classList.add('hidden');
  host.classList.remove('hidden');
  host.innerHTML = '';
  unmount = mountGolf(host, {
    mode: 'single',
    character: { id: 'tiger', name: 'Tiger Woods' },
    onExit: () => {
      // On exit, re-boot directly into golf so we never get stuck on an empty page.
      if (BOOT_DIRECT_TO_GOLF) bootGolf();
      else showMenu();
    },
  });
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

// Boot.
if (BOOT_DIRECT_TO_GOLF) bootGolf();
else showMenu();
