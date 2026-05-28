/**
 * Lovense Cam Extension — initialization per developer docs:
 * broadcast.js → new CamExtension(site, model) → on("ready") → direct sendAction (no receiveTip).
 * https://developer.lovense.com/docs/cam-solutions/cam-extension-for-chrome
 */
(function (global) {
  const state = {
    ready: false,
    instance: null,
    error: null,
    toys: [],
    version: null,
  };

  function dispatch(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function sendVibrate(strength, toyId) {
    const model = global.__LOVENSE_MODEL_NAME__ || "model1";
    const level = Math.max(0, Math.min(20, Math.round(Number(strength) || 0)));
    const payload = {
      type: "toy",
      action: "Vibrate",
      strength: level,
      model,
    };
    if (toyId) payload.toyId = toyId;

    if (!state.instance) return false;
    try {
      if (typeof state.instance.sendAction === "function") {
        state.instance.sendAction(payload);
        return true;
      }
      if (typeof global.lovense !== "undefined" && typeof global.lovense.sendAction === "function") {
        global.lovense.sendAction(payload);
        return true;
      }
      return false;
    } catch (e) {
      console.error("[Lovense] sendVibrate failed:", e);
      return false;
    }
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
    sendVibrate,
    getSiteName() {
      return global.LOVENSE_SITE_NAME || "test:Tangent-Club";
    },
    getModelName() {
      return global.__LOVENSE_MODEL_NAME__ || "model1";
    },
  };

  init();
})(window);
