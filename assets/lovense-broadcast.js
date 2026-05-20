(function (global) {
  const state = {
    ready: false,
    instance: null,
    error: null,
    toys: [],
    version: null,
    buffer: null,
    timer: null,
  };

  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function sendNow(amount, name) {
    if (!state.instance) return false;

    try {
      state.instance.receiveTip({
        amount,
        name,
        vibrate: true,
      });
      return true;
    } catch (e) {
      console.error("[Lovense] send failed", e);
      return false;
    }
  }

  // 🔥 FIX: stabil + kein Queue-Spam mehr
  function sendTip(amount, name = "Remote") {
    const val = Math.max(1, Math.round(Number(amount)));
    if (!val) return false;

    state.buffer = {
      amount: (state.buffer?.amount || 0) + val,
      name,
    };

    clearTimeout(state.timer);

    state.timer = setTimeout(() => {
      const payload = state.buffer;
      state.buffer = null;

      sendNow(payload.amount, payload.name);
    }, 120);

    return true;
  }

  function init() {
    const site = global.LOVENSE_SITE_NAME || "test:Tangent-Club";
    const model = global.__LOVENSE_MODEL_NAME__ || "model1";

    if (!global.CamExtension) {
      state.error = { code: "NO_SDK", message: "broadcast.js fehlt" };
      emit("dualpeer-lovense-error", state.error);
      return;
    }

    const ext = new global.CamExtension(site, model);
    state.instance = ext;

    ext.on("ready", async (ce) => {
      state.instance = ce;
      state.ready = true;

      try {
        state.version = await ce.getCamVersion?.();
        state.toys = (await ce.getToyStatus?.()) || [];
      } catch {}

      emit("dualpeer-lovense-ready", {
        version: state.version,
        toys: state.toys,
      });
    });

    ext.on("sdkError", (e) => {
      state.error = e;
      emit("dualpeer-lovense-error", e);
    });

    ext.on("toyStatusChange", (t) => {
      state.toys = t || [];
      emit("dualpeer-lovense-toys", state.toys);
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
    sendTip,
  };

  init();
})(window);
