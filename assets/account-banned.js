(function () {
  const reasonEl = document.getElementById("accountBannedReason");

  function showReason(text) {
    const msg = String(text || "").trim();
    if (!reasonEl || !msg) return;
    reasonEl.hidden = false;
    reasonEl.textContent = msg;
  }

  function initFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get("reason");
    if (reason) showReason(decodeURIComponent(reason));
  }

  async function initFromSession() {
    if (!globalThis.DualPeerAuth?.isLoggedIn?.()) return;
    try {
      const profile = await globalThis.DualPeerAuth.fetchProfile();
      if (profile?.isBanned) {
        if (profile.banReason) showReason(profile.banReason);
        return;
      }
    } catch (err) {
      if (err?.code === "account_banned") {
        if (err.data?.banReason) showReason(err.data.banReason);
      }
    }
  }

  document.getElementById("btnBannedLogout")?.addEventListener("click", async () => {
    try {
      if (globalThis.DualPeerAuth?.logout) await globalThis.DualPeerAuth.logout();
    } catch (_) {
      /* ignore */
    }
    window.location.href = "index.html";
  });

  initFromQuery();
  if (globalThis.DualPeerAuth?.onReady) {
    globalThis.DualPeerAuth.onReady(() => {
      initFromSession().catch(() => {});
    });
  } else {
    initFromSession().catch(() => {});
  }
})();
