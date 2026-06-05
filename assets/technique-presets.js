/**
 * Built-in technique presets (gender-aware). Loaded before member-profile.js / auth.js.
 * Labels describe actions between partners, not model instructions.
 */
(function (global) {
  const SHARED = [
    { id: "send_kiss", label: "Send a kiss" },
    { id: "tease_denial", label: "Tease me" },
    { id: "dirty_talk", label: "Dirty talk" },
    { id: "roleplay", label: "Roleplay" },
    { id: "affection", label: "Affection" },
  ];

  const MALE = [
    { id: "jerk_off", label: "Your pleasure" },
    { id: "body_worship", label: "Focus on you" },
    { id: "spank_ass", label: "Playful impact" },
    { id: "nipple_play", label: "Physical connection" },
  ];

  const FEMALE = [
    { id: "fingering", label: "Show me more" },
    { id: "nipple_play", label: "Physical connection" },
    { id: "spank_breast", label: "Tease me" },
    { id: "spank_ass", label: "Playful impact" },
    { id: "deepen_view", label: "Deepen the view" },
  ];

  /** Legacy ids from older profiles — still accepted when loading saved data. */
  const LEGACY = [
    { id: "spank_ass", label: "Playful impact" },
    { id: "spank_breast", label: "Tease me" },
    { id: "nipple_play", label: "Physical connection" },
    { id: "tease_denial", label: "Tease me" },
    { id: "body_worship", label: "Focus on you" },
    { id: "fingering", label: "Show me more" },
    { id: "jerk_off", label: "Your pleasure" },
  ];

  function dedupeById(list) {
    const map = new Map();
    for (const item of list) {
      if (!map.has(item.id)) map.set(item.id, item);
    }
    return [...map.values()];
  }

  function allPresets() {
    return dedupeById([...SHARED, ...MALE, ...FEMALE, ...LEGACY]);
  }

  function presetsForGender(gender) {
    if (gender === "male") return dedupeById([...MALE, ...SHARED]);
    if (gender === "female") return dedupeById([...FEMALE, ...SHARED]);
    return dedupeById([...SHARED, ...MALE, ...FEMALE]);
  }

  function allBuiltinIds() {
    return new Set(allPresets().map((t) => t.id));
  }

  global.DualPeerTechniques = {
    SHARED,
    MALE,
    FEMALE,
    allPresets,
    presetsForGender,
    allBuiltinIds,
  };
})(window);
