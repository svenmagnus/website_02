/**
 * Profile play preferences — dynamics, kink, intensity (checkbox groups).
 */
(function (global) {
  const DYNAMICS = [
    { id: "dom", label: "Dominant (Dom)" },
    { id: "sub", label: "Submissive (Sub)" },
    { id: "switch", label: "Switch" },
    { id: "exhibitionism", label: "Exhibitionism" },
    { id: "playful", label: "Playful / Exploring" },
  ];

  const KINKS = [
    { id: "bdsm_basics", label: "BDSM basics" },
    { id: "bondage", label: "Bondage / Restraints" },
    { id: "shibari", label: "Shibari" },
    { id: "impact_play", label: "Impact play" },
    { id: "sensory_play", label: "Sensory play" },
    { id: "power_exchange", label: "Power exchange" },
  ];

  const INTENSITY = [
    { id: "soft", label: "Soft / Vanilla-plus" },
    { id: "experimental", label: "Experimental" },
    { id: "hardcore", label: "Hardcore / Intensive" },
  ];

  const ALL_IDS = {
    dynamics: new Set(DYNAMICS.map((o) => o.id)),
    kinks: new Set(KINKS.map((o) => o.id)),
    intensity: new Set(INTENSITY.map((o) => o.id)),
  };

  function normalizePlayPrefs(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const pick = (key) =>
      Array.isArray(src[key])
        ? [...new Set(src[key].filter((id) => ALL_IDS[key].has(id)))]
        : [];
    return {
      dynamics: pick("dynamics"),
      kinks: pick("kinks"),
      intensity: pick("intensity"),
    };
  }

  global.DualPeerPlayPrefs = {
    DYNAMICS,
    KINKS,
    INTENSITY,
    normalizePlayPrefs,
  };
})(window);
