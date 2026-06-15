// Procedural Web Audio for golf. No binary assets — every sound is synthesized
// from oscillators, noise buffers, and biquad filters with short envelopes.
//
// Usage:
//   const audio = createAudio();
//   audio.play('club_hit_driver');
//   audio.play('ball_roll', { speed: 4 }); // looping; adjusts gain by speed
//   audio.tickAmbient(dt);
//   audio.setMuted(true);

const NAMES = [
  'click_meter',
  'club_hit_driver', 'club_hit_iron', 'club_hit_wedge', 'club_hit_putter',
  'ball_roll',
  'ball_splash',
  'ball_in_hole',
  'crowd_clap',
  'wind_ambient',
];

function makeNoiseBuffer(ctx, durationSec = 1.0, color = 'white') {
  const len = Math.floor(ctx.sampleRate * durationSec);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (color === 'white') {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  } else if (color === 'pink') {
    // Voss-McCartney approximation
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
      d[i] = p * 0.11;
    }
  } else if (color === 'brown') {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

function envGain(ctx, t0, attack, peak, sustain, release) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.linearRampToValueAtTime(sustain, t0 + attack + 0.02);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain * 0.5), t0 + attack + release * 0.5);
  g.gain.linearRampToValueAtTime(0.0001, t0 + attack + release);
  return g;
}

export function createAudio() {
  let ctx = null;
  let master = null;
  let ambientGain = null;
  let muted = false;
  let unlocked = false;
  let buffers = null;

  // Looping sources we manage:
  const loops = {
    ball_roll: { src: null, gain: null, filter: null, target: 0 },
    wind_ambient: { src: null, gain: null, filter: null },
  };

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.7;
    master.connect(ctx.destination);

    ambientGain = ctx.createGain();
    ambientGain.gain.value = 0.18;
    ambientGain.connect(master);

    buffers = {
      white: makeNoiseBuffer(ctx, 1.5, 'white'),
      pink: makeNoiseBuffer(ctx, 2.5, 'pink'),
      brown: makeNoiseBuffer(ctx, 1.5, 'brown'),
    };

    // Browsers require a user gesture to start audio. We optimistically resume;
    // any caller of play() will retry if it's still suspended.
    const resume = () => {
      if (ctx && ctx.state === 'suspended') ctx.resume();
      unlocked = true;
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
    };
    window.addEventListener('pointerdown', resume, { once: true });
    window.addEventListener('keydown', resume, { once: true });

    return ctx;
  }

  // ---------- one-shot synths ----------

  function playClick() {
    if (!ensureCtx() || muted) return;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    o.connect(g).connect(master);
    o.start(t0); o.stop(t0 + 0.06);
  }

  function playClubHit(kind) {
    if (!ensureCtx() || muted) return;
    const t0 = ctx.currentTime;
    // Noise transient
    const noise = ctx.createBufferSource();
    noise.buffer = buffers.white;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    const noiseGain = ctx.createGain();

    // Tonal body
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'triangle';

    let bodyFreq = 220, noiseQ = 6, noiseFreq = 2200, attack = 0.002, release = 0.18, peak = 0.6;
    if (kind === 'driver') { bodyFreq = 150; noiseFreq = 3600; noiseQ = 4; release = 0.30; peak = 0.85; }
    else if (kind === 'iron') { bodyFreq = 320; noiseFreq = 2400; release = 0.22; peak = 0.7; }
    else if (kind === 'wedge') { bodyFreq = 420; noiseFreq = 1400; release = 0.16; peak = 0.55; }
    else if (kind === 'putter') { bodyFreq = 540; noiseFreq = 900; noiseQ = 3; release = 0.08; peak = 0.35; }

    osc.frequency.setValueAtTime(bodyFreq * 2.2, t0);
    osc.frequency.exponentialRampToValueAtTime(bodyFreq, t0 + 0.04);
    oscGain.gain.setValueAtTime(0, t0);
    oscGain.gain.linearRampToValueAtTime(peak * 0.7, t0 + attack);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t0 + release);

    noiseFilter.frequency.value = noiseFreq;
    noiseFilter.Q.value = noiseQ;
    noiseGain.gain.setValueAtTime(0, t0);
    noiseGain.gain.linearRampToValueAtTime(peak, t0 + 0.002);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + release * 0.7);

    osc.connect(oscGain).connect(master);
    noise.connect(noiseFilter).connect(noiseGain).connect(master);
    osc.start(t0); osc.stop(t0 + release + 0.05);
    noise.start(t0); noise.stop(t0 + release + 0.05);
  }

  function playSplash() {
    if (!ensureCtx() || muted) return;
    const t0 = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = buffers.white;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(4500, t0);
    lp.frequency.exponentialRampToValueAtTime(400, t0 + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.8, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
    noise.connect(lp).connect(g).connect(master);
    noise.start(t0); noise.stop(t0 + 0.7);

    // bloop tonal: descending sine
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(380, t0);
    o.frequency.exponentialRampToValueAtTime(80, t0 + 0.35);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.4, t0);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
    o.connect(og).connect(master);
    o.start(t0); o.stop(t0 + 0.45);
  }

  function playBallInHole() {
    if (!ensureCtx() || muted) return;
    const t0 = ctx.currentTime;
    // Rim clink: two short metallic dings
    [0, 0.08].forEach((offset, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = i === 0 ? 1320 : 1760;
      const g = ctx.createGain();
      const start = t0 + offset;
      g.gain.setValueAtTime(0.5, start);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      o.connect(g).connect(master);
      o.start(start); o.stop(start + 0.2);
    });
    // soft cheer follow
    setTimeout(() => playCrowdClap(), 220);
  }

  function playCrowdClap() {
    if (!ensureCtx() || muted) return;
    const t0 = ctx.currentTime;
    const dur = 1.6;
    const noise = ctx.createBufferSource();
    noise.buffer = buffers.white;
    noise.loop = false;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.35, t0 + 0.15);
    g.gain.linearRampToValueAtTime(0.25, t0 + 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    noise.connect(bp).connect(g).connect(master);
    noise.start(t0); noise.stop(t0 + dur + 0.05);
  }

  // ---------- loops ----------

  function startBallRoll() {
    if (!ensureCtx() || muted) return;
    const slot = loops.ball_roll;
    if (slot.src) return;
    const src = ctx.createBufferSource();
    src.buffer = buffers.brown;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 220;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(master);
    src.start();
    slot.src = src; slot.filter = filter; slot.gain = gain;
  }

  function stopBallRoll() {
    const slot = loops.ball_roll;
    if (!slot.src) return;
    try { slot.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15); } catch {}
    setTimeout(() => {
      try { slot.src?.stop(); } catch {}
      slot.src = null; slot.gain = null; slot.filter = null;
    }, 200);
  }

  function setBallRollSpeed(speed) {
    if (!ensureCtx() || muted) { return; }
    const slot = loops.ball_roll;
    if (speed < 0.2) {
      slot.target = 0;
      if (slot.src) {
        try { slot.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.1); } catch {}
      }
      return;
    }
    if (!slot.src) startBallRoll();
    if (!slot.gain) return;
    const norm = Math.min(1, speed / 12);
    slot.target = norm * 0.35;
    try {
      slot.gain.gain.linearRampToValueAtTime(slot.target, ctx.currentTime + 0.08);
      slot.filter.frequency.linearRampToValueAtTime(120 + norm * 600, ctx.currentTime + 0.08);
    } catch {}
  }

  function startWindAmbient() {
    if (!ensureCtx() || muted) return;
    const slot = loops.wind_ambient;
    if (slot.src) return;
    const src = ctx.createBufferSource();
    src.buffer = buffers.pink;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 80;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(hp).connect(lp).connect(g).connect(ambientGain);
    src.start();
    // fade in
    try { g.gain.linearRampToValueAtTime(0.6, ctx.currentTime + 1.2); } catch {}
    slot.src = src; slot.gain = g; slot.filter = lp;
  }

  // Slow LFO on the wind filter for organic feel
  let _ambientClock = 0;
  function tickAmbient(dt) {
    if (!ctx) return;
    if (muted) return;
    if (!loops.wind_ambient.src) startWindAmbient();
    _ambientClock += dt;
    const lfo = 0.5 + 0.5 * Math.sin(_ambientClock * 0.35);
    const slot = loops.wind_ambient;
    if (slot.filter) {
      try {
        slot.filter.frequency.setTargetAtTime(450 + lfo * 500, ctx.currentTime, 0.4);
      } catch {}
    }
  }

  function setMuted(b) {
    muted = !!b;
    if (!ctx) return;
    try {
      master.gain.linearRampToValueAtTime(muted ? 0 : 0.7, ctx.currentTime + 0.1);
    } catch { master.gain.value = muted ? 0 : 0.7; }
    if (muted) {
      stopBallRoll();
      const w = loops.wind_ambient;
      if (w.src) {
        try { w.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2); } catch {}
        setTimeout(() => {
          try { w.src?.stop(); } catch {}
          w.src = null; w.gain = null; w.filter = null;
        }, 250);
      }
    }
  }

  function play(name, opts = {}) {
    if (!NAMES.includes(name)) return;
    ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try { ctx.resume(); } catch {}
    }
    switch (name) {
      case 'click_meter': return playClick();
      case 'club_hit_driver': return playClubHit('driver');
      case 'club_hit_iron': return playClubHit('iron');
      case 'club_hit_wedge': return playClubHit('wedge');
      case 'club_hit_putter': return playClubHit('putter');
      case 'ball_roll': return setBallRollSpeed(opts.speed ?? 0);
      case 'ball_splash': return playSplash();
      case 'ball_in_hole': return playBallInHole();
      case 'crowd_clap': return playCrowdClap();
      case 'wind_ambient': return startWindAmbient();
    }
  }

  return { play, tickAmbient, setMuted, get muted() { return muted; } };
}

// Map a club name string to the right SFX variant.
export function clubHitName(clubName) {
  const n = (clubName || '').toLowerCase();
  if (n.includes('driver')) return 'club_hit_driver';
  if (n.includes('putter')) return 'club_hit_putter';
  if (n.includes('wedge')) return 'club_hit_wedge';
  return 'club_hit_iron';
}
