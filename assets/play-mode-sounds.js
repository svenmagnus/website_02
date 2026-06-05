/**
 * Play Mode request sounds — Web Audio presets, localStorage, partner sync.
 * Your selection is what the partner hears when you send a Play Mode request.
 */
(function (global) {
  const STORAGE_KEY = "dualpeer-play-mode-sound-v1";
  const DEFAULT_SOUND = "chime";

  let audioCtx = null;
  let lastPlayedAt = 0;
  let serverSyncTimer = null;

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

  function playNoiseBurst(ctx, { start, duration, peak, filterFreq, filterEndFreq, q = 2.5 }) {
    const sampleCount = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = q;
    filter.frequency.setValueAtTime(filterFreq, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(filterEndFreq, 40), start + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start(start);
    source.stop(start + duration + 0.03);
  }

  function playVocal(ctx, { start, duration, baseFreq, vibratoHz = 5.5, peak = 0.16, pitchDrop = null, vibratoDepth = 0.045 }) {
    const osc = ctx.createOscillator();
    const vibrato = ctx.createOscillator();
    const vibratoGain = ctx.createGain();
    vibrato.type = "sine";
    vibrato.frequency.value = vibratoHz;
    vibratoGain.gain.value = baseFreq * vibratoDepth;
    vibrato.connect(vibratoGain);
    vibratoGain.connect(osc.frequency);
    osc.type = "sine";
    osc.frequency.setValueAtTime(baseFreq, start);
    if (pitchDrop != null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(pitchDrop, 40), start + duration * 0.55);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.05);
    vibrato.start(start);
    vibrato.stop(start + duration + 0.05);

    const formant = ctx.createOscillator();
    const formantGain = ctx.createGain();
    formant.type = "sine";
    formant.frequency.setValueAtTime(baseFreq * 2.35, start);
    if (pitchDrop != null) {
      formant.frequency.exponentialRampToValueAtTime(Math.max(pitchDrop * 2.1, 80), start + duration * 0.5);
    }
    formantGain.gain.setValueAtTime(0.0001, start);
    formantGain.gain.exponentialRampToValueAtTime(peak * 0.48, start + 0.028);
    formantGain.gain.exponentialRampToValueAtTime(0.0001, start + duration * 0.88);
    formant.connect(formantGain);
    formantGain.connect(ctx.destination);
    formant.start(start);
    formant.stop(start + duration + 0.05);
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
    {
      id: "whip",
      label: "Whip",
      play(ctx, now) {
        playNoiseBurst(ctx, { start: now, duration: 0.11, peak: 0.62, filterFreq: 5200, filterEndFreq: 220, q: 4.2 });
        playTone(ctx, { freq: 2800, start: now, duration: 0.05, type: "sawtooth", peak: 0.22, endFreq: 120 });
        playNoiseBurst(ctx, { start: now + 0.03, duration: 0.08, peak: 0.38, filterFreq: 2400, filterEndFreq: 90, q: 2.4 });
        playTone(ctx, { freq: 1600, start: now + 0.045, duration: 0.04, type: "triangle", peak: 0.14, endFreq: 80 });
      },
    },
    {
      id: "moan",
      label: "Moan",
      play(ctx, now) {
        playVocal(ctx, { start: now, duration: 1.05, baseFreq: 128, vibratoHz: 4.6, peak: 0.32, vibratoDepth: 0.07 });
        playVocal(ctx, { start: now + 0.1, duration: 0.88, baseFreq: 172, vibratoHz: 5.8, peak: 0.22, vibratoDepth: 0.06 });
        playVocal(ctx, { start: now + 0.22, duration: 0.72, baseFreq: 205, vibratoHz: 6.2, peak: 0.14, vibratoDepth: 0.05 });
      },
    },
    {
      id: "ouch",
      label: "Ouch",
      play(ctx, now) {
        playVocal(ctx, { start: now, duration: 0.42, baseFreq: 520, vibratoHz: 9, peak: 0.38, pitchDrop: 140, vibratoDepth: 0.08 });
        playNoiseBurst(ctx, { start: now, duration: 0.06, peak: 0.18, filterFreq: 3200, filterEndFreq: 400, q: 2.8 });
        playTone(ctx, { freq: 680, start: now + 0.08, duration: 0.12, type: "square", peak: 0.12, endFreq: 180 });
      },
    },
  ];

  const presetById = new Map(SOUND_PRESETS.map((p) => [p.id, p]));

  function readStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { local: DEFAULT_SOUND, partner: null };
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string" && presetById.has(parsed)) {
        return { local: parsed, partner: null };
      }
      if (parsed && typeof parsed === "object") {
        return {
          local: presetById.has(parsed.local) ? parsed.local : DEFAULT_SOUND,
          partner: parsed.partner && presetById.has(parsed.partner) ? parsed.partner : null,
        };
      }
    } catch (_) {
      /* ignore */
    }
    return { local: DEFAULT_SOUND, partner: null };
  }

  function writeStore(next) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          local: presetById.has(next.local) ? next.local : DEFAULT_SOUND,
          partner: next.partner && presetById.has(next.partner) ? next.partner : null,
        })
      );
    } catch (_) {
      /* ignore */
    }
  }

  function loadSoundId() {
    return readStore().local;
  }

  function loadPartnerSoundId() {
    return readStore().partner;
  }

  function saveSoundId(id) {
    const store = readStore();
    store.local = presetById.has(id) ? id : DEFAULT_SOUND;
    writeStore(store);
    return store.local;
  }

  function setPartnerSoundId(id) {
    if (!id || !presetById.has(id)) return;
    const store = readStore();
    store.partner = id;
    writeStore(store);
  }

  function resolveIncomingSoundId(explicitId) {
    if (explicitId && presetById.has(explicitId)) return explicitId;
    const partner = loadPartnerSoundId();
    if (partner && presetById.has(partner)) return partner;
    return DEFAULT_SOUND;
  }

  function shareMyPlayModeSound() {
    global.dispatchEvent(new CustomEvent("dualpeer-play-mode-sound-share"));
    global.dispatchEvent(new CustomEvent("dualpeer-profile-share-request"));
    syncMyPlayModeSoundToServer();
  }

  function syncMyPlayModeSoundToServer() {
    if (!global.DualPeerAuth?.isLoggedIn?.() || !global.DualPeerAuth?.updateProfile) return;
    clearTimeout(serverSyncTimer);
    serverSyncTimer = setTimeout(() => {
      global.DualPeerAuth.updateProfile({ playModeSound: loadSoundId() }).catch(() => {});
    }, 350);
  }

  async function playSoundById(soundId) {
    const nowMs = Date.now();
    if (nowMs - lastPlayedAt < 700) return;
    lastPlayedAt = nowMs;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      if (ctx.state === "suspended") await ctx.resume();
      if (ctx.state !== "running") return;
      const preset = presetById.get(soundId) || presetById.get(DEFAULT_SOUND);
      preset.play(ctx, ctx.currentTime);
    } catch (_) {
      /* ignore audio errors */
    }
  }

  async function playLocalPreview() {
    return playSoundById(loadSoundId());
  }

  async function playIncomingRequestSound(soundId) {
    return playSoundById(resolveIncomingSoundId(soundId));
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
    syncMyPlayModeSoundToServer();
    const sel = document.getElementById("playModeRequestSound");
    sel?.addEventListener("change", () => {
      if (sel instanceof HTMLSelectElement) {
        saveSoundId(sel.value);
        shareMyPlayModeSound();
      }
    });
    document.getElementById("btnPlayModeSoundPreview")?.addEventListener("click", () => {
      unlockAudio();
      playLocalPreview();
    });

    global.addEventListener("dualpeer-partner-profile", (e) => {
      const id = e.detail?.profile?.playModeSound;
      if (id) setPartnerSoundId(id);
    });
  }

  global.playTechniqueBell = playIncomingRequestSound;
  global.unlockTechniqueBellAudio = unlockAudio;
  global.DualPeerPlayModeSounds = {
    listPresets: () => SOUND_PRESETS.map(({ id, label }) => ({ id, label })),
    loadSoundId,
    loadPartnerSoundId,
    saveSoundId,
    setPartnerSoundId,
    resolveIncomingSoundId,
    preview: playLocalPreview,
    playById: playSoundById,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPlayModeSoundUI);
  } else {
    initPlayModeSoundUI();
  }
})(window);
