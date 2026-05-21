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
    // Lovense REST API Konfiguration
 const LOVENSE_API_URL = "https://api.lovense-api.com/api/lan/v2/command";
    const LOVENSE_TOKEN = "RvF8ZPPgospbjRpcoGxIfEND8fSFG__UvQb2iIYQLZF0JTXtXE-7DiajEMImnlyC";
    const LOVENSE_UID = "mkcab2cc52-c5ea-452d-bd5e-2d85048ffecb";

    // Vibrationsstärke dynamisch berechnen (0-20 basierend auf Tip-Betrag)
    // 1 Token = Stufe 1, 100+ Tokens = Stufe 20 (max)
    const vibrationLevel = Math.min(20, Math.max(1, Math.round(Number(amount) / 5)));
    const action = `Vibrate:${vibrationLevel}`;
    const timeSec = Math.min(30, Math.max(5, Math.round(Number(amount) / 3))); // 5-30 Sekunden

    const payload = {
      token: LOVENSE_TOKEN,
      uid: LOVENSE_UID,
      command: "Function",
      action: action,
      timeSec: timeSec,
      apiVer: 1
    };

    console.log(`[Lovense REST API] Sende Vibration: ${action} für ${timeSec}s (${amount} Tokens von ${name})`);

    fetch(LOVENSE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    })
    .then(response => {
      if (!response.ok) {
        const status = response.status;
        let errorMsg = "Unbekannter Fehler";
        if (status === 400) errorMsg = "Invalid Command";
        else if (status === 401) errorMsg = "Toy Not Found";
        else if (status === 402) errorMsg = "Toy Not Connected";
        else if (status === 404) errorMsg = "Invalid Parameter";
        console.error(`[Lovense REST API] Fehler ${status}: ${errorMsg}`);
      } else {
        console.log(`[Lovense REST API] Erfolgreich: ${action} für ${timeSec}s`);
      }
      return response.json();
    })
    .then(data => {
      console.log("[Lovense REST API] Response:", data);
    })
    .catch(e => {
      console.error("[Lovense REST API] Network error:", e);
    });

    return true;
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
