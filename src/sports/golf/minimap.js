// Overhead minimap of the current hole. Renders holeData.regions top-down with
// surface-typed colors, plus tee/pin/ball markers. The ball position is sampled
// each rAF from the golf controller's getBallPos().
//
// mountMinimap(host, { getHoleData, getBallPos, getActiveTrail? }) -> {
//   unmount(), setExpanded(bool), toggle(), setVisible(bool)
// }

const SURFACE_COLOR = {
  tee: '#a3d076',
  fairway: '#5fa14a',
  rough: '#3d6a35',
  green: '#82c46a',
  sand: '#e6d2a1',
  water: '#2a6db5',
};

const PAD_M = 14;          // world-meter padding around bounding box
const ASPECT_BIAS = 1.4;   // visual taller-than-wide tilt for hole orientation

export function mountMinimap(host, getters = {}) {
  const {
    getHoleData = () => null,
    getBallPos = () => ({ x: 0, y: 0, z: 0 }),
  } = getters;

  const root = document.createElement('div');
  root.className = 'golf-minimap';
  root.innerHTML = `
    <div class="golf-minimap__hint" data-el="hint">[M] map</div>
    <canvas class="golf-minimap__canvas" data-el="canvas"></canvas>
  `;
  host.appendChild(root);

  const canvas = root.querySelector('[data-el="canvas"]');
  const ctx = canvas.getContext('2d');
  const hint = root.querySelector('[data-el="hint"]');

  let expanded = false;
  let visible = true;
  let raf = 0;
  let cachedHoleNumber = null;
  let bgCanvas = null;        // pre-rendered terrain layer
  let bbox = null;            // { minX, maxX, minZ, maxZ }
  let ballTrail = [];
  let lastTrailPos = null;

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = root.clientWidth;
    const h = root.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function projectionFor(data, w, h) {
    // Compute bbox of all regions + tee + pin.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const consider = (x, z, r = 0) => {
      if (x - r < minX) minX = x - r;
      if (x + r > maxX) maxX = x + r;
      if (z - r < minZ) minZ = z - r;
      if (z + r > maxZ) maxZ = z + r;
    };
    consider(data.tee?.x ?? 0, data.tee?.z ?? 0, 4);
    consider(data.pin?.x ?? 0, data.pin?.z ?? 0, 4);
    for (const r of data.regions || []) {
      if (r.shape === 'rect') {
        consider(r.x, r.z, Math.max(r.w, r.d) / 2);
      } else if (r.shape === 'circle' || r.shape === 'ring') {
        consider(r.x, r.z, r.r2 || r.r);
      } else if (r.shape === 'spline') {
        for (const p of r.points || []) consider(p.x, p.z, (p.w || 6) / 2);
      }
    }
    minX -= PAD_M; maxX += PAD_M; minZ -= PAD_M; maxZ += PAD_M;
    bbox = { minX, maxX, minZ, maxZ };

    // Tee→pin should run roughly bottom→top of the panel; map (x,z) → (px,py)
    // with x=horizontal, z=vertical (inverted so pin is at top).
    const worldW = maxX - minX;
    const worldH = (maxZ - minZ) * ASPECT_BIAS;
    const scale = Math.min(w / worldW, h / worldH);
    const offX = (w - worldW * scale) / 2 - minX * scale;
    const offY = (h + maxZ * scale * ASPECT_BIAS - (h - worldH * scale) / 2);
    return {
      worldToScreen(wx, wz) {
        const sx = wx * scale + offX;
        const sy = offY - wz * scale * ASPECT_BIAS;
        return [sx, sy];
      },
      scale,
    };
  }

  function drawTerrain(data) {
    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);
    bgCanvas = document.createElement('canvas');
    bgCanvas.width = canvas.width;
    bgCanvas.height = canvas.height;
    const bctx = bgCanvas.getContext('2d');
    bctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);

    // Rough fill base.
    bctx.fillStyle = SURFACE_COLOR.rough;
    bctx.fillRect(0, 0, w, h);

    const proj = projectionFor(data, w, h);

    // Draw regions in order they appear (so green draws on top of fairway, etc.)
    for (const r of data.regions || []) {
      const color = SURFACE_COLOR[r.type] || SURFACE_COLOR.rough;
      if (r.shape === 'fill') continue; // handled by base rough
      bctx.fillStyle = color;
      bctx.strokeStyle = 'rgba(0,0,0,0.15)';
      bctx.lineWidth = 0.5;
      if (r.shape === 'rect') {
        const [x1, y1] = proj.worldToScreen(r.x - r.w / 2, r.z - r.d / 2);
        const [x2, y2] = proj.worldToScreen(r.x + r.w / 2, r.z + r.d / 2);
        bctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      } else if (r.shape === 'circle') {
        const [cx, cy] = proj.worldToScreen(r.x, r.z);
        const rad = r.r * proj.scale;
        bctx.beginPath();
        bctx.arc(cx, cy, rad, 0, Math.PI * 2);
        bctx.fill();
      } else if (r.shape === 'ring') {
        const [cx, cy] = proj.worldToScreen(r.x, r.z);
        bctx.beginPath();
        bctx.arc(cx, cy, (r.r2) * proj.scale, 0, Math.PI * 2);
        bctx.arc(cx, cy, r.r * proj.scale, 0, Math.PI * 2, true);
        bctx.fill('evenodd');
      } else if (r.shape === 'spline') {
        drawSpline(bctx, r.points || [], proj, color);
      }
    }

    // Cache projection on bgCanvas for marker drawing.
    bgCanvas._proj = proj;
    bgCanvas._data = data;
  }

  function drawSpline(bctx, points, proj, color) {
    if (points.length < 2) return;
    // Approximate a thick polyline by filling a Path stroked with widening segments.
    bctx.fillStyle = color;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const wA = (a.w || 12) * 0.5;
      const wB = (b.w || 12) * 0.5;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      const [p1x, p1y] = proj.worldToScreen(a.x + nx * wA, a.z + nz * wA);
      const [p2x, p2y] = proj.worldToScreen(b.x + nx * wB, b.z + nz * wB);
      const [p3x, p3y] = proj.worldToScreen(b.x - nx * wB, b.z - nz * wB);
      const [p4x, p4y] = proj.worldToScreen(a.x - nx * wA, a.z - nz * wA);
      bctx.beginPath();
      bctx.moveTo(p1x, p1y);
      bctx.lineTo(p2x, p2y);
      bctx.lineTo(p3x, p3y);
      bctx.lineTo(p4x, p4y);
      bctx.closePath();
      bctx.fill();
    }
    // round caps at each control point
    for (const p of points) {
      const [cx, cy] = proj.worldToScreen(p.x, p.z);
      bctx.beginPath();
      bctx.arc(cx, cy, ((p.w || 12) * 0.5) * proj.scale, 0, Math.PI * 2);
      bctx.fill();
    }
  }

  function drawFrame() {
    const data = getHoleData();
    if (!data) {
      raf = requestAnimationFrame(drawFrame);
      return;
    }
    if (data.number !== cachedHoleNumber || !bgCanvas
        || bgCanvas.width !== canvas.width || bgCanvas.height !== canvas.height) {
      size();
      drawTerrain(data);
      cachedHoleNumber = data.number;
      ballTrail = [];
      lastTrailPos = null;
    }

    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);
    // Blit terrain
    ctx.drawImage(bgCanvas, 0, 0, w, h);

    const proj = bgCanvas._proj;
    // Tee marker
    const [tx, ty] = proj.worldToScreen(data.tee?.x ?? 0, data.tee?.z ?? 0);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(tx, ty, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    // Pin marker (flag triangle)
    const [px, py] = proj.worldToScreen(data.pin?.x ?? 0, data.pin?.z ?? 0);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, py + 6); ctx.lineTo(px, py - 8); ctx.stroke();
    ctx.fillStyle = '#e23b3b';
    ctx.beginPath();
    ctx.moveTo(px, py - 8);
    ctx.lineTo(px + 6, py - 6);
    ctx.lineTo(px, py - 4);
    ctx.closePath();
    ctx.fill();

    // Ball trail + ball
    const bp = getBallPos();
    if (bp) {
      if (!lastTrailPos || Math.hypot(bp.x - lastTrailPos.x, bp.z - lastTrailPos.z) > 1.5) {
        ballTrail.push([bp.x, bp.z]);
        if (ballTrail.length > 60) ballTrail.shift();
        lastTrailPos = { x: bp.x, z: bp.z };
      }
      if (ballTrail.length > 1) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const [sx0, sy0] = proj.worldToScreen(ballTrail[0][0], ballTrail[0][1]);
        ctx.moveTo(sx0, sy0);
        for (let i = 1; i < ballTrail.length; i++) {
          const [sx, sy] = proj.worldToScreen(ballTrail[i][0], ballTrail[i][1]);
          ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }
      const [bx, by] = proj.worldToScreen(bp.x, bp.z);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    raf = requestAnimationFrame(drawFrame);
  }
  size();
  raf = requestAnimationFrame(drawFrame);

  // Resize observer keeps the projection in sync when toggling expanded mode.
  const ro = new ResizeObserver(() => {
    cachedHoleNumber = null; // force re-render of terrain layer
  });
  ro.observe(root);

  function setExpanded(b) {
    expanded = !!b;
    root.classList.toggle('golf-minimap--expanded', expanded);
    hint.textContent = expanded ? '[M] close' : '[M] map';
  }
  function setVisible(b) {
    visible = !!b;
    root.style.display = visible ? '' : 'none';
  }

  function unmount() {
    cancelAnimationFrame(raf);
    ro.disconnect();
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  return { unmount, setExpanded, setVisible, toggle: () => setExpanded(!expanded), get expanded() { return expanded; } };
}
