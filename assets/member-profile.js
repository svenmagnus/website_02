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

  function normalizePlayPrefs(raw) {
    if (global.DualPeerPlayPrefs?.normalizePlayPrefs) {
      return global.DualPeerPlayPrefs.normalizePlayPrefs(raw);
    }
    return { dynamics: [], kinks: [], intensity: [] };
  }

  function defaultProfile() {
    return {
      displayName: "Guest",
      gender: "",
      age: null,
      bodyType: "",
      interestedIn: "",
      nationality: "",
      languages: "",
      location: "",
      bio: "",
      lovenseToys: "",
      galleryImages: [],
      techniques: [],
      customTechniques: [],
      customMenus: [],
      enabledCustomMenus: [],
      playPrefs: normalizePlayPrefs(null),
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

  function makeCustomMenuId(title) {
    const slug = String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 24);
    return `menu_${slug || "menu"}_${Date.now().toString(36).slice(-5)}`;
  }

  function normalizeCustomMenus(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const menu of raw) {
      const title = String(menu?.title || "").trim().slice(0, 32);
      let id = String(menu?.id || "").trim();
      if (!title) continue;
      if (!id) id = makeCustomMenuId(title);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title, items: normalizeCustomTechniques(menu?.items) });
    }
    return out;
  }

  function normalizeEnabledCustomMenus(raw, menuIds) {
    const valid = new Set(menuIds || []);
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((id) => String(id)).filter((id) => valid.has(id)))];
  }

  function customMenuItemIds(profile, menuIds) {
    const enabled = new Set(menuIds || profile.enabledCustomMenus || []);
    const ids = [];
    (profile.customMenus || []).forEach((menu) => {
      if (!enabled.has(menu.id)) return;
      (menu.items || []).forEach((item) => {
        if (item?.id) ids.push(item.id);
      });
    });
    return ids;
  }

  function allCustomTechniqueIds(profile) {
    const p = profile || loadProfile();
    const ids = new Set((p.customTechniques || []).map((c) => c.id));
    customMenuItemIds(p, p.enabledCustomMenus).forEach((id) => ids.add(id));
    return ids;
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
    const customMenus = normalizeCustomMenus(raw.customMenus);
    const enabledCustomMenus = normalizeEnabledCustomMenus(
      raw.enabledCustomMenus,
      customMenus.map((m) => m.id)
    );
    const builtInIds = builtInTechniqueIds();
    const customIds = allCustomTechniqueIds({
      customTechniques,
      customMenus,
      enabledCustomMenus,
    });
    const techniques = Array.isArray(raw.techniques)
      ? [...new Set(raw.techniques.filter((id) => builtInIds.has(id) || customIds.has(id)))]
      : [];

    const displayName = String(raw.displayName || raw.name || "Guest").trim().slice(0, 32) || "Guest";
    let age = null;
    if (raw.age != null && raw.age !== "") {
      const n = Number(raw.age);
      if (Number.isInteger(n) && n >= 18 && n <= 120) age = n;
    }
    const bodyType = String(raw.bodyType || "").trim().slice(0, 48);
    const interestedIn = String(raw.interestedIn || "").trim().slice(0, 120);
    const galleryImages = Array.isArray(raw.galleryImages)
      ? raw.galleryImages.filter((img) => img && img.url)
      : [];
    return {
      displayName,
      gender: GENDERS.some((g) => g.value === raw.gender) ? raw.gender : "",
      age,
      bodyType,
      interestedIn,
      nationality: String(raw.nationality || "").trim().slice(0, 64),
      languages: String(raw.languages || "").trim().slice(0, 120),
      location: String(raw.location || "").trim().slice(0, 120),
      bio: String(raw.bio || "").trim().slice(0, 500),
      lovenseToys: String(raw.lovenseToys || "").trim().slice(0, 500),
      galleryImages,
      techniques,
      customTechniques,
      customMenus,
      enabledCustomMenus,
      playPrefs: normalizePlayPrefs(raw.playPrefs),
      updatedAt: raw.updatedAt || Date.now(),
      chatColors:
        raw.chatColors && typeof raw.chatColors === "object"
          ? {
              name: String(raw.chatColors.name || "").trim(),
              text: String(raw.chatColors.text || "").trim(),
            }
          : null,
      playModeSound: String(raw.playModeSound || "").trim() || null,
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
      age: raw.age,
      bodyType: raw.bodyType,
      interestedIn: raw.interestedIn,
      nationality: raw.nationality,
      languages: raw.languages,
      location: raw.location,
      bio: raw.bio,
      lovenseToys: raw.lovenseToys,
      galleryImages: raw.galleryImages,
      techniques: raw.techniques,
      customTechniques: raw.customTechniques,
      customMenus: raw.customMenus,
      enabledCustomMenus: raw.enabledCustomMenus,
      playPrefs: raw.playPrefs,
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
        age: next.age,
        bodyType: next.bodyType,
        interestedIn: next.interestedIn,
        nationality: next.nationality,
        languages: next.languages,
        location: next.location,
        bio: next.bio,
        lovenseToys: next.lovenseToys,
        techniques: next.techniques,
        customTechniques: next.customTechniques,
        customMenus: next.customMenus,
        enabledCustomMenus: next.enabledCustomMenus,
        playPrefs: next.playPrefs,
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
    for (const menu of p.customMenus || []) {
      const item = (menu.items || []).find((c) => c.id === id);
      if (item) return item.label;
    }
    return String(id || "").replace(/_/g, " ");
  }

  /** Techniques the profile owner has enabled (freigegeben). */
  function getEnabledTechniques(profile) {
    const p = normalizeProfile(profile);
    return p.techniques.map((id) => ({ id, label: resolveTechniqueLabel(id, p) }));
  }

  function partnerPlaybookSections(profile) {
    const p = normalizeProfile(profile);
    const enabled = new Set(p.techniques || []);
    const sections = [];

    const presetSections =
      global.DualPeerTechniques?.presetSectionsForPlayPrefs?.(p.playPrefs) || [];
    presetSections.forEach((section) => {
      const items = section.items
        .filter((t) => enabled.has(t.id))
        .map((t) => ({ id: t.id, label: t.label }));
      if (items.length) sections.push({ title: section.title, items });
    });

    enabledCustomMenuSections(p, p.enabledCustomMenus).forEach((section) => {
      const items = section.items
        .filter((t) => enabled.has(t.id))
        .map((t) => ({ id: t.id, label: t.label }));
      if (items.length) sections.push({ title: section.title, items });
    });

    const menuItemIds = new Set();
    (p.customMenus || []).forEach((menu) => {
      (menu.items || []).forEach((item) => menuItemIds.add(item.id));
    });
    const standaloneCustom = (p.customTechniques || [])
      .filter((c) => enabled.has(c.id) && !menuItemIds.has(c.id))
      .map((c) => ({ id: c.id, label: c.label }));
    if (standaloneCustom.length) {
      sections.push({ title: "Custom actions", items: standaloneCustom });
    }

    const assigned = new Set();
    sections.forEach((s) => s.items.forEach((i) => assigned.add(i.id)));
    const orphans = [...enabled]
      .filter((id) => !assigned.has(id))
      .map((id) => ({ id, label: resolveTechniqueLabel(id, p) }));
    if (orphans.length) {
      sections.push({ title: "Other", items: orphans });
    }

    return sections;
  }

  function getPublicProfile() {
    const p = loadProfile();
    return {
      displayName: p.displayName,
      gender: p.gender,
      bio: p.bio,
      techniques: [...p.techniques],
      customTechniques: p.customTechniques.map((c) => ({ ...c })),
      customMenus: p.customMenus.map((m) => ({
        id: m.id,
        title: m.title,
        items: (m.items || []).map((c) => ({ ...c })),
      })),
      enabledCustomMenus: [...p.enabledCustomMenus],
      playPrefs: {
        dynamics: [...(p.playPrefs?.dynamics || [])],
        kinks: [...(p.playPrefs?.kinks || [])],
        intensity: [...(p.playPrefs?.intensity || [])],
      },
      chatColors: global.DualPeerChatUi?.getMyDisplayColors?.() || null,
      playModeSound: global.DualPeerPlayModeSounds?.loadSoundId?.() || null,
    };
  }

  function getPartnerProfile() {
    if (!partnerProfile) return null;
    return {
      ...partnerProfile,
      techniques: [...partnerProfile.techniques],
      customTechniques: (partnerProfile.customTechniques || []).map((c) => ({ ...c })),
      customMenus: (partnerProfile.customMenus || []).map((m) => ({
        id: m.id,
        title: m.title,
        items: (m.items || []).map((c) => ({ ...c })),
      })),
      enabledCustomMenus: [...(partnerProfile.enabledCustomMenus || [])],
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
          ? `${partner.displayName}: Playbook empty`
          : `${partner.displayName}: ${pc} Playbook action${pc === 1 ? "" : "s"}`;
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

  function readPlayPrefsFromForm() {
    const pick = (name) => {
      const ids = [];
      document.querySelectorAll(`input[name="${name}"]:checked`).forEach((el) => {
        if (el instanceof HTMLInputElement && el.value) ids.push(el.value);
      });
      return ids;
    };
    return normalizePlayPrefs({
      dynamics: pick("profileDynamics"),
      kinks: pick("profileKinks"),
      intensity: pick("profileIntensity"),
    });
  }

  function getCheckedTechniqueIds() {
    const ids = [];
    document.querySelectorAll('input[name="profileTechnique"]:checked').forEach((el) => {
      if (el instanceof HTMLInputElement && el.value) ids.push(el.value);
    });
    return ids;
  }

  function setTechniqueChecks(ids) {
    const set = new Set(ids);
    document.querySelectorAll('input[name="profileTechnique"]').forEach((el) => {
      if (el instanceof HTMLInputElement) el.checked = set.has(el.value);
    });
  }

  function readProfileForm() {
    const nameEl = document.getElementById("profileDisplayName");
    const genderEl = document.getElementById("profileGender");
    const ageEl = document.getElementById("profileAge");
    const bodyTypeEl = document.getElementById("profileBodyType");
    const interestedEl = document.getElementById("profileInterestedIn");
    const nationalityEl = document.getElementById("profileNationality");
    const languagesEl = document.getElementById("profileLanguages");
    const locationEl = document.getElementById("profileLocation");
    const bioEl = document.getElementById("profileBio");
    const toysEl = document.getElementById("profileLovenseToys");
    const current = loadProfile();
    return normalizeProfile({
      displayName: nameEl instanceof HTMLInputElement ? nameEl.value : "Guest",
      gender: genderEl instanceof HTMLSelectElement ? genderEl.value : "",
      age:
        ageEl instanceof HTMLInputElement && ageEl.value.trim()
          ? Number(ageEl.value)
          : null,
      bodyType: bodyTypeEl instanceof HTMLSelectElement ? bodyTypeEl.value : "",
      interestedIn: interestedEl instanceof HTMLSelectElement ? interestedEl.value : "",
      nationality: nationalityEl instanceof HTMLInputElement ? nationalityEl.value : "",
      languages: languagesEl instanceof HTMLInputElement ? languagesEl.value : "",
      location: locationEl instanceof HTMLInputElement ? locationEl.value : "",
      bio: bioEl instanceof HTMLTextAreaElement ? bioEl.value : "",
      lovenseToys: toysEl instanceof HTMLTextAreaElement ? toysEl.value : "",
      galleryImages: current.galleryImages,
      techniques: filterTechniquesForPlayPrefs(getCheckedTechniqueIds(), readPlayPrefsFromForm(), {
        customTechniques: current.customTechniques,
        customMenus: current.customMenus,
        enabledCustomMenus: getCheckedOwnMenuIds(),
      }),
      customTechniques: current.customTechniques,
      customMenus: current.customMenus,
      enabledCustomMenus: getCheckedOwnMenuIds(),
      playPrefs: readPlayPrefsFromForm(),
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

  function resizeImageFile(file, maxSide = 512, { forceJpeg = false } = {}) {
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
        const mime = forceJpeg || file.type !== "image/png" ? "image/jpeg" : "image/png";
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

  function setProfileGalleryStatus(msg, kind = "") {
    const el = document.getElementById("profileGalleryStatus");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      el.className = "status-line profile-gallery-status";
      return;
    }
    el.hidden = false;
    el.className = `status-line profile-gallery-status${kind ? ` ${kind}` : ""}`;
    el.textContent = msg;
  }

  function renderProfileGallery(images) {
    const grid = document.getElementById("profileGalleryGrid");
    if (!grid) return;
    grid.replaceChildren();
    const list = Array.isArray(images) ? images : [];
    for (const img of list) {
      if (!img?.url) continue;
      const wrap = document.createElement("div");
      wrap.className = "profile-gallery-item";
      const photo = document.createElement("img");
      photo.className = "profile-gallery-thumb";
      photo.alt = "";
      photo.loading = "lazy";
      photo.src = resolveAvatarSrc(img.url);
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "profile-gallery-remove";
      removeBtn.title = "Remove photo";
      removeBtn.setAttribute("aria-label", "Remove photo");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        void deleteGalleryImage(img.id);
      });
      wrap.appendChild(photo);
      wrap.appendChild(removeBtn);
      grid.appendChild(wrap);
    }
  }

  async function deleteGalleryImage(imageId) {
    if (!isAccountMode() || !global.DualPeerAuth?.api) return;
    setProfileGalleryStatus("Removing…", "");
    try {
      const data = await global.DualPeerAuth.api(
        `/api/profile/gallery/${encodeURIComponent(imageId)}`,
        { method: "DELETE" }
      );
      const cached = global.DualPeerAuth.getCachedProfile?.();
      if (cached) {
        cached.galleryImages = data.gallery || [];
        global.DualPeerAuth.cacheProfile?.(cached);
      }
      renderProfileGallery(data.gallery || []);
      setProfileGalleryStatus("Photo removed.", "ok");
      setTimeout(() => setProfileGalleryStatus(""), 2500);
    } catch (err) {
      setProfileGalleryStatus(err.message || "Could not remove photo.", "err");
    }
  }

  async function uploadGalleryFiles(files) {
    if (!isAccountMode() || !global.DualPeerAuth?.api) return;
    const list = Array.from(files || []).filter((f) => f && f.type.startsWith("image/"));
    if (!list.length) return;

    setProfileGalleryStatus("Uploading…", "");
    let gallery =
      global.DualPeerAuth.getCachedProfile?.()?.galleryImages ||
      loadProfile().galleryImages ||
      [];

    try {
      for (const file of list) {
        if (gallery.length >= 6) {
          setProfileGalleryStatus("Maximum 6 photos in gallery.", "err");
          break;
        }
        if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
          setProfileGalleryStatus("Use JPEG, PNG or WebP.", "err");
          break;
        }
        if (file.size > 2_500_000) {
          setProfileGalleryStatus("Image must be 2.5 MB or smaller.", "err");
          break;
        }
        const imageData = await resizeImageFile(file, 1280, { forceJpeg: true });
        const data = await global.DualPeerAuth.api("/api/profile/gallery", {
          method: "POST",
          body: JSON.stringify({ imageData }),
        });
        gallery = data.gallery || gallery;
      }
      const cached = global.DualPeerAuth.getCachedProfile?.();
      if (cached) {
        cached.galleryImages = gallery;
        global.DualPeerAuth.cacheProfile?.(cached);
      }
      renderProfileGallery(gallery);
      setProfileGalleryStatus("Gallery updated.", "ok");
      setTimeout(() => setProfileGalleryStatus(""), 2500);
    } catch (err) {
      const msg =
        err?.status === 413
          ? "Image too large for upload — try a smaller file or another photo."
          : err.message || "Upload failed.";
      setProfileGalleryStatus(msg, "err");
    }
  }

  function initProfileGallery() {
    const input = document.getElementById("profileGalleryInput");
    if (!(input instanceof HTMLInputElement) || input.dataset.galleryBound === "1") return;
    input.dataset.galleryBound = "1";
    input.addEventListener("change", () => {
      const files = input.files;
      if (files?.length) void uploadGalleryFiles(files);
      input.value = "";
    });
    const cached = global.DualPeerAuth?.getCachedProfile?.();
    renderProfileGallery(cached?.galleryImages || loadProfile().galleryImages || []);
  }

  function fillProfileForm(profile) {
    const p = normalizeProfile(profile);
    const nameEl = document.getElementById("profileDisplayName");
    const genderEl = document.getElementById("profileGender");
    const ageEl = document.getElementById("profileAge");
    const bodyTypeEl = document.getElementById("profileBodyType");
    const interestedEl = document.getElementById("profileInterestedIn");
    const nationalityEl = document.getElementById("profileNationality");
    const languagesEl = document.getElementById("profileLanguages");
    const locationEl = document.getElementById("profileLocation");
    const bioEl = document.getElementById("profileBio");
    const toysEl = document.getElementById("profileLovenseToys");
    if (nameEl instanceof HTMLInputElement) {
      nameEl.value = p.displayName === "Guest" ? "" : p.displayName;
    }
    if (genderEl instanceof HTMLSelectElement) genderEl.value = p.gender;
    if (ageEl instanceof HTMLInputElement) ageEl.value = p.age != null ? String(p.age) : "";
    if (bodyTypeEl instanceof HTMLSelectElement) bodyTypeEl.value = p.bodyType || "";
    if (interestedEl instanceof HTMLSelectElement) interestedEl.value = p.interestedIn || "";
    if (nationalityEl instanceof HTMLInputElement) nationalityEl.value = p.nationality || "";
    if (languagesEl instanceof HTMLInputElement) languagesEl.value = p.languages || "";
    if (locationEl instanceof HTMLInputElement) locationEl.value = p.location || "";
    if (bioEl instanceof HTMLTextAreaElement) bioEl.value = p.bio;
    if (toysEl instanceof HTMLTextAreaElement) toysEl.value = p.lovenseToys || "";
    renderPlayPrefsChecklists(p);
    setTechniqueChecks(p.techniques);
    updateProfileAvatarPreview();
    renderProfileGallery(p.galleryImages);
  }

  function buildPrefCheckbox(name, id, label, checked) {
    const labelEl = document.createElement("label");
    labelEl.className = "technique-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    input.value = id;
    input.checked = checked;
    const span = document.createElement("span");
    span.textContent = label;
    labelEl.appendChild(input);
    labelEl.appendChild(span);
    return labelEl;
  }

  function renderPlayPrefsChecklists(profile) {
    const PP = global.DualPeerPlayPrefs;
    if (!PP) return;
    const p = normalizeProfile(profile || loadProfile());
    const prefs = p.playPrefs;

    const renderGroup = (rootId, items, groupName, selected) => {
      const root = document.getElementById(rootId);
      if (!root) return;
      root.innerHTML = "";
      items.forEach((item) => {
        root.appendChild(buildPrefCheckbox(groupName, item.id, item.label, selected.includes(item.id)));
      });
    };

    renderGroup("profileDynamicsList", PP.DYNAMICS, "profileDynamics", prefs.dynamics);
    renderGroup("profileKinksList", PP.KINKS, "profileKinks", prefs.kinks);
    renderGroup("profileIntensityList", PP.INTENSITY, "profileIntensity", prefs.intensity);
    renderOwnMenusChecklist();
    attachPlayPrefsChangeListener();
  }

  let prefsListenerBound = false;

  function enabledPresetIds(playPrefs) {
    return global.DualPeerTechniques?.presetIdsForPlayPrefs?.(playPrefs) || new Set();
  }

  function filterTechniquesForPlayPrefs(techniqueIds, playPrefs, profileLike) {
    const allowed = enabledPresetIds(playPrefs);
    const customIds = allCustomTechniqueIds(profileLike);
    const builtIn = builtInTechniqueIds();
    return techniqueIds.filter((id) => customIds.has(id) || !builtIn.has(id) || allowed.has(id));
  }

  function getCheckedOwnMenuIds() {
    const hasInputs = document.querySelector('input[name="profileOwnMenu"]');
    if (!hasInputs) return loadProfile().enabledCustomMenus || [];
    const ids = [];
    document.querySelectorAll('input[name="profileOwnMenu"]:checked').forEach((el) => {
      if (el instanceof HTMLInputElement && el.value) ids.push(el.value);
    });
    return ids;
  }

  function persistProfileDraft(patch) {
    const next = normalizeProfile({ ...loadProfile(), ...patch });
    persistLocal(next);
    if (isAccountMode() && global.DualPeerAuth?.cacheProfile) {
      global.DualPeerAuth.cacheProfile({
        ...(global.DualPeerAuth.getCachedProfile() || {}),
        ...next,
      });
    }
    return next;
  }

  function onPlaybookVisibilityChange() {
    const playPrefs = playPrefsForPlaybook();
    const enabledMenus = getCheckedOwnMenuIds();
    const profile = loadProfile();
    const customIds = allCustomTechniqueIds({
      ...profile,
      enabledCustomMenus: enabledMenus,
    });
    const allowed = enabledPresetIds(playPrefs);
    const checked = getCheckedTechniqueIds().filter(
      (id) => customIds.has(id) || allowed.has(id)
    );
    persistProfileDraft({
      enabledCustomMenus: enabledMenus,
      techniques: filterTechniquesForPlayPrefs(checked, playPrefs, {
        ...profile,
        enabledCustomMenus: enabledMenus,
      }),
    });
    renderTechniqueChecklist({ refreshOwnMenus: false });
    setTechniqueChecks(checked);
  }

  function attachPlayPrefsChangeListener() {
    if (prefsListenerBound) return;
    const form = document.getElementById("profileForm");
    if (!form) return;
    form.addEventListener("change", (e) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      const { name } = e.target;
      if (
        name === "profileDynamics" ||
        name === "profileKinks" ||
        name === "profileIntensity" ||
        name === "profileOwnMenu"
      ) {
        onPlaybookVisibilityChange();
      }
    });
    prefsListenerBound = true;
  }

  function playPrefsForPlaybook() {
    const hasInputs =
      document.querySelectorAll(
        'input[name="profileDynamics"], input[name="profileKinks"], input[name="profileIntensity"]'
      ).length > 0;
    if (hasInputs) return readPlayPrefsFromForm();
    return loadProfile().playPrefs;
  }

  function renderOwnMenusChecklist(selectedIds = null) {
    const root = document.getElementById("profileOwnMenusList");
    if (!root) return;
    const p = loadProfile();
    const selected = new Set(
      selectedIds != null ? selectedIds : p.enabledCustomMenus || []
    );
    root.innerHTML = "";
    if (!p.customMenus.length) {
      const empty = document.createElement("p");
      empty.className = "technique-empty-note";
      empty.textContent = "No own menus yet — create one under Create own menus.";
      root.appendChild(empty);
      return;
    }
    p.customMenus.forEach((menu) => {
      root.appendChild(
        buildPrefCheckbox(
          "profileOwnMenu",
          menu.id,
          menu.title,
          selected.has(menu.id)
        )
      );
    });
  }

  function enabledCustomMenuSections(profile, enabledMenuIds) {
    const enabled = new Set(enabledMenuIds || profile.enabledCustomMenus || []);
    return (profile.customMenus || [])
      .filter((menu) => enabled.has(menu.id) && menu.items?.length)
      .map((menu) => ({
        key: menu.id,
        title: menu.title,
        items: menu.items,
        isCustomMenu: true,
      }));
  }

  function renderTechniqueChecklist({ refreshOwnMenus = true } = {}) {
    const presetRoot = document.getElementById("profileTechniqueList");
    const customRoot = document.getElementById("profileCustomTechniqueList");
    const p = loadProfile();
    if (refreshOwnMenus) {
      renderOwnMenusChecklist(getCheckedOwnMenuIds());
    }
    const enabledMenus = getCheckedOwnMenuIds();
    if (presetRoot) {
      presetRoot.innerHTML = "";
      const sections = [
        ...(global.DualPeerTechniques?.presetSectionsForPlayPrefs?.(playPrefsForPlaybook()) || []),
        ...enabledCustomMenuSections(p, enabledMenus),
      ];
      if (!sections.length) {
        const empty = document.createElement("p");
        empty.className = "technique-empty-note";
        empty.textContent =
          "Select roles, practices, or intensity above — or check an own menu — to add Playbook actions.";
        presetRoot.appendChild(empty);
      }
      sections.forEach((section) => {
        const wrap = document.createElement("div");
        wrap.className = "profile-preset-section";

        const title = document.createElement("p");
        title.className = "profile-preset-section-title";
        title.textContent = section.title;
        wrap.appendChild(title);

        const grid = document.createElement("div");
        grid.className = "profile-technique-grid";
        section.items.forEach((t) => {
          grid.appendChild(
            buildTechniqueCheckbox(
              t.id,
              t.label,
              p.techniques.includes(t.id),
              Boolean(section.isCustomMenu)
            )
          );
        });
        wrap.appendChild(grid);
        presetRoot.appendChild(wrap);
      });
    }
    if (customRoot) {
      customRoot.innerHTML = "";
      if (!p.customTechniques.length) {
        const empty = document.createElement("p");
        empty.className = "technique-empty-note";
        empty.textContent = "No custom actions yet — add one below.";
        customRoot.appendChild(empty);
        return;
      }
      p.customTechniques.forEach((t) => {
        const row = buildTechniqueCheckbox(t.id, t.label, p.techniques.includes(t.id), true);
        customRoot.appendChild(row);
      });
    }
  }

  function buildTechniqueCheckbox(id, label, checked, isCustom, disabled = false) {
    const labelEl = document.createElement("label");
    labelEl.className =
      "technique-check" +
      (isCustom ? " technique-check-custom" : "") +
      (disabled ? " is-disabled" : "");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "profileTechnique";
    input.value = id;
    input.checked = disabled ? false : checked;
    if (disabled) input.disabled = true;
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
    renderCustomMenusEditor();
  }

  function addCustomMenu(title) {
    const trimmed = String(title || "").trim().slice(0, 32);
    if (!trimmed) return { ok: false, error: "Enter a menu name." };
    const profile = loadProfile();
    const duplicate = profile.customMenus.some(
      (m) => m.title.toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) return { ok: false, error: "This menu already exists." };
    const id = makeCustomMenuId(trimmed);
    profile.customMenus.push({ id, title: trimmed, items: [] });
    if (!profile.enabledCustomMenus.includes(id)) profile.enabledCustomMenus.push(id);
    saveProfile(profile);
    renderOwnMenusChecklist(profile.enabledCustomMenus);
    renderTechniqueChecklist({ refreshOwnMenus: false });
    renderCustomMenusEditor();
    return { ok: true };
  }

  function removeCustomMenu(menuId) {
    const profile = loadProfile();
    const menu = profile.customMenus.find((m) => m.id === menuId);
    if (!menu) return;
    const itemIds = new Set((menu.items || []).map((i) => i.id));
    profile.customMenus = profile.customMenus.filter((m) => m.id !== menuId);
    profile.enabledCustomMenus = profile.enabledCustomMenus.filter((id) => id !== menuId);
    profile.techniques = profile.techniques.filter((id) => !itemIds.has(id));
    saveProfile(profile);
    renderOwnMenusChecklist(profile.enabledCustomMenus);
    renderTechniqueChecklist({ refreshOwnMenus: false });
    renderCustomMenusEditor();
  }

  function addCustomMenuItem(menuId, label) {
    const trimmed = String(label || "").trim().slice(0, 48);
    if (!trimmed) return { ok: false, error: "Enter an action name." };
    const profile = loadProfile();
    const menu = profile.customMenus.find((m) => m.id === menuId);
    if (!menu) return { ok: false, error: "Menu not found." };
    const duplicate = (menu.items || []).some(
      (item) => item.label.toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) return { ok: false, error: "This action already exists in the menu." };
    const id = makeCustomTechniqueId(trimmed);
    menu.items.push({ id, label: trimmed });
    if (!profile.techniques.includes(id)) profile.techniques.push(id);
    saveProfile(profile);
    renderTechniqueChecklist();
    renderCustomMenusEditor();
    return { ok: true };
  }

  function removeCustomMenuItem(menuId, itemId) {
    const profile = loadProfile();
    const menu = profile.customMenus.find((m) => m.id === menuId);
    if (!menu) return;
    menu.items = (menu.items || []).filter((item) => item.id !== itemId);
    profile.techniques = profile.techniques.filter((id) => id !== itemId);
    saveProfile(profile);
    renderTechniqueChecklist();
    renderCustomMenusEditor();
  }

  function renderCustomMenusEditor() {
    const root = document.getElementById("profileCustomMenusEditor");
    if (!root) return;
    const p = loadProfile();
    root.innerHTML = "";
    if (!p.customMenus.length) {
      const empty = document.createElement("p");
      empty.className = "technique-empty-note";
      empty.textContent = "No menus yet — enter a name above and click Create menu.";
      root.appendChild(empty);
      return;
    }
    p.customMenus.forEach((menu) => {
      const card = document.createElement("div");
      card.className = "profile-custom-menu-card";

      const head = document.createElement("div");
      head.className = "profile-custom-menu-head";
      const title = document.createElement("strong");
      title.textContent = menu.title;
      const deleteMenuBtn = document.createElement("button");
      deleteMenuBtn.type = "button";
      deleteMenuBtn.className = "technique-remove-btn";
      deleteMenuBtn.textContent = "Delete menu";
      deleteMenuBtn.addEventListener("click", () => removeCustomMenu(menu.id));
      head.appendChild(title);
      head.appendChild(deleteMenuBtn);
      card.appendChild(head);

      const itemsWrap = document.createElement("div");
      itemsWrap.className = "profile-custom-menu-items";
      if (!menu.items?.length) {
        const empty = document.createElement("p");
        empty.className = "technique-empty-note";
        empty.textContent = "No actions in this menu yet.";
        itemsWrap.appendChild(empty);
      } else {
        menu.items.forEach((item) => {
          const row = document.createElement("div");
          row.className = "profile-custom-menu-item";
          const label = document.createElement("span");
          label.textContent = item.label;
          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.className = "technique-remove-btn";
          removeBtn.textContent = "Remove";
          removeBtn.addEventListener("click", () => removeCustomMenuItem(menu.id, item.id));
          row.appendChild(label);
          row.appendChild(removeBtn);
          itemsWrap.appendChild(row);
        });
      }
      card.appendChild(itemsWrap);

      const addRow = document.createElement("div");
      addRow.className = "profile-technique-add row profile-custom-menu-add";
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 48;
      input.placeholder = "Add action to this menu …";
      input.autocomplete = "off";
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "secondary";
      addBtn.textContent = "Add action";
      const runAdd = () => {
        const result = addCustomMenuItem(menu.id, input.value);
        if (result.ok) input.value = "";
      };
      addBtn.addEventListener("click", runAdd);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          runAdd();
        }
      });
      addRow.appendChild(input);
      addRow.appendChild(addBtn);
      card.appendChild(addRow);

      root.appendChild(card);
    });
  }

  function renderPartnerTechniqueButtons() {
    const root = document.getElementById("techniqueRequestList");
    if (!root) return;
    root.innerHTML = "";
    const partner = getPartnerProfile();
    if (!partner) {
      root.innerHTML =
        '<p class="technique-empty-note">Join your partner\'s instant session to see their Playbook here.</p>';
      return;
    }
    const sections = partnerPlaybookSections(partner);
    if (!sections.length) {
      root.innerHTML = `<p class="technique-empty-note">${partner.displayName} has not added anything to their Playbook for this session yet.</p>`;
      return;
    }
    const intro = document.createElement("p");
    intro.className = "status-line technique-request-intro";
    intro.textContent = `${partner.displayName}'s Playbook:`;
    root.appendChild(intro);
    sections.forEach((section) => {
      const wrap = document.createElement("div");
      wrap.className = "technique-request-section";

      const title = document.createElement("p");
      title.className = "technique-request-section-title";
      title.textContent = section.title;
      wrap.appendChild(title);

      const grid = document.createElement("div");
      grid.className = "technique-request-grid";
      section.items.forEach((t) => {
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
      wrap.appendChild(grid);
      root.appendChild(wrap);
    });
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
        detail: { label, fromName, techniqueId: data.techniqueId, ts: data.ts, soundId: data.soundId },
      })
    );
  }

  function handleIncomingProfile(data) {
    if (!data?.profile) return;
    setPartnerProfile(data.profile);
    if (data.profile.chatColors && global.DualPeerChatUi?.setPartnerSharedColors) {
      global.DualPeerChatUi.setPartnerSharedColors(data.profile.chatColors);
    }
    if (data.profile.playModeSound && global.DualPeerPlayModeSounds?.setPartnerSoundId) {
      global.DualPeerPlayModeSounds.setPartnerSoundId(data.profile.playModeSound);
    }
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
    ["profileDynamicsList", "profileKinksList", "profileIntensityList", "profileOwnMenusList"].forEach(
      (id) => {
        document.getElementById(id)?.addEventListener("change", onEdit);
      }
    );
    document.getElementById("btnAddCustomTechnique")?.addEventListener("click", onEdit);
  }

  function enterProfileWorkspace({ onboarding = false } = {}) {
    setPanelTab("profile", { userAction: Boolean(onboarding) });
    const p = loadProfile();
    renderPlayPrefsChecklists(p);
    fillProfileForm(p);
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
        const p = loadProfile();
        renderPlayPrefsChecklists(p);
        fillProfileForm(p);
        renderTechniqueChecklist();
      });
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
    const p = loadProfile();
    renderPlayPrefsChecklists(p);
    fillProfileForm(p);
    renderTechniqueChecklist();
    renderCustomMenusEditor();
    initProfileAvatar();
    initProfileGallery();
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

    const menuBtn = document.getElementById("btnAddCustomMenu");
    const menuInput = document.getElementById("profileCustomMenuInput");
    const runAddMenu = () => {
      const result = addCustomMenu(menuInput?.value || "");
      const msg = document.getElementById("profileSaveStatus");
      if (!result.ok) {
        if (msg) {
          msg.hidden = false;
          msg.textContent = result.error || "Could not create menu.";
          msg.className = "status-line err";
        }
        return;
      }
      if (menuInput instanceof HTMLInputElement) menuInput.value = "";
      if (msg) {
        msg.hidden = false;
        msg.textContent = "Menu created — add actions below and check it under Own menus.";
        msg.className = "status-line ok";
        setTimeout(() => {
          msg.hidden = true;
        }, 2400);
      }
    };
    if (menuBtn) menuBtn.addEventListener("click", runAddMenu);
    if (menuInput) {
      menuInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          runAddMenu();
        }
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
              customMenus: draft.customMenus,
              enabledCustomMenus: draft.enabledCustomMenus,
              playPrefs: draft.playPrefs,
            });
            const saved = persistLocal(profileFromAuth(updated) || draft);
            renderPlayPrefsChecklists(saved);
            fillProfileForm(saved);
            renderTechniqueChecklist();
            renderCustomMenusEditor();
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
          renderPlayPrefsChecklists(saved);
          fillProfileForm(saved);
          renderTechniqueChecklist();
          renderCustomMenusEditor();
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
    const p = loadProfile();
    renderPlayPrefsChecklists(p);
    fillProfileForm(p);
    renderTechniqueChecklist();
    renderCustomMenusEditor();
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
