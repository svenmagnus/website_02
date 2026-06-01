/**
 * Phase 1 — member profile (localStorage) + technique requests via PeerJS data channel.
 */
(function (global) {
  const STORAGE_KEY = "dualpeer-member-profile-v1";
  const LEGACY_NAME_KEY = "dualpeer-profile-name";

  const TECHNIQUES = [
    { id: "nipple_play", label: "Nipple Play" },
    { id: "spank_ass", label: "Spank Ass" },
    { id: "spank_breast", label: "Spank Breast" },
    { id: "tease_denial", label: "Tease / Denial" },
    { id: "dirty_talk", label: "Dirty Talk" },
    { id: "roleplay", label: "Roleplay" },
  ];

  const GENDERS = [
    { value: "", label: "Prefer not to say" },
    { value: "female", label: "Female" },
    { value: "male", label: "Male" },
    { value: "nonbinary", label: "Non-binary" },
    { value: "other", label: "Other" },
  ];

  let partnerProfile = null;
  let userPinnedTab = false;

  function defaultProfile() {
    return {
      displayName: "Guest",
      gender: "",
      bio: "",
      techniques: [],
      updatedAt: Date.now(),
    };
  }

  function normalizeProfile(raw) {
    const base = defaultProfile();
    if (!raw || typeof raw !== "object") return base;
    const techniques = Array.isArray(raw.techniques)
      ? raw.techniques.filter((id) => TECHNIQUES.some((t) => t.id === id))
      : [];
    const displayName = String(raw.displayName || raw.name || "Guest").trim().slice(0, 32) || "Guest";
    return {
      displayName,
      gender: GENDERS.some((g) => g.value === raw.gender) ? raw.gender : "",
      bio: String(raw.bio || "").trim().slice(0, 500),
      techniques,
      updatedAt: raw.updatedAt || Date.now(),
    };
  }

  function loadProfile() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalizeProfile(JSON.parse(raw));
    } catch (_) {
      /* ignore */
    }
    const legacy = (localStorage.getItem(LEGACY_NAME_KEY) || "").trim();
    if (legacy) {
      return normalizeProfile({ displayName: legacy });
    }
    return defaultProfile();
  }

  function saveProfile(profile) {
    const next = normalizeProfile(profile);
    next.updatedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      localStorage.setItem(LEGACY_NAME_KEY, next.displayName);
    } catch (_) {
      /* ignore */
    }
    dispatchProfileUpdate();
    return next;
  }

  function getPublicProfile() {
    const p = loadProfile();
    return {
      displayName: p.displayName,
      gender: p.gender,
      bio: p.bio,
      techniques: [...p.techniques],
    };
  }

  function getPartnerProfile() {
    return partnerProfile ? { ...partnerProfile, techniques: [...(partnerProfile.techniques || [])] } : null;
  }

  function setPartnerProfile(raw) {
    partnerProfile = raw ? normalizeProfile(raw) : null;
    renderPartnerTechniqueButtons();
    refreshAccountMini();
    global.dispatchEvent(new CustomEvent("dualpeer-partner-profile", { detail: { profile: partnerProfile } }));
  }

  function genderLabel(value) {
    const hit = GENDERS.find((g) => g.value === value);
    return hit ? hit.label : "—";
  }

  function dispatchProfileUpdate() {
    const profile = loadProfile();
    if (global.dualPeerUi?.setProfileName) {
      global.dualPeerUi.setProfileName(profile.displayName);
    }
    global.dispatchEvent(new CustomEvent("dualpeer-profile-update", { detail: { profile } }));
    refreshAccountMini();
    renderPartnerTechniqueButtons();
  }

  function refreshAccountMini() {
    const p = loadProfile();
    document.querySelectorAll("[data-profile-gender]").forEach((el) => {
      el.textContent = genderLabel(p.gender);
    });
    const count = p.techniques.length;
    document.querySelectorAll("[data-profile-technique-summary]").forEach((el) => {
      el.textContent =
        count === 0 ? "No techniques selected" : `${count} technique${count === 1 ? "" : "s"} on your profile`;
    });
    const partner = getPartnerProfile();
    document.querySelectorAll("[data-partner-technique-summary]").forEach((el) => {
      if (!partner) {
        el.textContent = "Partner: not connected";
        return;
      }
      const pc = partner.techniques.length;
      el.textContent =
        pc === 0
          ? `${partner.displayName}: no techniques listed`
          : `${partner.displayName}: ${pc} technique${pc === 1 ? "" : "s"} available`;
    });
  }

  function getActivePanelTab() {
    const btn = document.querySelector(".panel-tab.is-active");
    return btn?.getAttribute("data-panel-tab") || "setup";
  }

  function setPanelTab(tabId, { userAction = false } = {}) {
    const id = tabId || "setup";
    if (userAction) userPinnedTab = true;
    document.querySelectorAll(".panel-tab").forEach((btn) => {
      const on = btn.getAttribute("data-panel-tab") === id;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll("[data-panel-tab-panel]").forEach((panel) => {
      const on = panel.getAttribute("data-panel-tab-panel") === id;
      panel.hidden = !on;
    });
  }

  function maybeAutoStreamTab(isLive) {
    if (userPinnedTab) return;
    if (isLive) setPanelTab("stream");
    else if (getActivePanelTab() === "stream") setPanelTab("setup");
  }

  function readProfileForm() {
    const nameEl = document.getElementById("profileDisplayName");
    const genderEl = document.getElementById("profileGender");
    const bioEl = document.getElementById("profileBio");
    const techniques = [];
    document.querySelectorAll('input[name="profileTechnique"]:checked').forEach((el) => {
      if (el instanceof HTMLInputElement && el.value) techniques.push(el.value);
    });
    return normalizeProfile({
      displayName: nameEl instanceof HTMLInputElement ? nameEl.value : "Guest",
      gender: genderEl instanceof HTMLSelectElement ? genderEl.value : "",
      bio: bioEl instanceof HTMLTextAreaElement ? bioEl.value : "",
      techniques,
    });
  }

  function fillProfileForm(profile) {
    const p = normalizeProfile(profile);
    const nameEl = document.getElementById("profileDisplayName");
    const genderEl = document.getElementById("profileGender");
    const bioEl = document.getElementById("profileBio");
    if (nameEl instanceof HTMLInputElement) {
      nameEl.value = p.displayName === "Guest" ? "" : p.displayName;
    }
    if (genderEl instanceof HTMLSelectElement) genderEl.value = p.gender;
    if (bioEl instanceof HTMLTextAreaElement) bioEl.value = p.bio;
    document.querySelectorAll('input[name="profileTechnique"]').forEach((el) => {
      if (!(el instanceof HTMLInputElement)) return;
      el.checked = p.techniques.includes(el.value);
    });
  }

  function renderTechniqueChecklist() {
    const root = document.getElementById("profileTechniqueList");
    if (!root) return;
    const p = loadProfile();
    root.innerHTML = "";
    TECHNIQUES.forEach((t) => {
      const label = document.createElement("label");
      label.className = "technique-check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "profileTechnique";
      input.value = t.id;
      input.checked = p.techniques.includes(t.id);
      const span = document.createElement("span");
      span.textContent = t.label;
      label.appendChild(input);
      label.appendChild(span);
      root.appendChild(label);
    });
  }

  function renderPartnerTechniqueButtons() {
    const root = document.getElementById("techniqueRequestList");
    if (!root) return;
    root.innerHTML = "";
    const partner = getPartnerProfile();
    if (!partner) {
      root.innerHTML =
        '<p class="technique-empty-note">Connect to a partner to request techniques from their profile list.</p>';
      return;
    }
    const allowed = TECHNIQUES.filter((t) => partner.techniques.includes(t.id));
    if (!allowed.length) {
      root.innerHTML = `<p class="technique-empty-note">${partner.displayName} has not selected any techniques on their profile yet.</p>`;
      return;
    }
    const intro = document.createElement("p");
    intro.className = "status-line technique-request-intro";
    intro.textContent = `Request from ${partner.displayName} (appears in chat):`;
    root.appendChild(intro);
    const grid = document.createElement("div");
    grid.className = "technique-request-grid";
    allowed.forEach((t) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "technique-request-btn";
      btn.textContent = t.label;
      btn.dataset.techniqueId = t.id;
      btn.addEventListener("click", () => {
        global.MemberProfile.requestTechnique(t.id, t.label);
      });
      grid.appendChild(btn);
    });
    root.appendChild(grid);
  }

  function getChatSenderName() {
    const p = loadProfile();
    if (p.displayName && p.displayName !== "Guest") return p.displayName;
    return "You";
  }

  function requestTechnique(techniqueId, label) {
    const id = String(techniqueId || "");
    const techLabel =
      label || TECHNIQUES.find((t) => t.id === id)?.label || id.replace(/_/g, " ");
    if (!id) return false;
    global.dispatchEvent(
      new CustomEvent("dualpeer-technique-request", {
        detail: { techniqueId: id, label: techLabel, fromName: getChatSenderName() },
      })
    );
    return true;
  }

  function handleIncomingTechniqueRequest(data) {
    const label = String(data.label || "").trim();
    const fromName = String(data.fromName || data.sender || "Partner").trim();
    if (!label) return;
    global.dispatchEvent(
      new CustomEvent("dualpeer-technique-request-incoming", {
        detail: { label, fromName, techniqueId: data.techniqueId, ts: data.ts },
      })
    );
  }

  function handleIncomingProfile(data) {
    if (!data?.profile) return;
    setPartnerProfile(data.profile);
  }

  function shareProfileOverDataChannel(sendFn) {
    if (typeof sendFn !== "function") return false;
    return sendFn({ type: "profile", profile: getPublicProfile(), ts: Date.now() });
  }

  function initPanelTabs() {
    document.querySelectorAll(".panel-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        setPanelTab(btn.getAttribute("data-panel-tab"), { userAction: true });
      });
    });
    const openProfile = document.getElementById("btnOpenProfileTab");
    if (openProfile) {
      openProfile.addEventListener("click", () => {
        setPanelTab("profile", { userAction: true });
        if (global.dualPeerUi?.closeAccountMenu) global.dualPeerUi.closeAccountMenu();
        else document.getElementById("accountMenu")?.classList.remove("is-open");
        document.getElementById("accountDropdown")?.setAttribute("hidden", "");
        fillProfileForm(loadProfile());
      });
    }
    const openSetup = document.getElementById("btnOpenSetupTab");
    if (openSetup) {
      openSetup.addEventListener("click", () => setPanelTab("setup", { userAction: true }));
    }
    setPanelTab("setup");
  }

  function initProfileForm() {
    renderTechniqueChecklist();
    fillProfileForm(loadProfile());
    refreshAccountMini();

    const form = document.getElementById("profileForm");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const saved = saveProfile(readProfileForm());
        fillProfileForm(saved);
        const msg = document.getElementById("profileSaveStatus");
        if (msg) {
          msg.hidden = false;
          msg.textContent = "Profile saved on this device.";
          msg.className = "status-line ok";
          setTimeout(() => {
            msg.hidden = true;
          }, 2500);
        }
        global.dispatchEvent(new CustomEvent("dualpeer-profile-share-request"));
      });
    }
  }

  function init() {
    initPanelTabs();
    initProfileForm();
    dispatchProfileUpdate();
  }

  global.MemberProfile = {
    TECHNIQUES,
    loadProfile,
    saveProfile,
    getPublicProfile,
    getPartnerProfile,
    setPartnerProfile,
    genderLabel,
    setPanelTab,
    maybeAutoStreamTab,
    getChatSenderName,
    requestTechnique,
    handleIncomingTechniqueRequest,
    handleIncomingProfile,
    shareProfileOverDataChannel,
    refreshAccountMini,
    init,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
