import { Router } from "express";
import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { getAppPublicUrl } from "./mail.js";
import {
  assertSubscriptionAccess,
  getOrCreateStripeCustomer,
  getStripe,
  hasPremiumModelPoolAccess,
  isStripeConfigured,
} from "./billing.js";
import {
  assertModelBookable,
  assertModelPayoutReady,
  calculateBookingSplit,
  ensurePremiumPartnerRow,
  getBookingById,
  getPremiumPartnerRow,
  isConnectConfigured,
  mapBookingRow,
  markBookingFunded,
  refreshConnectAccountStatus,
  releaseBookingPayout,
} from "./connect-booking.js";

function parseBearer(req) {
  const raw = String(req.get("authorization") || "").trim();
  if (!/^Bearer\s+/i.test(raw)) return null;
  return raw.replace(/^Bearer\s+/i, "").trim();
}

function getUserByToken(token) {
  if (!token) return null;
  const db = getDb();
  const session = db
    .prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
    .get(token);
  if (!session || session.expires_at < Date.now()) {
    if (session) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) || null;
}

function requireAuth(req, res, next) {
  const user = getUserByToken(parseBearer(req));
  if (!user) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  req.authUser = user;
  next();
}

function normalizeCurrency(value) {
  const code = String(value || "EUR").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function normalizeAmountMinor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

function nowMs() {
  return Date.now();
}

export const connectRouter = Router();

/** Model: Stripe Connect Express onboarding status */
connectRouter.get("/connect/status", requireAuth, async (req, res) => {
  const user = req.authUser;
  if (!user.is_model) {
    return res.status(403).json({ ok: false, error: "model_only" });
  }
  const db = getDb();
  ensurePremiumPartnerRow(db, user.id);
  let partner = getPremiumPartnerRow(db, user.id);
  if (partner?.stripe_connect_account_id && isConnectConfigured()) {
    try {
      partner = await refreshConnectAccountStatus(db, partner);
    } catch (err) {
      console.warn("[connect] status refresh failed:", err.message);
    }
  }
  return res.json({
    ok: true,
    configured: isConnectConfigured(),
    partner: {
      userId: partner.user_id,
      platformSharePercent: partner.platform_share_percent,
      hourlyRateMinor: partner.hourly_rate_minor,
      stripeConnectAccountId: partner.stripe_connect_account_id,
      connectOnboardingComplete: Boolean(partner.connect_onboarding_complete),
      payoutsEnabled: Boolean(partner.payouts_enabled),
      bookingReady: Boolean(
        partner.stripe_connect_account_id &&
          partner.connect_onboarding_complete &&
          partner.payouts_enabled
      ),
    },
  });
});

/** Model: start or continue Stripe Connect Express onboarding */
connectRouter.post("/connect/onboard", requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ ok: false, error: "stripe_not_configured" });
  }
  const user = req.authUser;
  if (!user.is_model) {
    return res.status(403).json({ ok: false, error: "model_only" });
  }
  const db = getDb();
  ensurePremiumPartnerRow(db, user.id);
  let partner = getPremiumPartnerRow(db, user.id);
  const appUrl = getAppPublicUrl();
  const now = nowMs();

  let accountId = partner.stripe_connect_account_id;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "express",
      country: "DE",
      email: user.email || undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: "individual",
      metadata: { userId: user.id, username: user.username || "" },
    });
    accountId = account.id;
    db.prepare(
      `UPDATE premium_partners SET stripe_connect_account_id = ?, updated_at = ? WHERE user_id = ?`
    ).run(accountId, now, user.id);
    partner = getPremiumPartnerRow(db, user.id);
  }

  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${appUrl}/partner-creator.html?connect=refresh`,
    return_url: `${appUrl}/partner-creator.html?connect=done`,
    type: "account_onboarding",
  });

  return res.json({ ok: true, url: accountLink.url, accountId });
});

/** Guest or model: create booking request with server-side fee split */
connectRouter.post("/book-model", requireAuth, async (req, res) => {
  const db = getDb();
  const authUser = req.authUser;
  const scheduledStartAt = Number(req.body?.scheduledStartAt);
  const scheduledEndAt = Number(req.body?.scheduledEndAt);
  const currency = normalizeCurrency(req.body?.currency || "EUR");
  const totalAmountMinor = normalizeAmountMinor(req.body?.totalAmountMinor);

  if (!Number.isFinite(scheduledStartAt) || !Number.isFinite(scheduledEndAt)) {
    return res.status(400).json({ ok: false, error: "invalid_schedule" });
  }
  if (scheduledEndAt <= scheduledStartAt) {
    return res.status(400).json({ ok: false, error: "invalid_schedule_range" });
  }
  if (!currency || totalAmountMinor == null || totalAmountMinor < 100) {
    return res.status(400).json({ ok: false, error: "invalid_amount" });
  }

  let guestUserId;
  let modelUserId;
  let guestNote = "";
  let modelNote = "";
  let initialStatus = "pending";
  let responseMessage = "Session request sent. The model will confirm before you pay.";

  if (authUser.is_model) {
    guestUserId = String(req.body?.guestUserId || "").trim();
    modelUserId = authUser.id;
    modelNote = String(req.body?.modelNote || "").trim().slice(0, 1000);
    initialStatus = "accepted";
    responseMessage = "Session offer sent. The member can pay into escrow from Session bookings.";
    if (!guestUserId || guestUserId === modelUserId) {
      return res.status(400).json({ ok: false, error: "invalid_guest_user" });
    }
    const guest = db.prepare("SELECT id, is_model FROM users WHERE id = ?").get(guestUserId);
    if (!guest) {
      return res.status(404).json({ ok: false, error: "guest_not_found" });
    }
    if (guest.is_model) {
      return res.status(400).json({ ok: false, error: "invalid_guest_user" });
    }
  } else {
    try {
      assertSubscriptionAccess(authUser);
    } catch (err) {
      if (err.code === "subscription_required") {
        return res.status(402).json({ ok: false, error: err.code, subscription: err.subscription });
      }
      throw err;
    }
    if (!hasPremiumModelPoolAccess(authUser)) {
      return res.status(403).json({
        ok: false,
        error: "premium_required",
        message: "Premium membership is required to book models.",
      });
    }

    guestUserId = authUser.id;
    modelUserId = String(req.body?.modelUserId || "").trim();
    guestNote = String(req.body?.guestNote || "").trim().slice(0, 1000);
    if (!modelUserId || modelUserId === guestUserId) {
      return res.status(400).json({ ok: false, error: "invalid_model_user" });
    }
  }

  let modelInfo;
  try {
    modelInfo = assertModelBookable(db, modelUserId);
  } catch (err) {
    return res.status(404).json({ ok: false, error: err.code || "model_not_found" });
  }

  const { platformFeeMinor, modelPayoutMinor, platformSharePercent } = calculateBookingSplit(
    totalAmountMinor,
    modelInfo.partner.platform_share_percent
  );

  const bookingId = randomUUID();
  const now = nowMs();
  db.prepare(
    `INSERT INTO bookings (
      id, guest_user_id, model_user_id, status, currency,
      total_amount_minor, platform_fee_minor, model_payout_minor,
      escrow_status, escrow_reference,
      scheduled_start_at, scheduled_end_at, started_at, ended_at,
      guest_note, model_note, cancel_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    bookingId,
    guestUserId,
    modelUserId,
    initialStatus,
    currency,
    totalAmountMinor,
    platformFeeMinor,
    modelPayoutMinor,
    "not_funded",
    null,
    Math.trunc(scheduledStartAt),
    Math.trunc(scheduledEndAt),
    null,
    null,
    guestNote,
    modelNote,
    "",
    now,
    now
  );

  const booking = getBookingById(db, bookingId);
  return res.status(201).json({
    ok: true,
    message: responseMessage,
    booking: {
      ...booking,
      modelName: modelInfo.model.display_name || modelInfo.model.username || "Model",
      platformSharePercent,
    },
  });
});

/** Guest: Stripe Checkout to fund booking escrow (platform holds funds until session complete) */
connectRouter.post("/bookings/:bookingId/checkout", requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ ok: false, error: "stripe_not_configured" });
  }
  const db = getDb();
  const bookingId = String(req.params.bookingId || "").trim();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
  if (!booking) {
    return res.status(404).json({ ok: false, error: "booking_not_found" });
  }
  if (booking.guest_user_id !== req.authUser.id) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  if (booking.escrow_status !== "not_funded") {
    return res.status(400).json({ ok: false, error: "escrow_already_funded" });
  }
  if (booking.status !== "accepted") {
    return res.status(400).json({
      ok: false,
      error: "booking_not_accepted",
      message: "The model must accept your request before payment.",
    });
  }

  let partner;
  try {
    const info = assertModelBookable(db, booking.model_user_id);
    partner = info.partner;
    assertModelPayoutReady(partner);
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.code || "model_not_ready",
      message: "This model has not completed payout setup yet.",
    });
  }

  const model = db.prepare("SELECT display_name, username FROM users WHERE id = ?").get(booking.model_user_id);
  const modelName = model?.display_name || model?.username || "Model";
  const appUrl = getAppPublicUrl();
  const customerId = await getOrCreateStripeCustomer(db, req.authUser);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    client_reference_id: req.authUser.id,
    line_items: [
      {
        price_data: {
          currency: String(booking.currency || "EUR").toLowerCase(),
          unit_amount: booking.total_amount_minor,
          product_data: {
            name: `Session with ${modelName}`,
            description: `Tangent Club model booking (escrow)`,
          },
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      metadata: {
        bookingId,
        type: "model_booking",
        modelUserId: booking.model_user_id,
        platformFeeMinor: String(booking.platform_fee_minor),
        modelPayoutMinor: String(booking.model_payout_minor),
      },
    },
    metadata: {
      bookingId,
      type: "model_booking",
      userId: req.authUser.id,
      modelUserId: booking.model_user_id,
    },
    success_url: `${appUrl}/index.html?booking=success&id=${encodeURIComponent(bookingId)}`,
    cancel_url: `${appUrl}/index.html?booking=cancel&id=${encodeURIComponent(bookingId)}`,
  });

  return res.json({ ok: true, url: session.url, bookingId });
});

/** Model accepts a pending session request (guest pays after acceptance) */
connectRouter.post("/bookings/:bookingId/accept", requireAuth, (req, res) => {
  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.bookingId);
  if (!booking) return res.status(404).json({ ok: false, error: "booking_not_found" });
  if (booking.model_user_id !== req.authUser.id) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  if (booking.status !== "pending") {
    return res.status(400).json({ ok: false, error: "invalid_status" });
  }
  const now = nowMs();
  db.prepare(`UPDATE bookings SET status = 'accepted', updated_at = ? WHERE id = ?`).run(now, booking.id);
  return res.json({ ok: true, booking: getBookingById(db, booking.id) });
});

/** Model declines a pending session request */
connectRouter.post("/bookings/:bookingId/reject", requireAuth, (req, res) => {
  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.bookingId);
  if (!booking) return res.status(404).json({ ok: false, error: "booking_not_found" });
  if (booking.model_user_id !== req.authUser.id) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  if (booking.status !== "pending") {
    return res.status(400).json({ ok: false, error: "invalid_status" });
  }
  if (booking.escrow_status !== "not_funded") {
    return res.status(400).json({ ok: false, error: "already_funded" });
  }
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  const now = nowMs();
  db.prepare(
    `UPDATE bookings SET status = 'rejected', cancel_reason = ?, updated_at = ? WHERE id = ?`
  ).run(reason, now, booking.id);
  return res.json({ ok: true, booking: getBookingById(db, booking.id) });
});

/** Guest or model: cancel an unfunded request or offer */
connectRouter.post("/bookings/:bookingId/cancel", requireAuth, (req, res) => {
  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.bookingId);
  if (!booking) return res.status(404).json({ ok: false, error: "booking_not_found" });
  const userId = req.authUser.id;
  const isGuest = booking.guest_user_id === userId;
  const isModel = booking.model_user_id === userId;
  if (!isGuest && !isModel) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  if (!["pending", "accepted"].includes(booking.status)) {
    return res.status(400).json({ ok: false, error: "invalid_status" });
  }
  if (booking.escrow_status !== "not_funded") {
    return res.status(400).json({ ok: false, error: "already_funded" });
  }
  if (booking.status === "pending" && isModel) {
    return res.status(400).json({ ok: false, error: "use_decline" });
  }
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  const now = nowMs();
  db.prepare(
    `UPDATE bookings SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?`
  ).run(reason, now, booking.id);
  return res.json({ ok: true, booking: getBookingById(db, booking.id) });
});

/** Mark session complete and release model payout via Stripe Transfer */
connectRouter.post("/bookings/:bookingId/complete", requireAuth, async (req, res) => {
  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.bookingId);
  if (!booking) return res.status(404).json({ ok: false, error: "booking_not_found" });
  const userId = req.authUser.id;
  if (booking.guest_user_id !== userId && booking.model_user_id !== userId) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  if (!["accepted", "in_progress"].includes(booking.status)) {
    return res.status(400).json({ ok: false, error: "invalid_status" });
  }
  const now = nowMs();
  db.prepare(
    `UPDATE bookings SET status = 'completed', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?`
  ).run(now, now, booking.id);

  try {
    const result = await releaseBookingPayout(db, booking.id);
    return res.json({ ok: true, booking: result.booking, transferId: result.transferId });
  } catch (err) {
    console.error("[connect] payout release failed:", err);
    return res.status(400).json({
      ok: false,
      error: err.code || "payout_failed",
      message: err.message,
      booking: getBookingById(db, booking.id),
    });
  }
});

/** List bookings for guest or model */
connectRouter.get("/bookings/mine", requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.authUser.id;
  const rows = db
    .prepare(
      `SELECT b.*, g.display_name AS guest_name, g.username AS guest_username,
              m.display_name AS model_name, m.username AS model_username
       FROM bookings b
       INNER JOIN users g ON g.id = b.guest_user_id
       INNER JOIN users m ON m.id = b.model_user_id
       WHERE (b.guest_user_id = ? OR b.model_user_id = ?)
         AND b.status NOT IN ('cancelled', 'rejected')
       ORDER BY b.scheduled_start_at DESC
       LIMIT 50`
    )
    .all(userId, userId);

  return res.json({
    ok: true,
    bookings: rows.map((row) => ({
      ...mapBookingRow(row),
      guestName: row.guest_name || row.guest_username,
      modelName: row.model_name || row.model_username,
      role: row.guest_user_id === userId ? "guest" : "model",
    })),
  });
});

export async function handleConnectBookingCheckout(session) {
  if (session.metadata?.type !== "model_booking") return false;
  const bookingId = session.metadata?.bookingId;
  if (!bookingId || session.payment_status !== "paid") return false;
  const db = getDb();
  const paymentRef = session.payment_intent ? String(session.payment_intent) : String(session.id);
  markBookingFunded(db, bookingId, paymentRef);
  console.log(`[connect] booking funded bookingId=${bookingId} ref=${paymentRef}`);
  return true;
}
