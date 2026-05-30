/**
 * Lovense Cam Extension bridge for Dual-Peer remote control.
 *
 * Default: DIRECT MOTOR mode (window.DUALPEER_DIRECT_MOTOR !== false)
 *   → lovense.sendCommand Vibrate/Preset/Stop per toy — independent of Stream Master Basic Levels.
 *   → Basic Levels in Stream Master can stay disabled (fine for Chaturbate + this site multistreaming).
 *
 * Fallback: receiveTip + token ranges when direct motor fails (set DUALPEER_DIRECT_MOTOR = false).
 */
(function (global) {
  const state = {
    ready: false,
    instance: null,
    error: null,
    toys: [],
    version: null,
    pendingTips: [],
  };

  /** Re-fire tips before Stream Master reaction time ends (tip fallback only). */
  const HOLD_REFRESH_MS = 3200;
  const holdIntervals = Object.create(null);
  /** Re-send direct motor commands while level is held (direct motor mode). */
  const MOTOR_HOLD_REFRESH_MS = 3000;
  const motorHoldIntervals = Object.create(null);
  /** Preset patterns (earthquake, …) — finite bursts, refreshed while checkbox is on. */
  const PRESET_PATTERN_SEC = 20;
  const PRESET_HOLD_REFRESH_MS = 17000;
  const presetHoldIntervals = Object.create(null);
  /** Last normal intensity per toy — used to restore after a special pattern ends. */
  const toyBaseSessions = Object.create(null);
  /** Cached Stream Master settings from getSettings() — warnings only, not for token override. */
  let cachedStreamSettings = null;

  function dispatch(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function flushPendingTips() {
    if (!state.ready || !state.instance) return;
    while (state.pendingTips.length) {
      const tip = state.pendingTips.shift();
      try {
        if (tip.toyId) {
          sendTipViaCamExtension(tip.amount, tip.tipperName, tip.toyId);
        } else {
          state.instance.receiveTip(tip.amount, tip.tipperName, tip.cParameter || {});
        }
      } catch (e) {
        console.error("[Lovense] tip (queued) failed:", e);
      }
    }
  }

  /** Minimum tokens that reliably trigger the Cam Extension (matches local test button). */
  const MIN_RECEIVE_TIP_TOKENS = 25;

  function hasLovenseSendCommand() {
    return typeof global.lovense !== "undefined" && typeof global.lovense.sendCommand === "function";
  }

  function isDirectMotorMode() {
    return global.DUALPEER_DIRECT_MOTOR !== false;
  }

  /** Toys available for sendCommand (extension list or LAN toyMap). */
  function hasToysForCommands() {
    const extToys = Array.isArray(state.toys) ? state.toys : [];
    const extOnline = extToys.some(
      (t) => t && (t.status === "on" || t.status === 1 || t.status === "1")
    );
    if (extOnline) return true;
    return isLovenseLanOnline();
  }

  /** Help lan.js isToyOnline() when toys come from Cam Extension only. */
  function syncLovenseToyMapFromExtension() {
    if (!hasLovenseSendCommand() || typeof global.lovense.setConnectCallbackData !== "function") {
      return;
    }
    const toys = {};
    (Array.isArray(state.toys) ? state.toys : []).forEach((t) => {
      if (!t?.id) return;
      const on = t.status === "on" || t.status === 1 || t.status === "1";
      toys[String(t.id)] = {
        id: String(t.id),
        name: t.type || t.name || "",
        status: on ? 1 : 0,
      };
    });
    if (Object.keys(toys).length) {
      global.lovense.setConnectCallbackData({ toys });
    }
  }

  function isLovenseLanOnline() {
    if (!hasLovenseSendCommand()) return false;
    try {
      return typeof global.lovense.isToyOnline === "function" && global.lovense.isToyOnline();
    } catch (_) {
      return false;
    }
  }

  async function refreshStreamSettings() {
    if (!state.instance || typeof state.instance.getSettings !== "function") {
      cachedStreamSettings = null;
      return null;
    }
    try {
      cachedStreamSettings = await state.instance.getSettings();
      return cachedStreamSettings;
    } catch (e) {
      console.warn("[Lovense] getSettings failed:", e);
      return null;
    }
  }

  /**
   * Send a preset tip to the Cam Extension widget.
   * Uses token values inside Stream Master von-bis ranges (LOVENSE_PRESET_TOKENS in app.js).
   * Per-toy: sendMessage with reactToys first, then global receiveTip.
   */
  function firePresetTip(tokens, tipperName, toyId) {
    const tipTokens = Math.round(Number(tokens) || 0);
    if (!tipTokens || tipTokens < 1) return { ok: false, method: "no-tokens" };

    const name = String(tipperName || "Remote").slice(0, 40);
    const resolvedId = toyId ? resolveToyId(toyId) : null;

    if (resolvedId && sendTipViaCamExtension(tipTokens, name, resolvedId, { exactTokens: true })) {
      return { ok: true, method: "tipMessage", toyId: resolvedId, tokens: tipTokens };
    }
    if (receiveTip(tipTokens, name, {}, { exactTokens: true })) {
      return { ok: true, method: "receiveTip", tokens: tipTokens };
    }
    return { ok: false, method: "tip-failed" };
  }

  function getStreamMasterWarnings() {
    const warnings = [];
    if (!cachedStreamSettings?.levels) {
      warnings.push("Stream Master settings not loaded — open Lovense widget once.");
      return warnings;
    }
    Object.keys(cachedStreamSettings.levels).forEach((key) => {
      const row = cachedStreamSettings.levels[key];
      if (!row) return;
      const v = Number(row.vLevel);
      if (v === 0) {
        warnings.push(`${key}: vibration strength (vLevel) is 0 — tips will not move the toy.`);
      }
    });
    return warnings;
  }

  function receiveTip(amount, tipperName, cParameter, options) {
    const raw = Math.round(Number(amount) || 0);
    if (!raw || raw < 1) return false;
    const tokens = options?.exactTokens ? raw : Math.max(MIN_RECEIVE_TIP_TOKENS, raw);
    const name = String(tipperName || "Remote").slice(0, 40);
    const opts = cParameter && typeof cParameter === "object" ? cParameter : {};

    if (!state.instance) {
      if (!state.ready) {
        state.pendingTips.push({ amount: tokens, tipperName: name, cParameter: opts });
      }
      return false;
    }

    try {
      state.instance.receiveTip(tokens, name, opts);
      return true;
    } catch (e) {
      console.error("[Lovense] receiveTip failed:", e);
      return false;
    }
  }

  function lookupToyMeta(toyId) {
    const id = String(toyId || "");
    if (!id) return null;
    const toys = Array.isArray(state.toys) ? state.toys : [];
    return toys.find((t) => t && String(t.id) === id) || null;
  }

  function levelToStrength(level) {
    const lv = Math.max(0, Math.min(100, Number(level) || 0));
    if (lv <= 0) return 0;
    return Math.max(1, Math.min(20, Math.round((lv / 100) * 20)));
  }

  /** Distinct motor levels per preset slider position (sendCommand fallback). */
  function strengthForLevel(level) {
    const lv = Math.max(0, Math.min(100, Number(level) || 0));
    const presetMap = { 20: 5, 45: 10, 70: 15, 85: 18, 100: 20 };
    if (presetMap[lv] != null) return presetMap[lv];
    return levelToStrength(lv);
  }

  function stopHardwareOnly(toyId) {
    return stopToyHardware(toyId);
  }

  function listLovenseCommandToys() {
    const out = [];
    const seen = new Set();

    function add(t) {
      if (!t || typeof t !== "object") return;
      const id = t.id || t.toyId || t.deviceId;
      if (!id) return;
      const key = String(id);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t);
    }

    if (hasLovenseSendCommand()) {
      try {
        const fromGetToys = global.lovense.getToys?.();
        if (Array.isArray(fromGetToys)) fromGetToys.forEach(add);
        else if (fromGetToys && typeof fromGetToys === "object") Object.values(fromGetToys).forEach(add);
      } catch (_) {}
      try {
        const online = global.lovense.getOnlineToys?.();
        if (Array.isArray(online)) online.forEach(add);
      } catch (_) {}
    }

    (Array.isArray(state.toys) ? state.toys : []).forEach(add);
    return out;
  }

  function getCommandToyId(requestedId) {
    const resolved = resolveToyId(requestedId);
    if (!resolved) return null;

    const toys = listLovenseCommandToys();
    const direct = toys.find((t) => String(t.id || t.toyId) === resolved);
    if (direct) return String(direct.id || direct.toyId);

    const meta = lookupToyMeta(resolved);
    if (meta?.type) {
      const byType = toys.find((t) => String(t.type || t.toyType || "").toLowerCase() === String(meta.type).toLowerCase());
      if (byType) return String(byType.id || byType.toyId);
    }

    return resolved;
  }

  function sendRawCommand(payload) {
    if (!hasLovenseSendCommand() || !payload) return false;
    if (!hasToysForCommands()) return false;
    syncLovenseToyMapFromExtension();
    try {
      global.lovense.sendCommand(payload);
      return true;
    } catch (e) {
      try {
        global.lovense.sendCommand({ command: payload });
        return true;
      } catch (e2) {
        console.warn("[Lovense] sendCommand failed:", e2, payload);
        return false;
      }
    }
  }

  function sendFunctionCommand({ action, timeSec, toyId, stopPrevious }) {
    const payload = {
      command: "Function",
      action: String(action || "Stop"),
      timeSec: Number.isFinite(timeSec) ? timeSec : 0,
      apiVer: 1,
    };

    if (toyId) {
      payload.toy = String(toyId);
    }
    if (stopPrevious != null) {
      payload.stopPrevious = stopPrevious ? 1 : 0;
    }

    return sendRawCommand(payload);
  }

  function sendPresetCommand(toyId, presetName, options) {
    const commandToyId = getCommandToyId(toyId);
    if (!commandToyId) return false;
    const opts = options || {};
    const timeSec = Number.isFinite(opts.timeSec) && opts.timeSec > 0 ? opts.timeSec : PRESET_PATTERN_SEC;
    return sendRawCommand({
      command: "Preset",
      name: String(presetName || "").toLowerCase(),
      timeSec,
      toy: commandToyId,
      apiVer: 1,
    });
  }

  function sendVibrateCommand(toyId, strength, options) {
    const opts = options || {};
    const commandToyId = getCommandToyId(toyId);
    if (!commandToyId || strength < 1) return false;

    const meta = lookupToyMeta(commandToyId) || lookupToyMeta(toyId);
    const type = String(meta?.type || meta?.toyType || "").toLowerCase();
    /** 0 = run until an explicit Stop command (Lovense API). */
    const timeSec = opts.continuous ? 0 : Number.isFinite(opts.timeSec) ? opts.timeSec : 0;

    if (sendFunctionCommand({
      action: `Vibrate:${strength}`,
      timeSec,
      toyId: commandToyId,
      stopPrevious: 1,
    })) {
      return true;
    }

    if (type === "diamo") {
      return (
        sendFunctionCommand({
          action: `Vibrate1:${strength}`,
          timeSec,
          toyId: commandToyId,
          stopPrevious: 1,
        }) ||
        sendFunctionCommand({
          action: `Vibrate2:${strength}`,
          timeSec,
          toyId: commandToyId,
          stopPrevious: 0,
        })
      );
    }

    return false;
  }

  /**
   * Tip payload with reactToys on the tip object (not only cParameter) — extension may honor this.
   */
  function sendTipViaCamExtension(amount, tipperName, toyId, options) {
    const instance = state.instance;
    if (!instance || typeof instance.sendMessage !== "function") return false;

    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return false;

    const raw = Math.round(Number(amount) || 0);
    const tokens = options?.exactTokens
      ? Math.max(1, raw)
      : Math.max(MIN_RECEIVE_TIP_TOKENS, raw);
    const name = String(tipperName || "Remote").slice(0, 40);
    const meta = lookupToyMeta(resolvedId);
    const toyType = meta?.type || meta?.toyType || "";
    const model = global.__LOVENSE_MODEL_NAME__ || "model1";

    try {
      instance.sendMessage("tip", {
        tip: {
          amount: tokens,
          modelName: model,
          tipperName: name,
          cParameter: {},
          reactToys: [{ toyId: resolvedId, status: 1, toyType }],
        },
      });
      return true;
    } catch (e) {
      console.warn("[Lovense] sendMessage(tip, reactToys) failed:", e);
      return false;
    }
  }

  function stopToyHold(toyId) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return;
    const key = String(resolvedId);
    if (holdIntervals[key]) {
      clearInterval(holdIntervals[key]);
      delete holdIntervals[key];
    }
  }

  function stopAllToyHolds() {
    Object.keys(holdIntervals).forEach((key) => {
      clearInterval(holdIntervals[key]);
      delete holdIntervals[key];
    });
  }

  function stopPresetHold(toyId) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return;
    const key = String(resolvedId);
    if (presetHoldIntervals[key]) {
      clearInterval(presetHoldIntervals[key]);
      delete presetHoldIntervals[key];
    }
  }

  function stopAllPresetHolds() {
    Object.keys(presetHoldIntervals).forEach((key) => {
      clearInterval(presetHoldIntervals[key]);
      delete presetHoldIntervals[key];
    });
  }

  function startPresetHold(toyId, presetName) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return;
    stopPresetHold(resolvedId);
    const name = String(presetName || "").toLowerCase();
    const key = String(resolvedId);
    const pulse = () => sendPresetCommand(resolvedId, name, { timeSec: PRESET_PATTERN_SEC });
    pulse();
    presetHoldIntervals[key] = setInterval(pulse, PRESET_HOLD_REFRESH_MS);
  }

  /** Hard stop: intervals + Stop + Vibrate:0 (Preset timeSec:0 ignores Stop on some builds). */
  function stopToyHardware(toyId) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return false;

    stopToyHold(resolvedId);
    stopMotorHold(resolvedId);
    stopPresetHold(resolvedId);

    if (!hasToysForCommands()) return true;

    const commandToyId = getCommandToyId(resolvedId);
    if (!commandToyId) return false;

    sendFunctionCommand({
      action: "Stop",
      timeSec: 0,
      toyId: commandToyId,
      stopPrevious: 1,
    });
    sendFunctionCommand({
      action: "Vibrate:0",
      timeSec: 0,
      toyId: commandToyId,
      stopPrevious: 1,
    });

    const meta = lookupToyMeta(resolvedId);
    const type = String(meta?.type || meta?.toyType || "").toLowerCase();
    if (type === "diamo") {
      sendFunctionCommand({
        action: "Vibrate1:0",
        timeSec: 0,
        toyId: commandToyId,
        stopPrevious: 0,
      });
      sendFunctionCommand({
        action: "Vibrate2:0",
        timeSec: 0,
        toyId: commandToyId,
        stopPrevious: 0,
      });
    }

    return true;
  }

  function stopMotorHold(toyId) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return;
    const key = String(resolvedId);
    if (motorHoldIntervals[key]) {
      clearInterval(motorHoldIntervals[key]);
      delete motorHoldIntervals[key];
    }
  }

  function stopAllMotorHolds() {
    Object.keys(motorHoldIntervals).forEach((key) => {
      clearInterval(motorHoldIntervals[key]);
      delete motorHoldIntervals[key];
    });
  }

  function startMotorHold(toyId, strength) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return;
    stopMotorHold(resolvedId);
    const str = Math.max(1, Math.min(20, Number(strength) || 1));
    const key = String(resolvedId);
    const pulse = () => sendVibrateCommand(resolvedId, str, { continuous: true });
    pulse();
    motorHoldIntervals[key] = setInterval(pulse, MOTOR_HOLD_REFRESH_MS);
  }

  function startTipHold(toyId, tokens, tipperName) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return;
    stopToyHold(resolvedId);
    const tipTokens = Math.round(Number(tokens) || 0);
    if (!tipTokens || tipTokens < 1) return;
    const name = String(tipperName || "Remote").slice(0, 40);
    const key = String(resolvedId);
    const pulse = () => firePresetTip(tipTokens, name, resolvedId);
    holdIntervals[key] = setInterval(pulse, HOLD_REFRESH_MS);
  }

  function rememberToySession(toyId, level, tokens, tipperName) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return;
    const key = String(resolvedId);
    const prev = toyBaseSessions[key] || {};
    toyBaseSessions[key] = {
      ...prev,
      level: Math.max(0, Math.min(100, Number(level) || 0)),
      tokens: Math.max(0, Math.round(Number(tokens) || 0)),
      tipperName: String(tipperName || prev.tipperName || "Remote").slice(0, 40),
    };
  }

  async function getSpecialConfig(specialType) {
    const key = String(specialType || "").trim();
    let tokens = 100;
    let enabled = true;
    if (!key) {
      return { tokens: null, enabled: false, configured: false };
    }

    if (!state.instance || typeof state.instance.getSettings !== "function") {
      return { tokens: Math.max(1, Math.round(tokens)), enabled: true, configured: true };
    }

    try {
      const settings = await state.instance.getSettings();
      const specials = settings?.special;
      let spec = specials?.[key];
      if (!spec && specials && typeof specials === "object") {
        const lower = key.toLowerCase();
        const matchKey = Object.keys(specials).find((k) => String(k).toLowerCase() === lower);
        if (matchKey) spec = specials[matchKey];
      }
      if (!spec) {
        return { tokens: null, enabled: false, configured: false };
      }
      if (spec.enable === false || spec.enabled === false) enabled = false;
      if (spec.token != null && spec.token !== "") tokens = Number(spec.token);
      else if (spec.tokens != null && spec.tokens !== "") tokens = Number(spec.tokens);
      return {
        tokens: Math.max(1, Math.round(tokens)),
        enabled,
        configured: true,
      };
    } catch (e) {
      console.warn("[Lovense] getSettings for special:", e);
      return { tokens: Math.max(1, Math.round(tokens)), enabled: true, configured: true };
    }
  }

  function sendSpecialTip(tokens, tipperName, specialType, toyId) {
    const tipTokens = Math.max(1, Math.round(Number(tokens) || 0));
    const name = String(tipperName || "Remote").slice(0, 40);
    const type = String(specialType || "").trim();
    if (!type) return false;

    const cParameter = { specialType: type };
    if (receiveTip(tipTokens, name, cParameter, { exactTokens: true })) {
      return true;
    }

    const instance = state.instance;
    const resolvedId = resolveToyId(toyId);
    if (!instance || typeof instance.sendMessage !== "function") return false;

    const meta = resolvedId ? lookupToyMeta(resolvedId) : null;
    const model = global.__LOVENSE_MODEL_NAME__ || "model1";
    const tip = {
      amount: tipTokens,
      modelName: model,
      tipperName: name,
      cParameter,
      specialType: type,
      module: "Special Command",
    };
    if (resolvedId) {
      tip.reactToys = [
        {
          toyId: resolvedId,
          status: 1,
          toyType: meta?.type || meta?.toyType || "",
          specialType: type,
        },
      ];
    }

    try {
      instance.sendMessage("tip", { tip });
      return true;
    } catch (e) {
      console.warn("[Lovense] sendMessage(special tip) failed:", e);
      return false;
    }
  }

  function vibrateToy(toyId, level, tokens, tipperName) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return { ok: false, method: "none" };

    const strength = strengthForLevel(level);
    if (strength < 1) return { ok: false, method: "none" };

    const tipTokens = Math.round(Number(tokens) || 0);
    const name = String(tipperName || "Remote").slice(0, 40);

    stopToyHold(resolvedId);
    stopMotorHold(resolvedId);

    let result = null;

    if (isDirectMotorMode() && hasLovenseSendCommand() && hasToysForCommands()) {
      if (sendVibrateCommand(resolvedId, strength, { continuous: true })) {
        startMotorHold(resolvedId, strength);
        result = {
          ok: true,
          method: "sendCommand",
          toyId: getCommandToyId(resolvedId),
          tokens: tipTokens || null,
          strength,
          hint: `Motor ${strength}/20 (direct — no Stream Master Basic Levels)`,
        };
      }
    }

    if (!result?.ok) {
      if (tipTokens < 1) {
        return {
          ok: false,
          method: "motor-failed",
          hint: isDirectMotorMode()
            ? "Direct motor failed — reload page, check extension widget and toy connection."
            : "No token amount — enable direct motor or configure Stream Master tokens.",
        };
      }

      const fired = firePresetTip(tipTokens, name, resolvedId);
      if (fired.ok) {
        startTipHold(resolvedId, tipTokens, name);
        result = {
          ok: true,
          method: fired.method === "tipMessage" ? "tipMessage-hold" : "receiveTip-hold",
          toyId: resolvedId,
          tokens: tipTokens,
          strength,
          hint: `${tipTokens} tokens · Stream Master fallback (hold)`,
        };
      } else {
        return {
          ok: false,
          method: "tip-failed",
          hint: `Token ${tipTokens} must fall in Stream Master range for this toy (tip fallback).`,
        };
      }
    }

    if (result?.ok) {
      rememberToySession(resolvedId, level, tipTokens, name);
      const key = String(resolvedId);
      if (toyBaseSessions[key]) toyBaseSessions[key].activeSpecial = null;
    }
    return result;
  }

  async function applyToySpecial({ toyId, special, enabled, tipperName, level, tipAmount }) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return { ok: false, method: "no-toy" };

    const key = String(resolvedId);
    const session = toyBaseSessions[key] || {
      level: 0,
      tokens: 0,
      tipperName: "Remote",
      activeSpecial: null,
    };

    if (Number(level) > 0) session.level = Math.max(0, Math.min(100, Number(level)));
    if (Number(tipAmount) > 0) session.tokens = Math.round(Number(tipAmount));
    if (tipperName) session.tipperName = String(tipperName).slice(0, 40);
    toyBaseSessions[key] = session;

    const specialType = String(special || "").trim();
    if (!specialType) return { ok: false, method: "no-special" };

    if (!enabled) {
      session.activeSpecial = null;
      toyBaseSessions[key] = session;
      stopToyHardware(resolvedId);

      const restoreLevel = Math.max(0, Math.min(100, Number(level) || 0));
      if (restoreLevel > 0) {
        const restoreTokens =
          Number(tipAmount) > 0 ? Math.round(Number(tipAmount)) : session.tokens;
        const restored = vibrateToy(
          resolvedId,
          restoreLevel,
          restoreTokens,
          session.tipperName
        );
        return {
          ok: !!restored?.ok,
          method: restored?.ok ? "special-off-restore" : "special-off-restore-failed",
          special: specialType,
          tokens: restoreTokens,
          hint: restored?.ok
            ? restored.hint || "Pattern off — base level restored"
            : "Pattern stopped — could not restore base level",
        };
      }
      return {
        ok: true,
        method: "special-off",
        special: specialType,
        hint: "Pattern stopped",
      };
    }

    stopToyHardware(resolvedId);

    if (isDirectMotorMode() && hasLovenseSendCommand() && hasToysForCommands()) {
      if (sendPresetCommand(resolvedId, specialType, { timeSec: PRESET_PATTERN_SEC })) {
        startPresetHold(resolvedId, specialType);
        session.activeSpecial = specialType;
        toyBaseSessions[key] = session;
        return {
          ok: true,
          method: "preset-direct",
          special: specialType,
          hint: `Pattern ${specialType} (${PRESET_PATTERN_SEC}s bursts — uncheck to stop)`,
        };
      }
    }

    const specConfig = await getSpecialConfig(specialType);
    const name = session.tipperName;

    if (!isDirectMotorMode()) {
      if (!specConfig.configured) {
        return {
          ok: false,
          method: "special-not-in-settings",
          special: specialType,
          hint: "Enable this command in Stream Master → Special Commands.",
        };
      }
      if (!specConfig.enabled) {
        return {
          ok: false,
          method: "special-disabled",
          special: specialType,
          hint: "Checkbox for this command is off in Stream Master.",
        };
      }
    }

    const specialTokens = specConfig.tokens || tipAmount || 100;
    if (sendSpecialTip(specialTokens, name, specialType, resolvedId)) {
      session.activeSpecial = specialType;
      toyBaseSessions[key] = session;
      return {
        ok: true,
        method: "special",
        special: specialType,
        tokens: specConfig.tokens || specialTokens,
        hint: `Pattern ${specialType} · ${specConfig.tokens || specialTokens} tokens (Stream Master fallback)`,
      };
    }

    if (session.level > 0 && session.tokens > 0) {
      vibrateToy(resolvedId, session.level, session.tokens, name);
    }
    return {
      ok: false,
      method: "special-failed",
      special: specialType,
      hint: "Token amount must match Stream Master (no overlap with Basic Levels).",
    };
  }

  function resolveToyId(requestedId) {
    if (!requestedId) return null;
    const raw = String(requestedId);
    const toys = Array.isArray(state.toys) ? state.toys : [];

    const match = toys.find((t) => t && String(t.id) === raw);
    if (match?.id) return String(match.id);

    const indexMatch = /^toy-(\d+)$/.exec(raw);
    if (indexMatch) {
      const toy = toys[Number(indexMatch[1]) - 1];
      if (toy?.id) return String(toy.id);
    }

    return raw;
  }

  function stopToy(toyId) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) {
      return stopToys();
    }
    return stopToyHardware(resolvedId);
  }

  function stopToys() {
    stopAllToyHolds();
    stopAllMotorHolds();
    stopAllPresetHolds();
    let stopped = false;

    if (hasToysForCommands()) {
      stopped = sendFunctionCommand({
        action: "Stop",
        timeSec: 0,
        stopPrevious: 1,
      });
      sendFunctionCommand({
        action: "Vibrate:0",
        timeSec: 0,
        stopPrevious: 1,
      });
    }

    if (!isDirectMotorMode() && state.instance && state.ready) {
      try {
        state.instance.receiveTip(1, "Stop", { specialType: "clear" });
        stopped = true;
      } catch (e) {
        console.warn("[Lovense] receiveTip(clear) failed:", e);
      }
    }

    return stopped;
  }

  function applyRemoteControl(data) {
    if (!data || typeof data !== "object") return { ok: false, method: "none" };
    const level = Math.max(0, Math.min(100, Number(data.level) || 0));
    const tokens = Math.round(Number(data.tipAmount) || 0);
    const tipperName = data.tipperName || "Remote";
    const targetToyId = resolveToyId(data.toyId);

    if (level <= 0) {
      const stopped = targetToyId ? stopToy(targetToyId) : stopToys();
      return { ok: stopped, method: stopped ? "stop" : "stop-failed" };
    }

    if (tokens < 1 && !isDirectMotorMode()) {
      console.warn("[Lovense] applyRemoteControl: missing tipAmount, level=", level);
      return { ok: false, method: "no-tokens" };
    }

    if (targetToyId) {
      return vibrateToy(targetToyId, level, tokens, tipperName);
    }

    const ok = receiveTip(tokens, tipperName);
    return { ok, method: ok ? "receiveTip-all" : "receiveTip-failed" };
  }

  function bindCamExtensionHandlers(camExtension) {
    camExtension.on("ready", async (ce) => {
      state.instance = ce || camExtension;
      state.ready = true;
      state.error = null;
      try {
        if (typeof state.instance.getCamVersion === "function") {
          state.version = await state.instance.getCamVersion();
        }
        if (typeof state.instance.getToyStatus === "function") {
          state.toys = (await state.instance.getToyStatus()) || [];
        }
        await refreshStreamSettings();
        syncLovenseToyMapFromExtension();
      } catch (e) {
        console.warn("[Lovense] version/toy status:", e);
      }
      flushPendingTips();
      dispatch("dualpeer-lovense-ready", {
        instance: state.instance,
        version: state.version,
        toys: state.toys,
        hasSendCommand: hasLovenseSendCommand(),
        lanToysOnline: isLovenseLanOnline(),
        directMotor: isDirectMotorMode(),
        streamWarnings: isDirectMotorMode() ? [] : getStreamMasterWarnings(),
      });
    });

    camExtension.on("settingsChange", async () => {
      await refreshStreamSettings();
      dispatch("dualpeer-lovense-settings", {
        warnings: getStreamMasterWarnings(),
      });
    });

    camExtension.on("sdkError", (data) => {
      state.error = data;
      dispatch("dualpeer-lovense-error", data);
    });

    camExtension.on("toyStatusChange", (data) => {
      state.toys = data || [];
      syncLovenseToyMapFromExtension();
      dispatch("dualpeer-lovense-toys", state.toys);
    });
  }

  function init() {
    if (state.ready) return true;

    const site = global.LOVENSE_SITE_NAME || "test:Tangent-Club";
    const model = global.__LOVENSE_MODEL_NAME__ || "model1";

    if (typeof global.CamExtension === "undefined") {
      state.error = { code: "NO_SDK", message: "broadcast.js not loaded" };
      dispatch("dualpeer-lovense-error", state.error);
      return false;
    }

    if (state.instance) return true;

    try {
      const camExtension = new global.CamExtension(site, model);
      state.instance = camExtension;
      state.error = null;
      bindCamExtensionHandlers(camExtension);
      return true;
    } catch (e) {
      state.error = { code: "INIT_FAIL", message: e && e.message ? e.message : String(e) };
      dispatch("dualpeer-lovense-error", state.error);
      return false;
    }
  }

  function retryInit() {
    if (state.ready) return true;
    state.instance = null;
    state.error = null;
    return init();
  }

  /** Extension bridge is ready only after the page + content script have connected. */
  function scheduleBoot() {
    const boot = () => init();

    if (document.readyState === "complete") {
      setTimeout(boot, 50);
    } else {
      window.addEventListener("load", () => setTimeout(boot, 50), { once: true });
    }

    window.addEventListener(
      "load",
      () => {
        setTimeout(() => {
          if (state.ready) return;
          if (state.instance && !state.error) return;
          retryInit();
        }, 7000);
      },
      { once: true }
    );

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || state.ready) return;
      if (!state.instance) init();
    });
  }

  global.dualPeerLovense = {
    get ready() {
      return state.ready;
    },
    get instance() {
      return state.instance;
    },
    get error() {
      return state.error;
    },
    get toys() {
      return state.toys;
    },
    get version() {
      return state.version;
    },
    hasLovenseSendCommand,
    isLovenseLanOnline,
    isDirectMotorMode,
    hasToysForCommands,
    refreshStreamSettings,
    getStreamMasterWarnings,
    receiveTip,
    vibrateToy,
    stopToy,
    stopToys,
    applyRemoteControl,
    applyToySpecial,
    resolveToyId,
    getCommandToyId,
    levelToStrength,
    getSiteName() {
      return global.LOVENSE_SITE_NAME || "test:Tangent-Club";
    },
    getModelName() {
      return global.__LOVENSE_MODEL_NAME__ || "model1";
    },
    init,
    retryInit,
  };

  scheduleBoot();
})(window);
