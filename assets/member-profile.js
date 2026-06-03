/**
 * Member profile — localStorage (guest) or server sync when logged in (Phase 2).
 */
(function (global) {
  const STORAGE_KEY = "dualpeer-member-profile-v1";
  const LEGACY_NAME_KEY = "dualpeer-profile-name";
  const WELCOME_BANNER_KEY = "dualpeer-profile-welcome-dismissed";

  function builtInTechniqueIds() {
    return global.DualPeerTechniques?.allBuiltinIds?.() || new Set();
  }

  function presetsForCurrentGender(gender) {
    if (global.DualPeerTechniques?.presetsForGender) {
      return global.DualPeerTechniques.presetsForGender(gender);
    }
    return [];
  }

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
      nationality: "",
      languages: "",
      location: "",
      bio: "",
      lovenseToys: "",
      techniques: [],
      customTechniques: [],
      updatedAt: Date.now(),
    };
  }

  function makeCustomTechniqueId(label) {
    const slug = String(label || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 32);
    return `custom_${slug || "technique"}_${Date.now().toString(36).slice(-5)}`;
  }

  function normalizeCustomTechniques(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const label = String(item?.label || "").trim().slice(0, 48);
      let id = String(item?.id || "").trim();
      if (!label) continue;
      if (!id) id = makeCustomTechniqueId(label);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label });
    }
    return out;
  }

  function normalizeProfile(raw) {
    const base = defaultProfile();
    if (!raw || typeof raw !== "object") return base;

    const customTechniques = normalizeCustomTechniques(raw.customTechniques);
    const builtInIds = builtInTechniqueIds();
    const customIds = new Set(customTechniques.map((c) => c.id));
    const techniques = Array.isArray(raw.techniques)
      ? [...new Set(raw.techniques.filter((id) => builtInIds.has(id) || customIds.has(id)))]
      : [];

    const displayName = String(raw.displayName || raw.name || "Guest").trim().slice(0, 32) || "Guest";
    return {
      displayName,
      gender: GENDERS.some((g) => g.value === raw.gender) ? raw.gender : "",
      nationality: String(raw.nationality || "").trim().slice(0, 64),
      languages: String(raw.languages || "").trim().slice(0, 120),
      location: String(raw.location || "").trim().slice(0, 120),
      bio: String(raw.bio || "").trim().slice(0, 500),
      lovenseToys: String(raw.lovenseToys || "").trim().slice(0, 500),
      techniques,
      customTechniques,
      updatedAt: raw.updatedAt || Date.now(),
    };
  }

  function isAccountMode() {
    return Boolean(global.DualPeerAuth?.isLoggedIn?.());
  }

  function profileFromAuth(raw) {
    if (!raw || typeof raw !== "object") return null;
    return normalizeProfile({
      displayName: raw.displayName,
      gender: raw.gender,
      nationality: raw.nationality,
      languages: raw.languages,
      location: raw.location,
      bio: raw.bio,
      lovenseToys: raw.lovenseToys,
      techniques: raw.techniques,
      customTechniques: raw.customTechniques,
    });
  }

  function persistLocal(profile) {
    const next = normalizeProfile(profile);
    next.updatedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      localStorage.setItem(LEGACY_NAME_KEY, next.displayName);
    } catch (_) {
      /* ignore */
    }
    return next;
  }

  function loadProfile() {
    if (isAccountMode()) {
      const cached = global.DualPeerAuth.getCachedProfile();
      const fromAuth = profileFromAuth(cached);
      if (fromAuth) return fromAuth;
    }
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
    const next = persistLocal(profile);
    if (isAccountMode()) {
      global.DualPeerAuth.updateProfile({
        displayName: next.displayName,
        gender: next.gender,
        nationality: next.nationality,
        languages: next.languages,
        location: next.location,
        bio: next.bio,
        lovenseToys: next.lovenseToys,
        techniques: next.techniques,
        customTechniques: next.customTechniques,
      }).catch(() => {
        /* keep local copy; user can retry save */
      });
    }
    dispatchProfileUpdate();
    return next;
  }

  function updateProfileTabHint() {
    const hint = document.getElementById("profileTabHint");
    if (!hint) return;
    if (isAccountMode()) {
      hint.hidden = true;
      return;
    }
    hint.hidden = false;
    hint.textContent =
      "Stored on this device only. Sign in from the start screen to sync your profile with your account.";
  }

  function resolveTechniqueLabel(id, profile) {
    const p = profile || loadProfile();
    const builtIn = (global.DualPeerTechniques?.allPresets?.() || []).find((t) => t.id === id);
    if (builtIn) return builtIn.label;
    const custom = (p.customTechniques || []).find((c) => c.id === id);
    if (custom) return custom.label;
    return String(id || "").replace(/_/g, " ");
  }

  /** Techniques the profile owner has enabled (freigegeben). */
  function getEnabledTechniques(profile) {
    const p = normalizeProfile(profile);
    return p.techniques.map((id) => ({ id, label: resolveTechniqueLabel(id, p) }));
  }

  function getPublicProfile() {
    const p = loadProfile();
    return {
      displayName: p.displayName,
      gender: p.gender,
      bio: p.bio,
      techniques: [...p.techniques],
      customTechniques: p.customTechniques.map((c) => ({ ...c })),
    };
  }

  function getPartnerProfile() {
    if (!partnerProfile) return null;
    return {
      ...partnerProfile,
      techniques: [...partnerProfile.techniques],
      customTechniques: (partnerProfile.customTechniques || []).map((c) => ({ ...c })),
    };
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
    const partner = getPartnerProfile();
    document.querySelectorAll("[data-partner-technique-summary]").forEach((el) => {
      if (!partner) {
        el.textContent = "Partner: not connected";
        return;
      }
      const pc = partner.techniques.length;
      el.textContent =
        pc === 0
          ? `${partner.displayName}: no techniques enabled`
          : `${partner.displayName}: ${pc} technique${pc === 1 ? "" : "s"} available`;
    });
  }

  function setTabInGroup(root, tabId, tabAttr, panelAttr, { userPinField } = {}) {
    if (!root) return;
    if (userPinField) userPinnedTab = true;
    root.querySelectorAll(`[${tabAttr}]`).forEach((btn) => {
      const on = btn.getAttribute(tabAttr) === tabId;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    root.querySelectorAll(`[${panelAttr}]`).forEach((panel) => {
      panel.hidden = panel.getAttribute(panelAttr) !== tabId;
    });
  }

  function initTabGroup(root, { tabAttr, panelAttr, defaultTab, userPinField = false }) {
    if (!root) return;
    root.querySelectorAll(`[${tabAttr}]`).forEach((btn) => {
      btn.addEventListener("click", () => {
        setTabInGroup(root, btn.getAttribute(tabAttr), tabAttr, panelAttr, {
          userPinField: userPinField && tabAttr === "data-panel-tab",
        });
      });
    });
    setTabInGroup(root, defaultTab, tabAttr, panelAttr);
  }

  function getConnectionTabsRoot() {
    return document.querySelector(".connection-card.panel-tabs-card");
  }

  function getActivePanelTab() {
    const root = getConnectionTabsRoot();
    const btn = root?.querySelector(".panel-tab.is-active");
    return btn?.getAttribute("data-panel-tab") || "setup";
  }

  function setPanelTab(tabId, { userAction = false } = {}) {
    if (userAction) userPinnedTab = true;
    const next = tabId || "setup";
    setTabInGroup(getConnectionTabsRoot(), next, "data-panel-tab", "data-panel-tab-panel");
    document.dispatchEvent(new CustomEvent("dualpeer-panel-tab", { detail: { tab: next, userAction } }));
  }

  function setRemoteTab(tabId) {
    const root = document.getElementById("remoteCard");
    setTabInGroup(root, tabId || "techniques", "data-remote-tab", "data-remote-tab-panel");
  }

  function maybeAutoStreamTab(isLive) {
    if (userPinnedTab) return;
    if (isLive) setPanelTab("stream");
    else if (getActivePanelTab() === "stream") setPanelTab("setup");
  }

  function readProfileForm() {
    const nameEl = document.getElementById("profileDisplayName");
    const genderEl = document.getElementById("profileGender");
    const nationalityEl = document.getElementById("profileNationality");
    const languagesEl = document.getElementById("profileLanguages");
    const locationEl = document.getElementById("profileLocation");
    const bioEl = document.getElementById("profileBio");
    const toysEl = document.getElementById("profileLovenseToys");
    const current = loadProfile();
    const techniques = [];
    document.querySelectorAll('input[name="profileTechnique"]:checked').forEach((el) => {
      if (el instanceof HTMLInputElement && el.value) techniques.push(el.value);
    });
    return normalizeProfile({
      displayName: nameEl instanceof HTMLInputElement ? nameEl.value : "Guest",
      gender: genderEl instanceof HTMLSelectElement ? genderEl.value : "",
      nationality: nationalityEl instanceof HTMLInputElement ? nationalityEl.value : "",
      languages: languagesEl instanceof HTMLInputElement ? languagesEl.value : "",
      location: locationEl instanceof HTMLInputElement ? locationEl.value : "",
      bio: bioEl instanceof HTMLTextAreaElement ? bioEl.value : "",
      lovenseToys: toysEl instanceof HTMLTextAreaElement ? toysEl.value : "",
      techniques,
      customTechniques: current.customTechniques,
    });
  }

  function getAccountAvatarUrl() {
    if (!isAccountMode()) return null;
    const cached = global.DualPeerAuth?.getCachedProfile?.();
    if (cached?.avatarUrl) return cached.avatarUrl;
    const session = global.DualPeerAuth?.getSession?.();
    return session?.user?.avatarUrl || null;
  }

  function resolveAvatarSrc(path) {
    if (!path) return "";
    try {
      return new URL(String(path), location.origin).href;
    } catch (_) {
      return global.DualPeerAuth?.resolveAssetUrl?.(path) || String(path);
    }
  }

  function updateProfileAvatarPreview(avatarUrl) {
    const block = document.querySelector(".profile-avatar-block");
    const wrap = document.querySelector(".profile-avatar-preview-wrap");
    const img = document.getElementById("profileAvatarImg");
    const placeholder = document.getElementById("profileAvatarPlaceholder");
    const removeBtn = document.getElementById("profileAvatarRemove");
    const path = avatarUrl !== undefined ? avatarUrl : getAccountAvatarUrl();
    const src = resolveAvatarSrc(path);
    const profile = loadProfile();
    const initial = (profile.displayName || "?").charAt(0).toUpperCase() || "?";

    if (block) block.hidden = !isAccountMode();

    if (placeholder) {
      placeholder.textContent = initial;
      placeholder.hidden = false;
      placeholder.removeAttribute("hidden");
    }

    if (wrap) wrap.classList.toggle("has-photo", Boolean(src));

    if (img instanceof HTMLImageElement) {
      img.onload = null;
      img.onerror = null;
      if (src) {
        img.onerror = () => {
          if (wrap) wrap.classList.remove("has-photo");
          img.removeAttribute("src");
          setProfileAvatarStatus("Photo could not be loaded. Try uploading again.", "err");
        };
        img.onload = () => {
          if (placeholder) placeholder.hidden = true;
          setProfileAvatarStatus("");
        };
        img.removeAttribute("hidden");
        img.src = src;
      } else {
        img.setAttribute("hidden", "");
        img.removeAttribute("src");
      }
    }
    if (removeBtn instanceof HTMLButtonElement) {
      removeBtn.hidden = !src;
    }
  }

  function resizeImageFile(file, maxSide = 512) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        let w = image.naturalWidth;
        let h = image.naturalHeight;
        if (!w || !h) {
          reject(new Error("Invalid image"));
          return;
        }
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Could not process image"));
          return;
        }
        ctx.drawImage(image, 0, 0, w, h);
        const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
        const quality = mime === "image/jpeg" ? 0.88 : undefined;
        resolve(canvas.toDataURL(mime, quality));
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read image"));
      };
      image.src = url;
    });
  }

  function setProfileAvatarStatus(text, kind) {
    const el = document.getElementById("profileAvatarStatus");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.className = "status-line profile-avatar-status" + (kind ? ` ${kind}` : "");
  }

  function initProfileAvatar() {
    const input = document.getElementById("profileAvatarInput");
    const removeBtn = document.getElementById("profileAvatarRemove");
    updateProfileAvatarPreview();

    if (input) {
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        input.value = "";
        if (!file || !isAccountMode()) return;
        if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
          setProfileAvatarStatus("Use JPEG, PNG or WebP.", "err");
          return;
        }
        if (file.size > 2_500_000) {
          setProfileAvatarStatus("Image must be 2.5 MB or smaller.", "err");
          return;
        }
        setProfileAvatarStatus("Uploading…", "");
        try {
          const imageData = await resizeImageFile(file);
          const url = await global.DualPeerAuth.uploadProfileAvatar(imageData);
          updateProfileAvatarPreview(url);
          setProfileAvatarStatus("Photo saved.", "ok");
          setTimeout(() => setProfileAvatarStatus(""), 2500);
        } catch (err) {
          setProfileAvatarStatus(err.message || "Upload failed.", "err");
        }
      });
    }

    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        if (!isAccountMode()) return;
        setProfileAvatarStatus("Removing…", "");
        try {
          await global.DualPeerAuth.deleteProfileAvatar();
          updateProfileAvatarPreview(null);
          setProfileAvatarStatus("Photo removed.", "ok");
          setTimeout(() => setProfileAvatarStatus(""), 2500);
        } catch (err) {
          setProfileAvatarStatus(err.message || "Could not remove photo.", "err");
        }
      });
    }
  }

  function fillProfileForm(profile) {
    const p = normalizeProfile(profile);
    const nameEl = document.getElementById("profileDisplayName");
    const genderEl = document.getElementById("profileGender");
    const nationalityEl = document.getElementById("profileNationality");
    const languagesEl = document.getElementById("profileLanguages");
    const locationEl = document.getElementById("profileLocation");
    const bioEl = document.getElementById("profileBio");
    const toysEl = document.getElementById("profileLovenseToys");
    if (nameEl instanceof HTMLInputElement) {
      nameEl.value = p.displayName === "Guest" ? "" : p.displayName;
    }
    if (genderEl instanceof HTMLSelectElement) genderEl.value = p.gender;
    if (nationalityEl instanceof HTMLInputElement) nationalityEl.value = p.nationality || "";
    if (languagesEl instanceof HTMLInputElement) languagesEl.value = p.languages || "";
    if (locationEl instanceof HTMLInputElement) locationEl.value = p.location || "";
    if (bioEl instanceof HTMLTextAreaElement) bioEl.value = p.bio;
    if (toysEl instanceof HTMLTextAreaElement) toysEl.value = p.lovenseToys || "";
    document.querySelectorAll('input[name="profileTechnique"]').forEach((el) => {
      if (!(el instanceof HTMLInputElement)) return;
      el.checked = p.techniques.includes(el.value);
    });
    updateProfileAvatarPreview();
  }

  function renderTechniqueChecklist() {
    const presetRoot = document.getElementById("profileTechniqueList");
    const customRoot = document.getElementById("profileCustomTechniqueList");
    const p = loadProfile();
    if (presetRoot) {
      presetRoot.innerHTML = "";
      const genderEl = document.getElementById("profileGender");
      const gender =
        genderEl instanceof HTMLSelectElement ? genderEl.value : p.gender || "";
      const presetTitle = document.createElement("p");
      presetTitle.className = "status-line profile-preset-heading";
      presetTitle.textContent =
        gender === "male"
          ? "Presets (male)"
          : gender === "female"
            ? "Presets (female)"
            : "Presets";
      presetRoot.appendChild(presetTitle);
      const grid = document.createElement("div");
      grid.className = "profile-technique-grid";
      presetsForCurrentGender(gender).forEach((t) => {
        grid.appendChild(buildTechniqueCheckbox(t.id, t.label, p.techniques.includes(t.id), false));
      });
      presetRoot.appendChild(grid);
    }
    if (customRoot) {
      customRoot.innerHTML = "";
      if (!p.customTechniques.length) {
        const empty = document.createElement("p");
        empty.className = "technique-empty-note";
        empty.textContent = "No custom techniques yet — add one below.";
        customRoot.appendChild(empty);
        return;
      }
      p.customTechniques.forEach((t) => {
        const row = buildTechniqueCheckbox(t.id, t.label, p.techniques.includes(t.id), true);
        customRoot.appendChild(row);
      });
    }
  }

  function buildTechniqueCheckbox(id, label, checked, isCustom) {
    const labelEl = document.createElement("label");
    labelEl.className = "technique-check" + (isCustom ? " technique-check-custom" : "");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "profileTechnique";
    input.value = id;
    input.checked = checked;
    const span = document.createElement("span");
    span.textContent = label;
    labelEl.appendChild(input);
    labelEl.appendChild(span);
    if (isCustom) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "technique-remove-btn";
      removeBtn.textContent = "Remove";
      removeBtn.title = "Remove custom technique";
      removeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeCustomTechnique(id);
      });
      labelEl.appendChild(removeBtn);
    }
    return labelEl;
  }

  function addCustomTechnique(label) {
    const trimmed = String(label || "").trim().slice(0, 48);
    if (!trimmed) return { ok: false, error: "Enter a technique name." };
    const profile = loadProfile();
    const duplicate = profile.customTechniques.some(
      (c) => c.label.toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) return { ok: false, error: "This technique already exists." };
    const id = makeCustomTechniqueId(trimmed);
    profile.customTechniques.push({ id, label: trimmed });
    if (!profile.techniques.includes(id)) profile.techniques.push(id);
    saveProfile(profile);
    renderTechniqueChecklist();
    return { ok: true };
  }

  function removeCustomTechnique(id) {
    const profile = loadProfile();
    profile.customTechniques = profile.customTechniques.filter((c) => c.id !== id);
    profile.techniques = profile.techniques.filter((tid) => tid !== id);
    saveProfile(profile);
    renderTechniqueChecklist();
  }

  function renderPartnerTechniqueButtons() {
    const root = document.getElementById("techniqueRequestList");
    if (!root) return;
    root.innerHTML = "";
    const partner = getPartnerProfile();
    if (!partner) {
      root.innerHTML =
        '<p class="technique-empty-note">Connect to a partner to see their enabled techniques.</p>';
      return;
    }
    const allowed = getEnabledTechniques(partner);
    if (!allowed.length) {
      root.innerHTML = `<p class="technique-empty-note">${partner.displayName} has not enabled any techniques on their profile yet.</p>`;
      return;
    }
    const intro = document.createElement("p");
    intro.className = "status-line technique-request-intro";
    intro.textContent = `Enabled by ${partner.displayName} (tap to request in chat):`;
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
    const techLabel = label || resolveTechniqueLabel(id, loadProfile());
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

  function isWelcomeBannerDismissed() {
    try {
      return localStorage.getItem(WELCOME_BANNER_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function dismissWelcomeBanner() {
    if (isWelcomeBannerDismissed()) return;
    try {
      localStorage.setItem(WELCOME_BANNER_KEY, "1");
    } catch (_) {
      /* ignore */
    }
    const el = document.getElementById("profileWelcomeBanner");
    if (!el) return;
    el.classList.add("is-hiding");
    window.setTimeout(() => {
      el.hidden = true;
      el.classList.remove("is-hiding");
    }, 320);
  }

  function refreshWelcomeBanner() {
    const el = document.getElementById("profileWelcomeBanner");
    if (!el) return;
    if (!isAccountMode() || isWelcomeBannerDismissed()) {
      el.hidden = true;
      return;
    }
    const user = global.DualPeerAuth?.getSession?.()?.user;
    const name = user?.displayName || user?.username || "Guest";
    const nameEl = el.querySelector("[data-welcome-name]");
    if (nameEl) nameEl.textContent = name;
    el.hidden = false;
    el.classList.remove("is-hiding");
  }

  function initWelcomeBannerDismiss() {
    const form = document.getElementById("profileForm");
    if (!form) return;
    const onEdit = () => dismissWelcomeBanner();
    form.querySelectorAll("input, textarea, select").forEach((el) => {
      el.addEventListener("input", onEdit);
      el.addEventListener("change", onEdit);
    });
    const customRoot = document.getElementById("profileCustomTechniqueList");
    const presetRoot = document.getElementById("profileTechniqueList");
    customRoot?.addEventListener("change", onEdit);
    presetRoot?.addEventListener("change", onEdit);
    document.getElementById("btnAddCustomTechnique")?.addEventListener("click", onEdit);
  }

  function enterProfileWorkspace({ onboarding = false } = {}) {
    setPanelTab("profile", { userAction: Boolean(onboarding) });
    fillProfileForm(loadProfile());
    renderTechniqueChecklist();
    refreshWelcomeBanner();
    updateProfileTabHint();
  }

  function initConnectionTabs() {
    initTabGroup(getConnectionTabsRoot(), {
      tabAttr: "data-panel-tab",
      panelAttr: "data-panel-tab-panel",
      defaultTab: "profile",
      userPinField: true,
    });
    const openProfile = document.getElementById("btnOpenProfileTab");
    if (openProfile) {
      openProfile.addEventListener("click", () => {
        setPanelTab("profile", { userAction: true });
        if (global.dualPeerUi?.closeAccountMenu) global.dualPeerUi.closeAccountMenu();
        else document.getElementById("accountMenu")?.classList.remove("is-open");
        document.getElementById("accountDropdown")?.setAttribute("hidden", "");
        fillProfileForm(loadProfile());
        renderTechniqueChecklist();
      });
    }
    const openSetup = document.getElementById("btnOpenSetupTab");
    if (openSetup) {
      openSetup.addEventListener("click", () => setPanelTab("setup", { userAction: true }));
    }
  }

  function initRemoteTabs() {
    initTabGroup(document.getElementById("remoteCard"), {
      tabAttr: "data-remote-tab",
      panelAttr: "data-remote-tab-panel",
      defaultTab: "techniques",
    });
    if (location.hash === "#premium-modelpool") {
      setRemoteTab("modelpool");
    }
  }

  function initProfileForm() {
    renderTechniqueChecklist();
    fillProfileForm(loadProfile());
    initProfileAvatar();
    refreshAccountMini();
    initWelcomeBannerDismiss();
    refreshWelcomeBanner();

    const addBtn = document.getElementById("btnAddCustomTechnique");
    const addInput = document.getElementById("profileCustomTechniqueInput");
    const runAdd = () => {
      const result = addCustomTechnique(addInput?.value || "");
      const msg = document.getElementById("profileSaveStatus");
      if (!result.ok) {
        if (msg) {
          msg.hidden = false;
          msg.textContent = result.error || "Could not add technique.";
          msg.className = "status-line err";
        }
        return;
      }
      if (addInput instanceof HTMLInputElement) addInput.value = "";
      if (msg) {
        msg.hidden = false;
        msg.textContent = "Custom technique added — click Save profile to sync if needed.";
        msg.className = "status-line ok";
        setTimeout(() => {
          msg.hidden = true;
        }, 2200);
      }
    };
    if (addBtn) addBtn.addEventListener("click", runAdd);
    if (addInput) {
      addInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          runAdd();
        }
      });
    }

    const genderEl = document.getElementById("profileGender");
    if (genderEl) {
      genderEl.addEventListener("change", () => {
        renderTechniqueChecklist();
      });
    }

    const form = document.getElementById("profileForm");
    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        dismissWelcomeBanner();
        const msg = document.getElementById("profileSaveStatus");
        const draft = readProfileForm();
        if (isAccountMode()) {
          if (msg) {
            msg.hidden = false;
            msg.textContent = "Saving…";
            msg.className = "status-line";
          }
          try {
            const updated = await global.DualPeerAuth.updateProfile({
              displayName: draft.displayName,
              gender: draft.gender,
              nationality: draft.nationality,
              languages: draft.languages,
              location: draft.location,
              bio: draft.bio,
              lovenseToys: draft.lovenseToys,
              techniques: draft.techniques,
              customTechniques: draft.customTechniques,
            });
            const saved = persistLocal(profileFromAuth(updated) || draft);
            fillProfileForm(saved);
            renderTechniqueChecklist();
            refreshWelcomeBanner();
            if (msg) {
              msg.textContent = "Profile saved.";
              msg.className = "status-line ok";
            }
          } catch (err) {
            if (msg) {
              msg.textContent = err.message || "Could not save profile.";
              msg.className = "status-line err";
            }
            return;
          }
        } else {
          const saved = saveProfile(draft);
          fillProfileForm(saved);
          renderTechniqueChecklist();
          if (msg) {
            msg.hidden = false;
            msg.textContent = "Profile saved on this device.";
            msg.className = "status-line ok";
          }
        }
        if (msg) {
          setTimeout(() => {
            msg.hidden = true;
          }, 2500);
        }
        global.dispatchEvent(new CustomEvent("dualpeer-profile-share-request"));
      });
    }
  }

  function onAuthProfileSynced() {
    fillProfileForm(loadProfile());
    renderTechniqueChecklist();
    updateProfileTabHint();
    refreshWelcomeBanner();
    dispatchProfileUpdate();
  }

  function init() {
    const start = () => {
      initConnectionTabs();
      initRemoteTabs();
      initProfileForm();
      updateProfileTabHint();
      dispatchProfileUpdate();
    };

    if (global.DualPeerAuth?.onReady) {
      global.DualPeerAuth.onReady(start);
    } else {
      start();
    }

    global.addEventListener("dualpeer-auth-change", () => {
      onAuthProfileSynced();
      if (global.DualPeerAuth?.isLoggedIn?.()) {
        enterProfileWorkspace();
      }
    });
    global.addEventListener("dualpeer-profile-update", (e) => {
      if (e.detail?.profile) persistLocal(e.detail.profile);
      onAuthProfileSynced();
    });
    global.addEventListener("dualpeer-avatar-ready", () => {
      updateProfileAvatarPreview();
    });
    global.addEventListener("dualpeer-enter-profile", () => {
      enterProfileWorkspace({ onboarding: true });
    });

    if (global.DualPeerAuth?.onReady) {
      global.DualPeerAuth.onReady(() => {
        if (global.DualPeerAuth.isLoggedIn()) {
          enterProfileWorkspace({
            onboarding: new URLSearchParams(location.search).get("onboard") === "1",
          });
        }
      });
    }
  }

  global.MemberProfile = {
    presetsForGender: presetsForCurrentGender,
    loadProfile,
    saveProfile,
    getPublicProfile,
    getPartnerProfile,
    getEnabledTechniques,
    setPartnerProfile,
    genderLabel,
    setPanelTab,
    enterProfileWorkspace,
    refreshWelcomeBanner,
    dismissWelcomeBanner,
    setRemoteTab,
    maybeAutoStreamTab,
    getChatSenderName,
    requestTechnique,
    addCustomTechnique,
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
