/**
 * Model booking UI — request → model accepts → guest pays (escrow).
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
        <h2 id="modelBookingModalTitle">Request paid session</h2>
        <p class="status-line" id="modelBookingIntro"></p>
        <form id="modelBookingForm" class="profile-form">
          <div class="row">
            <label for="modelBookingAmount">Proposed session amount (EUR)</label>
            <input type="number" id="modelBookingAmount" min="1" step="0.01" required />
            <p class="status-line profile-field-hint" id="modelBookingRateHint"></p>
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
            <label for="modelBookingNote" id="modelBookingNoteLabel">Message (optional)</label>
            <textarea id="modelBookingNote" rows="3" maxlength="1000" placeholder="What you have in mind for the session…"></textarea>
          </div>
          <p class="status-line err" id="modelBookingError" hidden></p>
          <p class="status-line ok" id="modelBookingSuccess" hidden></p>
          <div class="row profile-mail-actions">
            <button type="submit" class="primary" id="modelBookingSubmitBtn">Send request</button>
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

  let activeTarget = null;
  let activeMode = "guest_to_model";

  function displayName(contact) {
    return contact?.displayName || contact?.username || "Member";
  }

  function fillScheduleDefaults() {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const startEl = document.getElementById("modelBookingStart");
    const endEl = document.getElementById("modelBookingEnd");
    if (startEl) startEl.value = toLocalInput(start);
    if (endEl) endEl.value = toLocalInput(end);
  }

  function open(model) {
    if (!model?.id) return;
    if (!global.DualPeerAuth?.hasPremiumModelAccess?.()) return;

    activeMode = "guest_to_model";
    activeTarget = model;
    const modal = ensureModal();
    const title = document.getElementById("modelBookingModalTitle");
    const intro = document.getElementById("modelBookingIntro");
    const amountEl = document.getElementById("modelBookingAmount");
    const rateHint = document.getElementById("modelBookingRateHint");
    const splitHint = document.getElementById("modelBookingSplitHint");
    const noteLabel = document.getElementById("modelBookingNoteLabel");
    const errEl = document.getElementById("modelBookingError");
    const okEl = document.getElementById("modelBookingSuccess");
    const submitBtn = document.getElementById("modelBookingSubmitBtn");

    if (title) title.textContent = "Request paid session";
    if (submitBtn) submitBtn.textContent = "Send request";
    if (noteLabel) noteLabel.textContent = "Message for model (optional)";
    if (intro) {
      intro.textContent = model.bookingReady
        ? `Propose a paid session with ${displayName(model)}. They review your request first — you only pay after they accept. Funds are held in escrow until the session is completed.`
        : `${displayName(model)} is still setting up payouts — you can send a request, but payment will be available once Connect onboarding is complete.`;
    }
    if (amountEl) {
      amountEl.value = model.hourlyRateMinor ? minorToEur(model.hourlyRateMinor) : "50.00";
    }
    if (rateHint) {
      rateHint.textContent = model.hourlyRateMinor
        ? `Model rate: ${minorToEur(model.hourlyRateMinor)} € / hour (suggested — you can adjust).`
        : "No published hourly rate yet — propose an amount that fits your session.";
    }
    if (splitHint) {
      const share = model.platformSharePercent ?? 40;
      splitHint.textContent = `Platform fee ${share}% · Model receives ${100 - share}% after session completion.`;
    }
    if (errEl) errEl.hidden = true;
    if (okEl) okEl.hidden = true;
    fillScheduleDefaults();

    modal.hidden = false;
    global.dualPeerUi?.openAuthModal?.("modelBookingModal");
  }

  function openForGuest(guest) {
    if (!guest?.id) return;
    if (!global.DualPeerAuth?.getSession?.()?.user?.isModel) return;

    activeMode = "model_to_guest";
    activeTarget = guest;
    const modal = ensureModal();
    const title = document.getElementById("modelBookingModalTitle");
    const intro = document.getElementById("modelBookingIntro");
    const amountEl = document.getElementById("modelBookingAmount");
    const rateHint = document.getElementById("modelBookingRateHint");
    const splitHint = document.getElementById("modelBookingSplitHint");
    const noteLabel = document.getElementById("modelBookingNoteLabel");
    const errEl = document.getElementById("modelBookingError");
    const okEl = document.getElementById("modelBookingSuccess");
    const submitBtn = document.getElementById("modelBookingSubmitBtn");

    if (title) title.textContent = "Send session offer";
    if (submitBtn) submitBtn.textContent = "Send offer";
    if (noteLabel) noteLabel.textContent = "Message for member (optional)";
    if (intro) {
      intro.textContent = `Propose a paid session with ${displayName(guest)}. They can pay into escrow once they accept your offer.`;
    }
    if (amountEl) amountEl.value = "50.00";
    if (rateHint) rateHint.textContent = "Propose an amount for this session.";
    if (splitHint) splitHint.textContent = "Platform fee applies per your model account settings.";
    if (errEl) errEl.hidden = true;
    if (okEl) okEl.hidden = true;
    fillScheduleDefaults();

    modal.hidden = false;
    global.dualPeerUi?.openAuthModal?.("modelBookingModal");
  }

  function close() {
    const modal = document.getElementById("modelBookingModal");
    if (modal) modal.hidden = true;
    activeTarget = null;
    activeMode = "guest_to_model";
  }

  function toLocalInput(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function notifyBookingsChanged() {
    global.dispatchEvent(new CustomEvent("dualpeer:bookings-changed"));
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!activeTarget) return;
    const errEl = document.getElementById("modelBookingError");
    const okEl = document.getElementById("modelBookingSuccess");
    const submitBtn = document.getElementById("modelBookingSubmitBtn");
    if (errEl) errEl.hidden = true;
    if (okEl) okEl.hidden = true;

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
      const payload =
        activeMode === "model_to_guest"
          ? {
              guestUserId: activeTarget.id,
              scheduledStartAt,
              scheduledEndAt,
              currency: "EUR",
              totalAmountMinor,
              modelNote: note,
            }
          : {
              modelUserId: activeTarget.id,
              scheduledStartAt,
              scheduledEndAt,
              currency: "EUR",
              totalAmountMinor,
              guestNote: note,
            };
      const created = await global.DualPeerAuth.bookModel(payload);
      if (!created?.booking?.id) throw new Error("Request could not be sent.");

      if (okEl) {
        okEl.hidden = false;
        okEl.textContent =
          activeMode === "model_to_guest"
            ? "Session offer sent. The member can pay once they review it in Session bookings."
            : "Request sent. Check Session bookings below — you can pay once the model accepts.";
      }
      notifyBookingsChanged();
      setTimeout(close, 1800);
    } catch (err) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = err.message || "Request failed.";
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  global.DualPeerModelBooking = { open, openForGuest, close };
})(window);
