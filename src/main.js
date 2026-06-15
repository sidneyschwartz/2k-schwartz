// Menu router. Mounts the chosen sport into #sport-host.

import { mountTennis } from './sports/tennis.js';
import { mountGolf } from './sports/golf/golf.js';

const menu = document.getElementById('menu');
const host = document.getElementById('sport-host');

let unmount = null;

function showMenu() {
  if (unmount) { try { unmount(); } catch {} unmount = null; }
  host.innerHTML = '';
  host.classList.add('hidden');
  menu.classList.remove('hidden');
}

function showSport(sport) {
  menu.classList.add('hidden');
  host.classList.remove('hidden');
  host.innerHTML = '';
  if (sport === 'tennis') unmount = mountTennis(host, showMenu);
  else if (sport === 'golf') unmount = mountGolf(host, showMenu);
}

document.querySelectorAll('.sport:not(.disabled)').forEach((b) => {
  b.addEventListener('click', () => showSport(b.dataset.sport));
});

showMenu();
