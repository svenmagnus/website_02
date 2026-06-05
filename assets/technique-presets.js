/**
 * Built-in Playbook presets (Dom / Sub). Loaded before member-profile.js / auth.js.
 * Labels describe actions between partners, not model instructions.
 */
(function (global) {
  const DOM = [
    { id: "dom_set_pace", label: "Set the pace" },
    { id: "dom_guide_us", label: "Guide us" },
    { id: "dom_hold_space", label: "Hold the space" },
    { id: "dom_take_initiative", label: "Take initiative" },
    { id: "dom_lead_moment", label: "Lead the moment" },
  ];

  const SUB = [
    { id: "sub_follow_lead", label: "Follow your lead" },
    { id: "sub_yield_control", label: "Yield control" },
    { id: "sub_trust_pace", label: "Trust your pace" },
    { id: "sub_surrender_moment", label: "Surrender the moment" },
    { id: "sub_receive_direction", label: "Receive your direction" },
  ];

  /** Legacy ids from older profiles — still accepted when loading saved data. */
  const LEGACY = [
    { id: "send_kiss", label: "Send a kiss" },
    { id: "tease_denial", label: "Tease me" },
    { id: "dirty_talk", label: "Dirty talk" },
    { id: "roleplay", label: "Roleplay" },
    { id: "affection", label: "Affection" },
    { id: "jerk_off", label: "Your pleasure" },
    { id: "body_worship", label: "Focus on you" },
    { id: "spank_ass", label: "Playful impact" },
    { id: "nipple_play", label: "Physical connection" },
    { id: "fingering", label: "Show me more" },
    { id: "spank_breast", label: "Tease me" },
    { id: "deepen_view", label: "Deepen the view" },
  ];

  function dedupeById(list) {
    const map = new Map();
    for (const item of list) {
      if (!map.has(item.id)) map.set(item.id, item);
    }
    return [...map.values()];
  }

  function allPresets() {
    return dedupeById([...DOM, ...SUB, ...LEGACY]);
  }

  /** Sections for My Playbook based on dynamics role prefs. */
  function presetSectionsForDynamics(dynamics) {
    const set = new Set(Array.isArray(dynamics) ? dynamics : []);
    const showDom = set.has("dom") || set.has("switch");
    const showSub = set.has("sub") || set.has("switch");
    return [
      { key: "dom", title: "Dom", items: DOM, enabled: showDom },
      { key: "sub", title: "Sub", items: SUB, enabled: showSub },
    ];
  }

  function presetIdsForDynamics(dynamics) {
    const ids = new Set();
    presetSectionsForDynamics(dynamics).forEach((section) => {
      if (!section.enabled) return;
      section.items.forEach((item) => ids.add(item.id));
    });
    return ids;
  }

  function presetsForGender(gender) {
    void gender;
    return dedupeById([...DOM, ...SUB]);
  }

  function allBuiltinIds() {
    return new Set(allPresets().map((t) => t.id));
  }

  global.DualPeerTechniques = {
    DOM,
    SUB,
    LEGACY,
    allPresets,
    presetSectionsForDynamics,
    presetIdsForDynamics,
    presetsForGender,
    allBuiltinIds,
  };
})(window);
