/**
 * Play Mode request notification sounds — Web Audio presets + localStorage selection.
 */
(function (global) {
  const STORAGE_KEY = "dualpeer-play-mode-sound-v1";
  const DEFAULT_SOUND = "chime";

  let audioCtx = null;
  let lastPlayedAt = 0;

  function getAudioContext() {
    const Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    return audioCtx;
  }

  function unlockAudio() {
    try {
      const ctx = getAudioContext();
      if (ctx?.state === "suspended") ctx.resume().catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  function playTone(ctx, { freq, start, duration, type = "triangle", peak = 0.22, endFreq = null }) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (endFreq != null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), start + duration);
    }
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }

  const SOUND_PRESETS = [
    {
      id: "chime",
      label: "Chime",
      play(ctx, now) {
        playTone(ctx, { freq: 988, start: now, duration: 0.16, peak: 0.24 });
        playTone(ctx, { freq: 740, start: now + 0.19, duration: 0.32, peak: 0.26 });
      },
    },
    {
      id: "ding",
      label: "Ding",
      play(ctx, now) {
        playTone(ctx, { freq: 880, start: now, duration: 0.45, type: "sine", peak: 0.28 });
      },
    },
    {
      id: "triple",
      label: "Triple beep",
      play(ctx, now) {
        [0, 0.14, 0.28].forEach((offset) => {
          playTone(ctx, { freq: 920, start: now + offset, duration: 0.08, type: "square", peak: 0.14 });
        });
      },
    },
    {
      id: "soft-bell",
      label: "Soft bell",
      play(ctx, now) {
        playTone(ctx, { freq: 660, start: now, duration: 0.55, type: "sine", peak: 0.2 });
        playTone(ctx, { freq: 1320, start: now, duration: 0.35, type: "sine", peak: 0.08 });
      },
    },
    {
      id: "ping",
      label: "Ping",
      play(ctx, now) {
        playTone(ctx, { freq: 1400, start: now, duration: 0.12, type: "sine", peak: 0.26 });
      },
    },
    {
      id: "marimba",
      label: "Marimba",
      play(ctx, now) {
        playTone(ctx, { freq: 880, start: now, duration: 0.18, type: "triangle", peak: 0.2, endFreq: 440 });
      },
    },
    {
      id: "blip",
      label: "Blip",
      play(ctx, now) {
        playTone(ctx, { freq: 520, start: now, duration: 0.07, type: "square", peak: 0.12 });
        playTone(ctx, { freq: 780, start: now + 0.09, duration: 0.07, type: "square", peak: 0.12 });
      },
    },
    {
      id: "sweep",
      label: "Rising sweep",
      play(ctx, now) {
        playTone(ctx, { freq: 320, start: now, duration: 0.35, type: "sawtooth", peak: 0.1, endFreq: 960 });
      },
    },
    {
      id: "doorbell",
      label: "Doorbell",
      play(ctx, now) {
        playTone(ctx, { freq: 784, start: now, duration: 0.22, type: "sine", peak: 0.22 });
        playTone(ctx, { freq: 523, start: now + 0.28, duration: 0.38, type: "sine", peak: 0.24 });
      },
    },
    {
      id: "harp",
      label: "Harp",
      play(ctx, now) {
        [523, 659, 784, 988].forEach((freq, i) => {
          playTone(ctx, { freq, start: now + i * 0.07, duration: 0.22, type: "triangle", peak: 0.16 });
        });
      },
    },
  ];

  const presetById = new Map(SOUND_PRESETS.map((p) => [p.id, p]));

  function loadSoundId() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw && presetById.has(raw)) return raw;
    } catch (_) {
      /* ignore */
    }
    return DEFAULT_SOUND;
  }

  function saveSoundId(id) {
    const next = presetById.has(id) ? id : DEFAULT_SOUND;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch (_) {
      /* ignore */
    }
    return next;
  }

  async function playSelectedSound() {
    const nowMs = Date.now();
    if (nowMs - lastPlayedAt < 700) return;
    lastPlayedAt = nowMs;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      if (ctx.state === "suspended") await ctx.resume();
      if (ctx.state !== "running") return;
      const preset = presetById.get(loadSoundId()) || presetById.get(DEFAULT_SOUND);
      preset.play(ctx, ctx.currentTime);
    } catch (_) {
      /* ignore audio errors */
    }
  }

  function fillSoundSelect() {
    const sel = document.getElementById("playModeRequestSound");
    if (!(sel instanceof HTMLSelectElement)) return;
    const current = loadSoundId();
    sel.replaceChildren();
    for (const preset of SOUND_PRESETS) {
      const opt = document.createElement("option");
      opt.value = preset.id;
      opt.textContent = preset.label;
      if (preset.id === current) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function initPlayModeSoundUI() {
    fillSoundSelect();
    const sel = document.getElementById("playModeRequestSound");
    sel?.addEventListener("change", () => {
      if (sel instanceof HTMLSelectElement) saveSoundId(sel.value);
    });
    document.getElementById("btnPlayModeSoundPreview")?.addEventListener("click", () => {
      unlockAudio();
      playSelectedSound();
    });
  }

  global.playTechniqueBell = playSelectedSound;
  global.unlockTechniqueBellAudio = unlockAudio;
  global.DualPeerPlayModeSounds = {
    listPresets: () => SOUND_PRESETS.map(({ id, label }) => ({ id, label })),
    loadSoundId,
    saveSoundId,
    preview: playSelectedSound,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPlayModeSoundUI);
  } else {
    initPlayModeSoundUI();
  }
})(window);
