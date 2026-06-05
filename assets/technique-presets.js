/**
 * Built-in Playbook presets. Loaded before member-profile.js / auth.js.
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

  const EXHIBITIONISM = [
    { id: "ex_show_more", label: "Show more of yourself" },
    { id: "ex_hold_gaze", label: "Hold my gaze" },
    { id: "ex_tease_view", label: "Tease the view" },
    { id: "ex_own_moment", label: "Own the moment" },
    { id: "ex_let_witness", label: "Let me witness you" },
  ];

  const PLAYFUL = [
    { id: "play_try_together", label: "Try something new together" },
    { id: "play_curiosity", label: "Follow curiosity" },
    { id: "play_light_tease", label: "Light teasing" },
    { id: "play_playful_moment", label: "Playful moment" },
    { id: "play_discover", label: "Discover together" },
  ];

  const BDSM_BASICS = [
    { id: "bdsm_check_in", label: "Check in with me" },
    { id: "bdsm_safe_word", label: "Use our safe word" },
    { id: "bdsm_slow_build", label: "Slow build-up" },
    { id: "bdsm_clear_consent", label: "Confirm consent" },
    { id: "bdsm_aftercare", label: "Aftercare moment" },
  ];

  const BONDAGE = [
    { id: "bond_hold_still", label: "Hold still for me" },
    { id: "bond_give_slack", label: "Give some slack" },
    { id: "bond_trust_hold", label: "Trust the hold" },
    { id: "bond_release_moment", label: "Release moment" },
    { id: "bond_feel_restraint", label: "Feel the restraint" },
  ];

  const SHIBARI = [
    { id: "shibari_pose", label: "Hold the pose" },
    { id: "shibari_breathe", label: "Breathe into the tie" },
    { id: "shibari_trust_rope", label: "Trust the rope" },
    { id: "shibari_adjust", label: "Adjust the tie" },
    { id: "shibari_surrender_rope", label: "Surrender to the rope" },
  ];

  const IMPACT_PLAY = [
    { id: "impact_light_tap", label: "Light tap" },
    { id: "impact_build_rhythm", label: "Build a rhythm" },
    { id: "impact_count_down", label: "Count with me" },
    { id: "impact_hold_still", label: "Stay still for impact" },
    { id: "impact_warm_up", label: "Warm up first" },
  ];

  const SENSORY_PLAY = [
    { id: "sensory_blindfold", label: "Blindfold moment" },
    { id: "sensory_heighten", label: "Heighten sensation" },
    { id: "sensory_whisper", label: "Whisper only" },
    { id: "sensory_feather_touch", label: "Feather-light touch" },
    { id: "sensory_anticipate", label: "Anticipate touch" },
  ];

  const POWER_EXCHANGE = [
    { id: "power_yield_decision", label: "Yield a decision" },
    { id: "power_ask_permission", label: "Ask permission" },
    { id: "power_give_command", label: "Give a command" },
    { id: "power_obey_once", label: "Obey once" },
    { id: "power_renegotiate", label: "Renegotiate power" },
  ];

  const SOFT = [
    { id: "soft_slow_touch", label: "Slow gentle touch" },
    { id: "soft_tender_words", label: "Tender words" },
    { id: "soft_cuddle_moment", label: "Cuddle moment" },
    { id: "soft_kiss_slow", label: "Slow kiss" },
    { id: "soft_hold_close", label: "Hold close" },
  ];

  const EXPERIMENTAL = [
    { id: "exp_try_new", label: "Try something new" },
    { id: "exp_surprise_me", label: "Surprise me" },
    { id: "exp_push_edge", label: "Gently push the edge" },
    { id: "exp_swap_roles", label: "Swap roles briefly" },
    { id: "exp_unscripted", label: "Go unscripted" },
  ];

  const HARDCORE = [
    { id: "hard_intense_focus", label: "Intense focus" },
    { id: "hard_hold_nothing_back", label: "Hold nothing back" },
    { id: "hard_deep_pressure", label: "Deep pressure" },
    { id: "hard_sustain_intensity", label: "Sustain intensity" },
    { id: "hard_commit_moment", label: "Commit fully" },
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

  const KINK_SECTIONS = [
    { key: "bdsm_basics", title: "BDSM basics", items: BDSM_BASICS },
    { key: "bondage", title: "Bondage / Restraints", items: BONDAGE },
    { key: "shibari", title: "Shibari", items: SHIBARI },
    { key: "impact_play", title: "Impact play", items: IMPACT_PLAY },
    { key: "sensory_play", title: "Sensory play", items: SENSORY_PLAY },
    { key: "power_exchange", title: "Power exchange", items: POWER_EXCHANGE },
  ];

  const INTENSITY_SECTIONS = [
    { key: "soft", title: "Soft / Vanilla-plus", items: SOFT },
    { key: "experimental", title: "Experimental", items: EXPERIMENTAL },
    { key: "hardcore", title: "Hardcore / Intensive", items: HARDCORE },
  ];

  function dedupeById(list) {
    const map = new Map();
    for (const item of list) {
      if (!map.has(item.id)) map.set(item.id, item);
    }
    return [...map.values()];
  }

  function allPresets() {
    return dedupeById([
      ...DOM,
      ...SUB,
      ...EXHIBITIONISM,
      ...PLAYFUL,
      ...BDSM_BASICS,
      ...BONDAGE,
      ...SHIBARI,
      ...IMPACT_PLAY,
      ...SENSORY_PLAY,
      ...POWER_EXCHANGE,
      ...SOFT,
      ...EXPERIMENTAL,
      ...HARDCORE,
      ...LEGACY,
    ]);
  }

  /** Visible Playbook sections — only for checked profile preferences. */
  function presetSectionsForPlayPrefs(playPrefs) {
    const dynamics = new Set(playPrefs?.dynamics || []);
    const kinks = new Set(playPrefs?.kinks || []);
    const intensity = new Set(playPrefs?.intensity || []);
    const sections = [];

    if (dynamics.has("dom") || dynamics.has("switch")) {
      sections.push({ key: "dom", title: "Dom", items: DOM });
    }
    if (dynamics.has("sub") || dynamics.has("switch")) {
      sections.push({ key: "sub", title: "Sub", items: SUB });
    }
    if (dynamics.has("exhibitionism")) {
      sections.push({ key: "exhibitionism", title: "Exhibitionism", items: EXHIBITIONISM });
    }
    if (dynamics.has("playful")) {
      sections.push({ key: "playful", title: "Playful / Exploring", items: PLAYFUL });
    }

    KINK_SECTIONS.forEach((section) => {
      if (kinks.has(section.key)) sections.push(section);
    });
    INTENSITY_SECTIONS.forEach((section) => {
      if (intensity.has(section.key)) sections.push(section);
    });

    return sections;
  }

  function presetIdsForPlayPrefs(playPrefs) {
    const ids = new Set();
    presetSectionsForPlayPrefs(playPrefs).forEach((section) => {
      section.items.forEach((item) => ids.add(item.id));
    });
    return ids;
  }

  /** @deprecated use presetSectionsForPlayPrefs */
  function presetSectionsForDynamics(dynamics) {
    return presetSectionsForPlayPrefs({ dynamics, kinks: [], intensity: [] });
  }

  /** @deprecated use presetIdsForPlayPrefs */
  function presetIdsForDynamics(dynamics) {
    return presetIdsForPlayPrefs({ dynamics, kinks: [], intensity: [] });
  }

  function presetsForGender(gender) {
    void gender;
    return dedupeById([
      ...DOM,
      ...SUB,
      ...EXHIBITIONISM,
      ...PLAYFUL,
      ...BDSM_BASICS,
      ...BONDAGE,
      ...SHIBARI,
      ...IMPACT_PLAY,
      ...SENSORY_PLAY,
      ...POWER_EXCHANGE,
      ...SOFT,
      ...EXPERIMENTAL,
      ...HARDCORE,
    ]);
  }

  function allBuiltinIds() {
    return new Set(allPresets().map((t) => t.id));
  }

  global.DualPeerTechniques = {
    DOM,
    SUB,
    EXHIBITIONISM,
    PLAYFUL,
    BDSM_BASICS,
    BONDAGE,
    SHIBARI,
    IMPACT_PLAY,
    SENSORY_PLAY,
    POWER_EXCHANGE,
    SOFT,
    EXPERIMENTAL,
    HARDCORE,
    LEGACY,
    allPresets,
    presetSectionsForPlayPrefs,
    presetIdsForPlayPrefs,
    presetSectionsForDynamics,
    presetIdsForDynamics,
    presetsForGender,
    allBuiltinIds,
  };
})(window);
