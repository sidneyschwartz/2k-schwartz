// End-of-round summary overlay. Shows the full scorecard with par-diff badges
// per hole + totals, plus Play Again / Back to Menu buttons.
//
// showRoundSummary(host, { players, par, currentHole, totalHoles, onPlayAgain, onExit })

const GRADE = (diff) => {
  if (diff <= -3) return { label: 'Albatross', cls: 'eagle' };
  if (diff === -2) return { label: 'Eagle', cls: 'eagle' };
  if (diff === -1) return { label: 'Birdie', cls: 'birdie' };
  if (diff === 0) return { label: 'Par', cls: 'par' };
  if (diff === 1) return { label: 'Bogey', cls: 'bogey' };
  if (diff === 2) return { label: 'Double', cls: 'double' };
  return { label: `+${diff}`, cls: 'double' };
};

export function showRoundSummary(host, opts = {}) {
  const {
    players = [],
    par = [],
    totalHoles = par.length,
    onPlayAgain,
    onExit,
  } = opts;

  const overlay = document.createElement('div');
  overlay.className = 'golf-summary';
  const winner = computeWinner(players, totalHoles);

  let parTotal = 0;
  let header = '<tr><th>Hole</th>';
  for (let i = 0; i < totalHoles; i++) header += `<th>${i + 1}</th>`;
  header += '<th>Total</th></tr>';

  let parRow = '<tr class="golf-summary__par-row"><th>Par</th>';
  for (let i = 0; i < totalHoles; i++) {
    const p = par[i] ?? '-';
    if (typeof p === 'number') parTotal += p;
    parRow += `<td>${p}</td>`;
  }
  parRow += `<td><strong>${parTotal || '-'}</strong></td></tr>`;

  let playerRows = '';
  for (const pl of players) {
    let total = 0;
    let diffTotal = 0;
    let row = `<tr><th class="golf-summary__name">${escapeHtml(pl.name || 'Player')}</th>`;
    for (let i = 0; i < totalHoles; i++) {
      const s = pl.scores?.[i];
      const p = par[i];
      if (typeof s === 'number') total += s;
      if (typeof s === 'number' && typeof p === 'number') {
        const diff = s - p;
        diffTotal += diff;
        const g = GRADE(diff);
        row += `<td class="golf-summary__score golf-summary__score--${g.cls}">${s}</td>`;
      } else {
        row += `<td class="golf-summary__score">${s != null ? s : '—'}</td>`;
      }
    }
    const diffLabel = diffTotal === 0 ? 'E' : (diffTotal > 0 ? `+${diffTotal}` : `${diffTotal}`);
    row += `<td><strong>${total || '-'}</strong> <small class="golf-summary__diff">(${diffLabel})</small></td></tr>`;
    playerRows += row;
  }

  overlay.innerHTML = `
    <div class="golf-summary__panel">
      <header class="golf-summary__header">
        <h2>Round complete</h2>
        ${winner ? `<p class="golf-summary__winner">${escapeHtml(winner)}</p>` : ''}
      </header>
      <table class="golf-summary__table">
        <thead>${header}${parRow}</thead>
        <tbody>${playerRows}</tbody>
      </table>
      <div class="golf-summary__legend">
        <span class="golf-summary__chip golf-summary__chip--eagle">Eagle</span>
        <span class="golf-summary__chip golf-summary__chip--birdie">Birdie</span>
        <span class="golf-summary__chip golf-summary__chip--par">Par</span>
        <span class="golf-summary__chip golf-summary__chip--bogey">Bogey</span>
        <span class="golf-summary__chip golf-summary__chip--double">Double+</span>
      </div>
      <div class="golf-summary__actions">
        <button class="btn ghost" data-action="exit">Back to menu</button>
        <button class="btn btn--primary" data-action="again">Play again</button>
      </div>
    </div>
  `;
  host.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('golf-summary--open'));

  overlay.querySelector('[data-action="exit"]').addEventListener('click', () => {
    cleanup();
    onExit?.();
  });
  overlay.querySelector('[data-action="again"]').addEventListener('click', () => {
    cleanup();
    onPlayAgain?.();
  });

  function cleanup() {
    overlay.classList.remove('golf-summary--open');
    setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 220);
  }

  return cleanup;
}

function computeWinner(players, holes) {
  if (players.length < 2) return null;
  const totals = players.map((p) => {
    let sum = 0;
    for (let i = 0; i < holes; i++) if (typeof p.scores?.[i] === 'number') sum += p.scores[i];
    return sum;
  });
  if (totals.some((t) => t === 0)) return null;
  const min = Math.min(...totals);
  const winners = players.filter((_, i) => totals[i] === min);
  if (winners.length > 1) return `Tie at ${min}`;
  return `${winners[0].name} wins (${min})`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
