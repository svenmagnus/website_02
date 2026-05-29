/**
 * Lovense Cam Extension — receiveTip for local toys; remote commands from peer.
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

  function dispatch(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function flushPendingTips() {
    if (!state.ready || !state.instance) return;
    while (state.pendingTips.length) {
      const tip = state.pendingTips.shift();
      try {
        state.instance.receiveTip(tip.amount, tip.tipperName);
      } catch (e) {
        console.error("[Lovense] receiveTip (queued) failed:", e);
      }
    }
  }

  function receiveTip(amount, tipperName) {
    const tokens = Math.round(Number(amount));
    if (!tokens || tokens < 1) return false;
    const name = String(tipperName || "Remote").slice(0, 40);

    if (!state.instance) return false;
    if (!state.ready) {
      state.pendingTips.push({ amount: tokens, tipperName: name });
      return false;
    }

    try {
      state.instance.receiveTip(tokens, name);
      return true;
    } catch (e) {
      console.error("[Lovense] receiveTip failed:", e);
      return false;
    }
  }

  function pauseOtherToys(targetToyId) {
    const toys = Array.isArray(state.toys) ? state.toys : [];
    if (!targetToyId || toys.length <= 1) return;

    toys.forEach((t) => {
      if (!t?.id || String(t.id) === String(targetToyId)) return;
      sendFunctionCommand({
        action: "Stop",
        timeSec: 0,
        toyId: String(t.id),
        stopPrevious: 1,
      });
    });
  }

  function sendFunctionCommand({ action, timeSec, toyId, stopPrevious }) {
    if (typeof global.lovense === "undefined" || typeof global.lovense.sendCommand !== "function") {
      return false;
    }

    const inner = {
      command: "Function",
      action: String(action || "Stop"),
      timeSec: Number.isFinite(timeSec) ? timeSec : 0,
      apiVer: 1,
    };

    if (toyId) {
      inner.toy = String(toyId);
    }
    if (stopPrevious != null) {
      inner.stopPrevious = stopPrevious ? 1 : 0;
    }

    try {
      global.lovense.sendCommand(inner);
      return true;
    } catch (e) {
      try {
        global.lovense.sendCommand({ command: inner });
        return true;
      } catch (e2) {
        console.warn("[Lovense] sendCommand failed:", e2);
        return false;
      }
    }
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

  function levelToVibrateStrength(level) {
    return Math.max(0, Math.min(20, Math.round(Number(level) / 5)));
  }

  function tokensToRunSeconds(tokens, level) {
    const tipTokens = Math.round(Number(tokens) || 0);
    if (tipTokens > 0) {
      return Math.max(2, Math.min(40, tipTokens));
    }
    const strength = levelToVibrateStrength(level);
    return Math.max(2, Math.min(30, strength + 3));
  }

  function stopToy(toyId) {
    const resolvedId = resolveToyId(toyId);
    if (!resolvedId) {
      return stopToys();
    }

    const stopped = sendFunctionCommand({
      action: "Stop",
      timeSec: 0,
      toyId: resolvedId,
      stopPrevious: 1,
    });

    return stopped || stopToys();
  }

  function stopToys() {
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
    if (!data || typeof data !== "object") return false;
    const level = Math.max(0, Math.min(100, Number(data.level) || 0));
    const tokens = Math.round(Number(data.tipAmount) || 0);
    const tipperName = data.tipperName || "Remote";
    const targetToyId = resolveToyId(data.toyId);
    const toys = Array.isArray(state.toys) ? state.toys.filter((t) => t?.id) : [];

    if (level <= 0 || tokens <= 0) {
      return targetToyId ? stopToy(targetToyId) : stopToys();
    }

    if (targetToyId && toys.length > 1) {
      pauseOtherToys(targetToyId);

      const strength = levelToVibrateStrength(level);
      if (strength > 0) {
        sendFunctionCommand({
          action: `Vibrate:${strength}`,
          timeSec: tokensToRunSeconds(tokens, level),
          toyId: targetToyId,
          stopPrevious: 1,
        });
      }
    }

    return receiveTip(tokens, tipperName);
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
    receiveTip,
    stopToy,
    stopToys,
    applyRemoteControl,
    resolveToyId,
    getSiteName() {
      return global.LOVENSE_SITE_NAME || "test:Tangent-Club";
    },
    getModelName() {
      return global.__LOVENSE_MODEL_NAME__ || "model1";
    },
  };

  init();
})(window);
