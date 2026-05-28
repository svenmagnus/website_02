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

  function stopToys() {
    let stopped = false;

    try {
      if (typeof global.lovense !== "undefined" && typeof global.lovense.sendCommand === "function") {
        global.lovense.sendCommand({
          command: "Function",
          action: "Stop",
          timeSec: 0,
          apiVer: 1,
        });
        stopped = true;
      }
    } catch (e) {
      console.warn("[Lovense] sendCommand(Stop) failed:", e);
    }

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

    if (level <= 0 || tokens <= 0) {
      return stopToys();
    }

    return receiveTip(tokens, data.tipperName || "Remote");
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
    stopToys,
    applyRemoteControl,
    getSiteName() {
      return global.LOVENSE_SITE_NAME || "test:Tangent-Club";
    },
    getModelName() {
      return global.__LOVENSE_MODEL_NAME__ || "model1";
    },
  };

  init();
})(window);
