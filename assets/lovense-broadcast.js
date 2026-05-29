/**
 * Lovense Cam Extension — receiveTip for local toys; remote commands from peer.
 * Per-toy control uses lovense.sendCommand (LAN.js) when available, not global receiveTip.
 * https://developer.lovense.com/docs/cam-solutions/cam-extension-for-chrome
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

  /** Re-fire tips before Stream Master reaction time ends (receiveTip fallback only). */
  const HOLD_REFRESH_MS = 3200;
  const holdIntervals = Object.create(null);
  /** Last normal intensity per toy — used to restore after a special pattern ends. */
  const toyBaseSessions = Object.create(null);

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

  function sendFunctionCommand({ action, timeSec, toyId, stopPrevious }) {
    if (!hasLovenseSendCommand()) return false;

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
  function sendTipViaCamExtension(amount, tipperName, toyId) {
    const instance = state.instance;
    if (!instance || typeof instance.sendMessage !== "function") return false;

    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return false;

    const tokens = Math.max(MIN_RECEIVE_TIP_TOKENS, Math.round(Number(amount) || 0));
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

  function startTipHold(toyId, tokens, tipperName) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) return;
    stopToyHold(resolvedId);
    const tipTokens = Math.round(Number(tokens) || 0);
    if (!tipTokens || tipTokens < 1) return;
    const name = String(tipperName || "Remote").slice(0, 40);
    const key = String(resolvedId);
    const pulse = () => receiveTip(tipTokens, name, {}, { exactTokens: true });
    pulse();
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

  async function getSpecialTipTokens(specialType) {
    const key = String(specialType || "").trim();
    let tokens = 100;
    try {
      if (state.instance && typeof state.instance.getSettings === "function") {
        const settings = await state.instance.getSettings();
        const spec = settings?.special?.[key];
        if (spec) {
          if (spec.token != null && spec.token !== "") tokens = Number(spec.token);
          else if (spec.tokens != null && spec.tokens !== "") tokens = Number(spec.tokens);
        }
      }
    } catch (e) {
      console.warn("[Lovense] getSettings for special:", e);
    }
    return Math.max(1, Math.round(tokens));
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

    const strength = levelToStrength(level);
    if (strength < 1) return { ok: false, method: "none" };

    const tipTokens = Math.round(Number(tokens) || 0);
    if (!tipTokens || tipTokens < 1) return { ok: false, method: "no-tokens" };
    const name = String(tipperName || "Remote").slice(0, 40);

    stopToyHold(resolvedId);

    let result = null;
    if (hasLovenseSendCommand() && sendVibrateCommand(resolvedId, strength, { continuous: true })) {
      result = { ok: true, method: "sendCommand", toyId: getCommandToyId(resolvedId) };
    } else if (receiveTip(tipTokens, name, {}, { exactTokens: true })) {
      startTipHold(resolvedId, tipTokens, name);
      result = {
        ok: true,
        method: "receiveTip-hold",
        toyId: resolvedId,
        tokens: tipTokens,
      };
    } else if (sendTipViaCamExtension(tipTokens, name, resolvedId)) {
      result = { ok: true, method: "tipMessage", toyId: resolvedId };
    } else {
      return { ok: false, method: hasLovenseSendCommand() ? "sendCommand-failed" : "receiveTip-failed" };
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
      if (session.level > 0 && session.tokens > 0) {
        const restored = vibrateToy(
          resolvedId,
          session.level,
          session.tokens,
          session.tipperName
        );
        return {
          ok: !!restored?.ok,
          method: restored?.ok ? "special-off-restore" : "special-off-restore-failed",
          special: specialType,
        };
      }
      return { ok: true, method: "special-off", special: specialType };
    }

    stopToyHold(resolvedId);
    const tokens = await getSpecialTipTokens(specialType);
    const name = session.tipperName;

    if (sendSpecialTip(tokens, name, specialType, resolvedId)) {
      session.activeSpecial = specialType;
      toyBaseSessions[key] = session;
      return { ok: true, method: "special", special: specialType, tokens };
    }

    if (session.level > 0 && session.tokens > 0) {
      vibrateToy(resolvedId, session.level, session.tokens, name);
    }
    return { ok: false, method: "special-failed", special: specialType };
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

    stopToyHold(resolvedId);

    const commandToyId = getCommandToyId(resolvedId);
    const stopped = sendFunctionCommand({
      action: "Stop",
      timeSec: 0,
      toyId: commandToyId,
      stopPrevious: 1,
    });

    return stopped || stopToys();
  }

  function stopToys() {
    stopAllToyHolds();
    let stopped = false;

    stopped = sendFunctionCommand({
      action: "Stop",
      timeSec: 0,
      stopPrevious: 1,
    });

    if (!state.instance || !state.ready) return stopped;

    try {
      state.instance.receiveTip(1, "Stop", { specialType: "clear" });
      stopped = true;
    } catch (e) {
      console.warn("[Lovense] receiveTip(clear) failed:", e);
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

    if (tokens < 1) {
      console.warn("[Lovense] applyRemoteControl: missing tipAmount, level=", level);
      return { ok: false, method: "no-tokens" };
    }

    if (targetToyId) {
      return vibrateToy(targetToyId, level, tokens, tipperName);
    }

    const ok = receiveTip(tokens, tipperName);
    return { ok, method: ok ? "receiveTip-all" : "receiveTip-failed" };
  }

  function init() {
    const site = global.LOVENSE_SITE_NAME || "test:Tangent-Club";
    const model = global.__LOVENSE_MODEL_NAME__ || "model1";

    if (typeof global.CamExtension === "undefined") {
      state.error = { code: "NO_SDK", message: "broadcast.js not loaded" };
      dispatch("dualpeer-lovense-error", state.error);
      return;
    }

    try {
      const camExtension = new global.CamExtension(site, model);
      state.instance = camExtension;

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
        } catch (e) {
          console.warn("[Lovense] version/toy status:", e);
        }
        flushPendingTips();
        dispatch("dualpeer-lovense-ready", {
          instance: state.instance,
          version: state.version,
          toys: state.toys,
          hasSendCommand: hasLovenseSendCommand(),
        });
      });

      camExtension.on("sdkError", (data) => {
        state.error = data;
        dispatch("dualpeer-lovense-error", data);
      });

      camExtension.on("toyStatusChange", (data) => {
        state.toys = data || [];
        dispatch("dualpeer-lovense-toys", state.toys);
      });
    } catch (e) {
      state.error = { code: "INIT_FAIL", message: e && e.message ? e.message : String(e) };
      dispatch("dualpeer-lovense-error", state.error);
    }
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
  };

  init();
})(window);
