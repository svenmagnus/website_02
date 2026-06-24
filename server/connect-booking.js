import { getDb } from "./db.js";
import { getStripe } from "./billing.js";

const DEFAULT_PLATFORM_SHARE_PERCENT = 40;

export function isConnectConfigured() {
  return Boolean(String(process.env.STRIPE_SECRET_KEY || "").trim());
}

export function getPremiumPartnerRow(db, userId) {
  return (
    db
      .prepare(
        `SELECT pp.*, u.username, u.display_name, u.is_model, u.is_premium
         FROM premium_partners pp
         INNER JOIN users u ON u.id = pp.user_id
         WHERE pp.user_id = ?`
      )
      .get(userId) || null
  );
}

export function ensurePremiumPartnerRow(db, userId) {
  const existing = db.prepare("SELECT user_id FROM premium_partners WHERE user_id = ?").get(userId);
  if (existing) return;
  const now = Date.now();
  db.prepare(
    `INSERT INTO premium_partners (
      user_id, platform_share_percent, hourly_rate_minor,
      stripe_connect_account_id, connect_onboarding_complete, payouts_enabled,
      created_at, updated_at
    ) VALUES (?, ?, NULL, NULL, 0, 0, ?, ?)`
  ).run(userId, DEFAULT_PLATFORM_SHARE_PERCENT, now, now);
}

export function calculateBookingSplit(totalAmountMinor, platformSharePercent = DEFAULT_PLATFORM_SHARE_PERCENT) {
  const total = Math.max(0, Math.trunc(totalAmountMinor));
  const share = Math.min(100, Math.max(0, Math.trunc(platformSharePercent)));
  const platformFeeMinor = Math.round((total * share) / 100);
  const modelPayoutMinor = total - platformFeeMinor;
  return { platformFeeMinor, modelPayoutMinor, platformSharePercent: share };
}

export function mapBookingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    guestUserId: row.guest_user_id,
    modelUserId: row.model_user_id,
    status: row.status,
    currency: row.currency,
    totalAmountMinor: row.total_amount_minor,
    platformFeeMinor: row.platform_fee_minor,
    modelPayoutMinor: row.model_payout_minor,
    escrowStatus: row.escrow_status,
    escrowReference: row.escrow_reference || null,
    scheduledStartAt: row.scheduled_start_at,
    scheduledEndAt: row.scheduled_end_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    guestNote: row.guest_note || "",
    modelNote: row.model_note || "",
    cancelReason: row.cancel_reason || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getBookingById(db, bookingId) {
  const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
  return mapBookingRow(row);
}

export function assertModelBookable(db, modelUserId) {
  const model = db
    .prepare("SELECT id, username, display_name, is_model, is_premium FROM users WHERE id = ?")
    .get(modelUserId);
  if (!model) {
    const err = new Error("model_not_found");
    err.code = "model_not_found";
    throw err;
  }
  if (!model.is_model) {
    const err = new Error("model_not_premium_partner");
    err.code = "model_not_premium_partner";
    throw err;
  }
  ensurePremiumPartnerRow(db, modelUserId);
  const partner = getPremiumPartnerRow(db, modelUserId);
  return { model, partner };
}

export function assertModelPayoutReady(partner) {
  if (!partner?.stripe_connect_account_id) {
    const err = new Error("model_connect_missing");
    err.code = "model_connect_missing";
    throw err;
  }
  if (!partner.connect_onboarding_complete || !partner.payouts_enabled) {
    const err = new Error("model_connect_incomplete");
    err.code = "model_connect_incomplete";
    throw err;
  }
}

export async function refreshConnectAccountStatus(db, partnerRow) {
  const stripe = getStripe();
  if (!stripe || !partnerRow?.stripe_connect_account_id) return partnerRow;
  const account = await stripe.accounts.retrieve(partnerRow.stripe_connect_account_id);
  const payoutsEnabled = Boolean(account.payouts_enabled);
  const chargesEnabled = Boolean(account.charges_enabled);
  const complete = payoutsEnabled && chargesEnabled;
  const now = Date.now();
  db.prepare(
    `UPDATE premium_partners
     SET connect_onboarding_complete = ?, payouts_enabled = ?, updated_at = ?
     WHERE user_id = ?`
  ).run(complete ? 1 : 0, payoutsEnabled ? 1 : 0, now, partnerRow.user_id);
  return getPremiumPartnerRow(db, partnerRow.user_id);
}

export async function releaseBookingPayout(db, bookingId) {
  const stripe = getStripe();
  if (!stripe) {
    const err = new Error("stripe_not_configured");
    err.code = "stripe_not_configured";
    throw err;
  }
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
  if (!booking) {
    const err = new Error("booking_not_found");
    err.code = "booking_not_found";
    throw err;
  }
  if (booking.escrow_status !== "funded") {
    const err = new Error("escrow_not_funded");
    err.code = "escrow_not_funded";
    throw err;
  }
  if (booking.status !== "completed") {
    const err = new Error("booking_not_completed");
    err.code = "booking_not_completed";
    throw err;
  }

  const partner = getPremiumPartnerRow(db, booking.model_user_id);
  assertModelPayoutReady(partner);

  const transfer = await stripe.transfers.create({
    amount: booking.model_payout_minor,
    currency: String(booking.currency || "eur").toLowerCase(),
    destination: partner.stripe_connect_account_id,
    metadata: { bookingId: booking.id, type: "model_payout" },
  });

  const now = Date.now();
  db.prepare(
    `UPDATE bookings SET escrow_status = 'released', escrow_reference = ?, updated_at = ? WHERE id = ?`
  ).run(transfer.id, now, bookingId);

  return { transferId: transfer.id, booking: getBookingById(db, bookingId) };
}

export function markBookingFunded(db, bookingId, paymentReference) {
  const now = Date.now();
  db.prepare(
    `UPDATE bookings SET escrow_status = 'funded', escrow_reference = ?, updated_at = ? WHERE id = ? AND escrow_status = 'not_funded'`
  ).run(paymentReference, now, bookingId);
  return getBookingById(db, bookingId);
}
