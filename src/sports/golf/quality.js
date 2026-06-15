// Graphics quality presets. settings.js shows the picker; engine calls applyQuality()
// after mounting scene/visuals/environment to dial down expensive features per level.

import * as THREE from 'three';
//
// Levels:
//   low    — 1.0 DPR, 1024 shadow map, post-FX off, 30% grass density, water reflection off
//   medium — 1.25 DPR, 1536 shadow map, post-FX on, 60% grass density, water reflection 256
//   high   — 1.5 DPR, 2048 shadow map, post-FX on, 100% grass density, water reflection 512
//
// Anything beyond high is throttled at the renderer level so devicePixelRatio=3
// laptops don't melt. Cap is 1.5 even on high.

export const QUALITY_LEVELS = ['low', 'medium', 'high'];

export const QUALITY_PRESETS = {
  low: {
    label: 'Low',
    pixelRatio: 1.0,
    shadowMapSize: 1024,
    shadowType: 'BasicShadowMap',
    postFx: false,
    grassDensity: 0.30,
    treeDensity: 0.60,
    waterReflection: false,
    waterReflectionSize: 0,
    waterEveryOtherFrame: true,
  },
  medium: {
    label: 'Medium',
    pixelRatio: 1.25,
    shadowMapSize: 1536,
    shadowType: 'PCFShadowMap',
    postFx: true,
    grassDensity: 0.60,
    treeDensity: 0.85,
    waterReflection: true,
    waterReflectionSize: 256,
    waterEveryOtherFrame: true,
  },
  high: {
    label: 'High',
    pixelRatio: 1.5,
    shadowMapSize: 2048,
    shadowType: 'PCFSoftShadowMap',
    postFx: true,
    grassDensity: 1.00,
    treeDensity: 1.00,
    waterReflection: true,
    waterReflectionSize: 512,
    waterEveryOtherFrame: false,
  },
};

export function getQualityPreset(level) {
  return QUALITY_PRESETS[level] ?? QUALITY_PRESETS.medium;
}

// Apply a quality preset to the live engine handles. Any handle can be null —
// the function only touches whatever it's given. This is what engine code calls
// when the user changes the dropdown.
export function applyQuality(level, handles = {}) {
  const preset = getQualityPreset(level);
  const { renderer, visuals, environment } = handles;

  if (renderer) {
    const dpr = Math.min(window.devicePixelRatio || 1, preset.pixelRatio);
    renderer.setPixelRatio(dpr);
    // Trigger a re-layout so canvas matches the new ratio.
    const size = renderer.getSize(new THREE.Vector2());
    renderer.setSize(size.x, size.y, false);
  }

  if (visuals) {
    // Composer toggle — visuals.js exposes `composer`. We don't dispose it (cheap to keep);
    // engine reads `qualityPreset.postFx` to decide whether to render through it.
    if (visuals.sunLight) {
      const s = preset.shadowMapSize;
      if (visuals.sunLight.shadow.mapSize.x !== s) {
        visuals.sunLight.shadow.mapSize.set(s, s);
        // Force shadow map re-init.
        if (visuals.sunLight.shadow.map) {
          visuals.sunLight.shadow.map.dispose();
          visuals.sunLight.shadow.map = null;
        }
      }
    }
    if (visuals.bloomPass) visuals.bloomPass.enabled = preset.postFx;
    if (visuals.smaaPass) visuals.smaaPass.enabled = preset.postFx;
  }

  if (environment) {
    // environment.js is owned by art-director; honor whatever knob names they expose.
    if (typeof environment.setGrassDensity === 'function') environment.setGrassDensity(preset.grassDensity);
    if (typeof environment.setTreeDensity === 'function') environment.setTreeDensity(preset.treeDensity);
    if (typeof environment.setWaterReflection === 'function') {
      environment.setWaterReflection(preset.waterReflection, preset.waterReflectionSize);
    }
  }

  return preset;
}

