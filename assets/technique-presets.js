/**
 * Built-in technique presets (gender-aware). Loaded before member-profile.js / auth.js.
 */
(function (global) {
  const SHARED = [
    { id: "tease_denial", label: "Tease / denial" },
    { id: "dirty_talk", label: "Dirty talk" },
    { id: "roleplay", label: "Roleplay" },
  ];

  const MALE = [
    { id: "jerk_off", label: "Jerk off" },
    { id: "body_worship", label: "Body worship" },
    { id: "spank_ass", label: "Spank ass" },
    { id: "nipple_play", label: "Nipple play" },
  ];

  const FEMALE = [
    { id: "fingering", label: "Fingering" },
    { id: "nipple_play", label: "Nipple play" },
    { id: "spank_breast", label: "Spank breast" },
    { id: "spank_ass", label: "Spank ass" },
  ];

  /** Legacy ids from older profiles — still accepted when loading saved data. */
  const LEGACY = [
    { id: "spank_ass", label: "Spank ass" },
    { id: "spank_breast", label: "Spank breast" },
    { id: "nipple_play", label: "Nipple play" },
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
