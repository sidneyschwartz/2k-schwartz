// Golf MVP — stub. Phase 1 wires the Three.js scene, physics, swing meter, and 1-hole loop.
// This file currently shows a placeholder so the menu route works end-to-end.

export function mountGolf(host, onExit) {
  host.innerHTML = `
    <section class="screen">
      <h2>Golf</h2>
      <p class="tag">Tee box loading… (Phase 1 wires the 3D scene)</p>
      <p class="status">Coming next: Three.js scene + ball physics + three-click swing meter + Xbox controller.</p>
      <button class="back" id="golf-back">← back</button>
    </section>`;
  host.querySelector('#golf-back').addEventListener('click', () => onExit?.());
  return () => {};
}
