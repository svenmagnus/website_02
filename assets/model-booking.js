/**
 * Premium Partner booking UI — visible to Premium guests booking is_model partners.
 */
(function (global) {
  function minorToEur(minor) {
    return (Number(minor || 0) / 100).toFixed(2);
  }

  function ensureModal() {
    let modal = document.getElementById("modelBookingModal");
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = "modelBookingModal";
    modal.className = "login-overlay";
    modal.hidden = true;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "modelBookingModalTitle");
    modal.innerHTML = `
      <div class="login-overlay-card auth-card-wide model-booking-card">
        <h2 id="modelBookingModalTitle">Book Premium Partner</h2>
        <p class="status-line" id="modelBookingIntro"></p>
        <form id="modelBookingForm" class="profile-form">
          <div class="row">
            <label for="modelBookingAmount">Session amount (EUR)</label>
            <input type="number" id="modelBookingAmount" min="1" step="0.01" required />
            <p class="status-line profile-field-hint" id="modelBookingSplitHint"></p>
          </div>
          <div class="row">
            <label for="modelBookingStart">Start</label>
            <input type="datetime-local" id="modelBookingStart" required />
          </div>
          <div class="row">
            <label for="modelBookingEnd">End</label>
            <input type="datetime-local" id="modelBookingEnd" required />
          </div>
          <div class="row">
            <label for="modelBookingNote">Note for partner (optional)</label>
            <textarea id="modelBookingNote" rows="3" maxlength="1000"></textarea>
          </div>
          <p class="status-line err" id="modelBookingError" hidden></p>
          <div class="row profile-mail-actions">
            <button type="submit" class="primary" id="modelBookingSubmitBtn">Create booking &amp; pay</button>
            <button type="button" class="secondary" id="modelBookingCancelBtn">Cancel</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) close();
    });
    document.getElementById("modelBookingCancelBtn")?.addEventListener("click", close);
    document.getElementById("modelBookingForm")?.addEventListener("submit", onSubmit);

    return modal;
  }

  let activeModel = null;

  function open(model) {
    if (!model?.id) return;
    if (!global.DualPeerAuth?.hasPremiumModelAccess?.()) return;

    activeModel = model;
    const modal = ensureModal();
    const intro = document.getElementById("modelBookingIntro");
    const amountEl = document.getElementById("modelBookingAmount");
    const splitHint = document.getElementById("modelBookingSplitHint");
    const errEl = document.getElementById("modelBookingError");

    if (intro) {
      intro.textContent = model.bookingReady
        ? `Book a paid session with ${model.displayName || model.username}. Funds are held in escrow until the session is completed.`
        : `${model.displayName || model.username} is still setting up payouts — booking may be unavailable until Connect onboarding is complete.`;
    }
    if (amountEl) {
      amountEl.value = model.hourlyRateMinor ? minorToEur(model.hourlyRateMinor) : "50.00";
    }
    if (splitHint) {
      const share = model.platformSharePercent ?? 40;
      splitHint.textContent = `Platform fee ${share}% · Model receives ${100 - share}% after session completion.`;
    }
    if (errEl) errEl.hidden = true;

    const start = new Date(Date.now() + 60 * 60 * 1000);
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const startEl = document.getElementById("modelBookingStart");
    const endEl = document.getElementById("modelBookingEnd");
    if (startEl) startEl.value = toLocalInput(start);
    if (endEl) endEl.value = toLocalInput(end);

    modal.hidden = false;
    global.dualPeerUi?.openAuthModal?.("modelBookingModal");
  }

  function close() {
    const modal = document.getElementById("modelBookingModal");
    if (modal) modal.hidden = true;
    activeModel = null;
  }

  function toLocalInput(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!activeModel) return;
    const errEl = document.getElementById("modelBookingError");
    const submitBtn = document.getElementById("modelBookingSubmitBtn");
    if (errEl) errEl.hidden = true;

    const amountEur = Number(document.getElementById("modelBookingAmount")?.value);
    const startVal = document.getElementById("modelBookingStart")?.value;
    const endVal = document.getElementById("modelBookingEnd")?.value;
    const note = document.getElementById("modelBookingNote")?.value?.trim() || "";

    if (!Number.isFinite(amountEur) || amountEur < 1) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = "Enter a valid amount (min. 1.00 €).";
      }
      return;
    }

    const scheduledStartAt = startVal ? new Date(startVal).getTime() : NaN;
    const scheduledEndAt = endVal ? new Date(endVal).getTime() : NaN;
    if (!Number.isFinite(scheduledStartAt) || !Number.isFinite(scheduledEndAt)) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = "Choose a valid start and end time.";
      }
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    try {
      const totalAmountMinor = Math.round(amountEur * 100);
      const created = await global.DualPeerAuth.bookModel({
        modelUserId: activeModel.id,
        scheduledStartAt,
        scheduledEndAt,
        currency: "EUR",
        totalAmountMinor,
        guestNote: note,
      });
      const bookingId = created?.booking?.id;
      if (!bookingId) throw new Error("Booking could not be created.");

      const checkout = await global.DualPeerAuth.fundModelBooking(bookingId);
      if (checkout?.url) {
        window.location.href = checkout.url;
        return;
      }
      throw new Error("Checkout URL missing.");
    } catch (err) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = err.message || "Booking failed.";
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  global.DualPeerModelBooking = { open, close };
})(window);
