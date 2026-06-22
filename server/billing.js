import Stripe from "stripe";
import { getDb } from "./db.js";

export const TRIAL_DAYS = Math.max(1, Number(process.env.SUBSCRIPTION_TRIAL_DAYS || 30));
export const SUBSCRIPTION_PRICE_EUR = "2.95";

export function stripeBrandName() {
  return String(process.env.STRIPE_BRAND_NAME || process.env.MAIL_SITE_NAME || "Tangent Club").trim();
}

let stripeClient;
let brandingSyncPromise = null;

export function isStripeConfigured() {
  return Boolean(String(process.env.STRIPE_SECRET_KEY || "").trim() && String(process.env.STRIPE_PRICE_ID || "").trim());
}

export function isSubscriptionEnforced() {
  return isStripeConfigured();
}

export function getStripe() {
  if (!isStripeConfigured()) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(String(process.env.STRIPE_SECRET_KEY).trim());
  }
  return stripeClient;
}

function isAdminUser(row) {
  return Boolean(row?.is_admin);
}

function isPremiumPartner(row) {
  return Boolean(row?.is_premium) && Boolean(row?.is_model);
}

export function isSubscriptionExempt(user) {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  if (isPremiumPartner(user)) return true;
  return false;
}

export function getSubscriptionRow(db, userId) {
  return db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId) || null;
}

export function computeLocalTrialEndsAt(user, subRow) {
  if (subRow?.trial_ends_at) return subRow.trial_ends_at;
  const createdAt = Number(user?.created_at) || Date.now();
  return createdAt + TRIAL_DAYS * 24 * 60 * 60 * 1000;
}

function daysRemaining(untilMs) {
  const diff = untilMs - Date.now();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

const ACTIVE_STRIPE_STATUSES = new Set(["active", "trialing"]);

export function resolveSubscriptionAccess(user, subRow = null) {
  const db = getDb();
  const row = subRow ?? getSubscriptionRow(db, user.id);
  const trialEndsAt = computeLocalTrialEndsAt(user, row);
  const base = {
    enforced: isSubscriptionEnforced(),
    exempt: isSubscriptionExempt(user),
    priceEur: SUBSCRIPTION_PRICE_EUR,
    trialDays: TRIAL_DAYS,
    trialEndsAt,
    daysRemaining: daysRemaining(trialEndsAt),
    status: row?.status || "none",
    stripeCustomerId: row?.stripe_customer_id || null,
    currentPeriodEnd: row?.current_period_end || null,
    cancelAtPeriodEnd: Boolean(row?.cancel_at_period_end),
  };

  if (!base.enforced) {
    return {
      ...base,
      accessGranted: true,
      requiresPayment: false,
      phase: "not_required",
    };
  }

  if (base.exempt) {
    return {
      ...base,
      accessGranted: true,
      requiresPayment: false,
      phase: "exempt",
    };
  }

  const stripeStatus = String(row?.status || "none");
  if (ACTIVE_STRIPE_STATUSES.has(stripeStatus)) {
    if (stripeStatus === "trialing" && row?.trial_ends_at && row.trial_ends_at < Date.now()) {
      /* fall through */
    } else {
      return {
        ...base,
        accessGranted: true,
        requiresPayment: false,
        phase: stripeStatus,
        daysRemaining: row?.trial_ends_at ? daysRemaining(row.trial_ends_at) : 0,
      };
    }
  }

  if (Date.now() < trialEndsAt) {
    return {
      ...base,
      accessGranted: true,
      requiresPayment: false,
      phase: "trial",
      daysRemaining: daysRemaining(trialEndsAt),
    };
  }

  return {
    ...base,
    accessGranted: false,
    requiresPayment: true,
    phase: stripeStatus === "none" ? "trial_expired" : stripeStatus,
    daysRemaining: 0,
  };
}

export function subscriptionFieldsForProfile(user) {
  const access = resolveSubscriptionAccess(user);
  return {
    subscription: {
      enforced: access.enforced,
      accessGranted: access.accessGranted,
      requiresPayment: access.requiresPayment,
      exempt: access.exempt,
      phase: access.phase,
      status: access.status,
      priceEur: access.priceEur,
      trialDays: access.trialDays,
      trialEndsAt: access.trialEndsAt,
      daysRemaining: access.daysRemaining,
      currentPeriodEnd: access.currentPeriodEnd,
      cancelAtPeriodEnd: access.cancelAtPeriodEnd,
    },
  };
}

export function assertSubscriptionAccess(user) {
  const access = resolveSubscriptionAccess(user);
  if (!access.accessGranted) {
    const err = new Error("subscription_required");
    err.code = "subscription_required";
    err.subscription = access;
    throw err;
  }
  return access;
}

export function upsertSubscriptionRow(db, userId, fields) {
  const now = Date.now();
  const existing = getSubscriptionRow(db, userId);
  if (!existing) {
    db.prepare(
      `INSERT INTO subscriptions (
        user_id, stripe_customer_id, stripe_subscription_id, status,
        trial_ends_at, current_period_end, cancel_at_period_end, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      fields.stripe_customer_id || null,
      fields.stripe_subscription_id || null,
      fields.status || "none",
      fields.trial_ends_at ?? null,
      fields.current_period_end ?? null,
      fields.cancel_at_period_end ? 1 : 0,
      now,
      now
    );
    return;
  }

  db.prepare(
    `UPDATE subscriptions SET
      stripe_customer_id = COALESCE(?, stripe_customer_id),
      stripe_subscription_id = COALESCE(?, stripe_subscription_id),
      status = COALESCE(?, status),
      trial_ends_at = COALESCE(?, trial_ends_at),
      current_period_end = COALESCE(?, current_period_end),
      cancel_at_period_end = COALESCE(?, cancel_at_period_end),
      updated_at = ?
     WHERE user_id = ?`
  ).run(
    fields.stripe_customer_id ?? null,
    fields.stripe_subscription_id ?? null,
    fields.status ?? null,
    fields.trial_ends_at ?? null,
    fields.current_period_end ?? null,
    fields.cancel_at_period_end == null ? null : fields.cancel_at_period_end ? 1 : 0,
    now,
    userId
  );
}

export function syncSubscriptionFromStripe(subscription) {
  const db = getDb();
  const userId = subscription.metadata?.userId;
  if (!userId) return;

  upsertSubscriptionRow(db, userId, {
    stripe_customer_id: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id,
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    trial_ends_at: subscription.trial_end ? subscription.trial_end * 1000 : null,
    current_period_end: subscription.current_period_end ? subscription.current_period_end * 1000 : null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
  });
}

export async function getOrCreateStripeCustomer(db, user) {
  const stripe = getStripe();
  if (!stripe) throw new Error("stripe_not_configured");

  const existing = getSubscriptionRow(db, user.id);
  if (existing?.stripe_customer_id) {
    return existing.stripe_customer_id;
  }

  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name: user.display_name || user.username,
    metadata: { userId: user.id },
  });

  upsertSubscriptionRow(db, user.id, {
    stripe_customer_id: customer.id,
    status: "none",
  });

  return customer.id;
}

export function remainingTrialSeconds(user, subRow) {
  const trialEndsAt = computeLocalTrialEndsAt(user, subRow);
  const remainingMs = trialEndsAt - Date.now();
  if (remainingMs <= 0) return 0;
  return Math.floor(remainingMs / 1000);
}

/** Stripe Checkout header uses Dashboard business name; product line uses product name. */
export async function ensureStripeCheckoutBranding(stripe) {
  if (!stripe) return;
  if (brandingSyncPromise) return brandingSyncPromise;

  brandingSyncPromise = (async () => {
    const brandName = stripeBrandName();
    const priceId = String(process.env.STRIPE_PRICE_ID || "").trim();
    if (!priceId) return;

    try {
      const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
      const product = price.product;
      if (!product || typeof product === "string") return;
      const productDescription = "Monthly platform access — private 1:1 sessions on Tangent Club.";
      if (product.name !== brandName || product.description !== productDescription) {
        await stripe.products.update(product.id, {
          name: brandName,
          description: productDescription,
        });
        console.log(`[billing] Stripe product renamed to "${brandName}"`);
      }
    } catch (err) {
      console.warn("[billing] Stripe product branding update failed:", err.message);
    }
  })().finally(() => {
    brandingSyncPromise = null;
  });

  return brandingSyncPromise;
}
