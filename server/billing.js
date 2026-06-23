import Stripe from "stripe";
import { getDb } from "./db.js";

export const TRIAL_DAYS = Math.max(1, Number(process.env.SUBSCRIPTION_TRIAL_DAYS || 30));
export const MEMBER_PRICE_EUR = "2.95";
export const PREMIUM_PRICE_EUR = "9.95";
/** @deprecated use MEMBER_PRICE_EUR */
export const SUBSCRIPTION_PRICE_EUR = MEMBER_PRICE_EUR;

export function stripeBrandName() {
  return String(process.env.STRIPE_BRAND_NAME || process.env.MAIL_SITE_NAME || "Tangent Club").trim();
}

export function memberStripePriceId() {
  return String(process.env.STRIPE_PRICE_ID_MEMBER || process.env.STRIPE_PRICE_ID || "").trim();
}

export function premiumStripePriceId() {
  return String(process.env.STRIPE_PRICE_ID_PREMIUM || "").trim();
}

/** Premium checkout: one_time (default) or subscription (monthly). */
export function isPremiumOneTimeBilling() {
  const mode = String(process.env.PREMIUM_BILLING_MODE || "one_time").trim().toLowerCase();
  return mode !== "subscription";
}

export function premiumPriceLabel() {
  return isPremiumOneTimeBilling() ? `${PREMIUM_PRICE_EUR} € one-time` : `${PREMIUM_PRICE_EUR} € / month`;
}

export function normalizeSubscriptionOverride(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "trial_expired") return "trial_expired";
  if (v === "active" || v === "premium") return "active";
  if (v === "member" || v === "member_active") return "member";
  if (v === "trial_member" || v === "trial" || v === "") return "trial_member";
  return "";
}

export function normalizeSubscriptionTier(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "premium") return "premium";
  if (v === "member") return "member";
  return "";
}

export function tierFromStripePrice(priceId) {
  const premium = premiumStripePriceId();
  const member = memberStripePriceId();
  const id = String(priceId || "").trim();
  if (premium && id === premium) return "premium";
  if (member && id === member) return "member";
  return member ? "member" : premium ? "premium" : "member";
}

let stripeClient;
let brandingSyncPromise = null;

export function isStripeConfigured() {
  return Boolean(String(process.env.STRIPE_SECRET_KEY || "").trim() && memberStripePriceId());
}

export function isPremiumStripeConfigured() {
  return Boolean(isStripeConfigured() && premiumStripePriceId());
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

function isModelUser(row) {
  return Boolean(row?.is_model);
}

export function isFreeGuestUser(user) {
  return Boolean(user?.is_free_guest);
}

function isPremiumPartner(row) {
  return Boolean(row?.is_premium) && Boolean(row?.is_model);
}

export function isSubscriptionExempt(user) {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  if (isPremiumPartner(user)) return true;
  if (isFreeGuestUser(user)) return true;
  return false;
}

export function hasPremiumModelPoolAccess(user, access = null) {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  if (isModelUser(user)) return false;
  const sub = access || resolveSubscriptionAccess(user);
  if (sub.adminOverride === "active") return true;
  if (sub.tier === "premium" && sub.accessGranted) return true;
  return Boolean(user.is_premium) && !isModelUser(user) && sub.accessGranted;
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
const LIFETIME_PREMIUM_STATUS = "lifetime";

function hasOneTimePremium(row) {
  return Boolean(row?.premium_one_time_at);
}

function priceEurForTier(tier) {
  return tier === "premium" ? PREMIUM_PRICE_EUR : MEMBER_PRICE_EUR;
}

function resolveTierFromStripeRow(row) {
  const stored = normalizeSubscriptionTier(row?.subscription_tier);
  if (stored) return stored;
  return "member";
}

export function resolveSubscriptionAccess(user, subRow = null) {
  const db = getDb();
  const row = subRow ?? getSubscriptionRow(db, user.id);
  const trialEndsAt = computeLocalTrialEndsAt(user, row);
  const adminOverride = normalizeSubscriptionOverride(user?.subscription_override);
  const stripeTier = row ? resolveTierFromStripeRow(row) : "member";
  const base = {
    enforced: isSubscriptionEnforced(),
    exempt: isSubscriptionExempt(user),
    tier: null,
    membershipType: "member",
    priceEur: MEMBER_PRICE_EUR,
    priceEurMember: MEMBER_PRICE_EUR,
    priceEurPremium: PREMIUM_PRICE_EUR,
    trialDays: TRIAL_DAYS,
    trialEndsAt,
    daysRemaining: daysRemaining(trialEndsAt),
    status: row?.status || "none",
    stripeCustomerId: row?.stripe_customer_id || null,
    currentPeriodEnd: row?.current_period_end || null,
    cancelAtPeriodEnd: Boolean(row?.cancel_at_period_end),
    adminOverride: adminOverride || null,
    hasPremiumModelAccess: false,
  };

  if (adminOverride === "trial_expired") {
    return {
      ...base,
      exempt: false,
      accessGranted: false,
      requiresPayment: true,
      phase: "trial_expired",
      membershipType: "expired",
      daysRemaining: 0,
      hasPremiumModelAccess: false,
    };
  }

  if (adminOverride === "active") {
    return {
      ...base,
      accessGranted: true,
      requiresPayment: false,
      phase: "active",
      tier: "premium",
      membershipType: "premium",
      priceEur: PREMIUM_PRICE_EUR,
      hasPremiumModelAccess: true,
    };
  }

  if (adminOverride === "member") {
    return {
      ...base,
      accessGranted: true,
      requiresPayment: false,
      phase: "active",
      tier: "member",
      membershipType: "member",
      priceEur: MEMBER_PRICE_EUR,
      hasPremiumModelAccess: false,
    };
  }

  if (adminOverride === "trial_member") {
    const trialActive = Date.now() < trialEndsAt;
    return {
      ...base,
      exempt: false,
      accessGranted: trialActive,
      requiresPayment: !trialActive,
      phase: trialActive ? "trial" : "trial_expired",
      membershipType: trialActive ? "test" : "expired",
      daysRemaining: daysRemaining(trialEndsAt),
      hasPremiumModelAccess: false,
    };
  }

  if (isFreeGuestUser(user)) {
    return {
      ...base,
      accessGranted: true,
      requiresPayment: false,
      phase: "free",
      tier: null,
      membershipType: "free",
      priceEur: MEMBER_PRICE_EUR,
      hasPremiumModelAccess: false,
    };
  }

  if (row && hasOneTimePremium(row)) {
    return {
      ...base,
      accessGranted: true,
      requiresPayment: false,
      phase: "active",
      tier: "premium",
      membershipType: "premium",
      priceEur: PREMIUM_PRICE_EUR,
      premiumBillingMode: "one_time",
      status: LIFETIME_PREMIUM_STATUS,
      hasPremiumModelAccess: true,
    };
  }

  if (!base.enforced) {
    return {
      ...base,
      accessGranted: true,
      requiresPayment: false,
      phase: "not_required",
      membershipType: isModelUser(user) ? "partner" : isAdminUser(user) ? "admin" : "member",
      hasPremiumModelAccess: hasPremiumModelPoolAccess(user, { ...base, accessGranted: true }),
    };
  }

  if (base.exempt) {
    return {
      ...base,
      accessGranted: true,
      requiresPayment: false,
      phase: "exempt",
      membershipType: isModelUser(user) ? "partner" : "admin",
      hasPremiumModelAccess: hasPremiumModelPoolAccess(user, { ...base, accessGranted: true }),
    };
  }

  const stripeStatus = String(row?.status || "none");
  if (ACTIVE_STRIPE_STATUSES.has(stripeStatus)) {
    if (stripeStatus === "trialing" && row?.trial_ends_at && row.trial_ends_at < Date.now()) {
      /* fall through */
    } else {
      const tier = stripeTier;
      const membershipType = tier === "premium" ? "premium" : "member";
      const access = {
        ...base,
        accessGranted: true,
        requiresPayment: false,
        phase: stripeStatus,
        tier,
        membershipType,
        priceEur: priceEurForTier(tier),
        daysRemaining: row?.trial_ends_at ? daysRemaining(row.trial_ends_at) : 0,
        hasPremiumModelAccess: tier === "premium",
      };
      access.hasPremiumModelAccess = hasPremiumModelPoolAccess(user, access);
      return access;
    }
  }

  if (Date.now() < trialEndsAt) {
    return {
      ...base,
      accessGranted: true,
      requiresPayment: false,
      phase: "trial",
      membershipType: "test",
      daysRemaining: daysRemaining(trialEndsAt),
      hasPremiumModelAccess: false,
    };
  }

  return {
    ...base,
    accessGranted: false,
    requiresPayment: true,
    phase: stripeStatus === "none" ? "trial_expired" : stripeStatus,
    membershipType: "expired",
    daysRemaining: 0,
    hasPremiumModelAccess: false,
  };
}

export function resolveMembershipLabel(user, subRow = null) {
  if (!user) return { label: "Visitor", type: "visitor" };
  if (user.banned_at) return { label: "Banned", type: "banned" };
  if (isAdminUser(user)) return { label: "Administrator", type: "admin" };
  if (isModelUser(user)) return { label: "Premium Partner", type: "partner" };

  const access = resolveSubscriptionAccess(user, subRow);
  switch (access.membershipType) {
    case "test":
      return { label: "Test account", type: "test" };
    case "free":
      return { label: "Free", type: "free" };
    case "premium":
      return { label: "Premium", type: "premium" };
    case "expired":
      return { label: "Membership expired", type: "expired" };
    case "member":
    default:
      return { label: "Member", type: "member" };
  }
}

export function subscriptionFieldsForProfile(user) {
  const access = resolveSubscriptionAccess(user);
  const membership = resolveMembershipLabel(user);
  return {
    isFreeGuest: isFreeGuestUser(user),
    membershipLabel: membership.label,
    membershipType: access.membershipType,
    subscription: {
      enforced: access.enforced,
      accessGranted: access.accessGranted,
      requiresPayment: access.requiresPayment,
      exempt: access.exempt,
      phase: access.phase,
      status: access.status,
      tier: access.tier,
      membershipType: access.membershipType,
      membershipLabel: membership.label,
      priceEur: access.priceEur,
      priceEurMember: access.priceEurMember,
      priceEurPremium: access.priceEurPremium,
      trialDays: access.trialDays,
      trialEndsAt: access.trialEndsAt,
      daysRemaining: access.daysRemaining,
      currentPeriodEnd: access.currentPeriodEnd,
      cancelAtPeriodEnd: access.cancelAtPeriodEnd,
      adminOverride: access.adminOverride,
      hasPremiumModelAccess: access.hasPremiumModelAccess,
      premiumBillingMode: access.premiumBillingMode || (isPremiumOneTimeBilling() ? "one_time" : "subscription"),
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
        trial_ends_at, current_period_end, cancel_at_period_end, subscription_tier, premium_one_time_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      fields.stripe_customer_id || null,
      fields.stripe_subscription_id || null,
      fields.status || "none",
      fields.trial_ends_at ?? null,
      fields.current_period_end ?? null,
      fields.cancel_at_period_end ? 1 : 0,
      fields.subscription_tier ?? null,
      fields.premium_one_time_at ?? null,
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
      subscription_tier = COALESCE(?, subscription_tier),
      premium_one_time_at = COALESCE(?, premium_one_time_at),
      updated_at = ?
     WHERE user_id = ?`
  ).run(
    fields.stripe_customer_id ?? null,
    fields.stripe_subscription_id ?? null,
    fields.status ?? null,
    fields.trial_ends_at ?? null,
    fields.current_period_end ?? null,
    fields.cancel_at_period_end == null ? null : fields.cancel_at_period_end ? 1 : 0,
    fields.subscription_tier ?? null,
    fields.premium_one_time_at ?? null,
    now,
    userId
  );
}

function syncUserPremiumFlag(db, userId, tier, status) {
  const user = db.prepare("SELECT id, is_premium, is_model, is_admin FROM users WHERE id = ?").get(userId);
  if (!user || user.is_model || user.is_admin) return;
  const subRow = getSubscriptionRow(db, userId);
  if (hasOneTimePremium(subRow)) return;
  const active = ACTIVE_STRIPE_STATUSES.has(String(status || ""));
  const nextPremium = active && tier === "premium" ? 1 : 0;
  if (Number(user.is_premium) !== nextPremium) {
    db.prepare("UPDATE users SET is_premium = ? WHERE id = ?").run(nextPremium, userId);
  }
}

export function grantOneTimePremium(db, userId, { stripeCustomerId = null } = {}) {
  const now = Date.now();
  upsertSubscriptionRow(db, userId, {
    stripe_customer_id: stripeCustomerId || undefined,
    status: LIFETIME_PREMIUM_STATUS,
    subscription_tier: "premium",
    premium_one_time_at: now,
  });
  const user = db.prepare("SELECT id, is_model, is_admin FROM users WHERE id = ?").get(userId);
  if (user && !user.is_model && !user.is_admin) {
    db.prepare("UPDATE users SET is_premium = 1 WHERE id = ?").run(userId);
  }
}

export function userHasPremiumAccess(user, subRow = null) {
  const db = getDb();
  const row = subRow ?? getSubscriptionRow(db, user?.id);
  if (hasOneTimePremium(row)) return true;
  const access = resolveSubscriptionAccess(user, row);
  return access.tier === "premium" && access.accessGranted;
}

export function syncSubscriptionFromStripe(subscription) {
  const db = getDb();
  const userId = subscription.metadata?.userId;
  if (!userId) return;

  const existing = getSubscriptionRow(db, userId);
  if (hasOneTimePremium(existing)) {
    upsertSubscriptionRow(db, userId, {
      stripe_customer_id:
        typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id,
      stripe_subscription_id: subscription.id,
    });
    return;
  }
  const priceId =
    subscription.items?.data?.[0]?.price?.id ||
    (typeof subscription.plan === "object" ? subscription.plan?.id : subscription.plan);
  const tier = tierFromStripePrice(priceId);
  const status = subscription.status;

  upsertSubscriptionRow(db, userId, {
    stripe_customer_id: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id,
    stripe_subscription_id: subscription.id,
    status,
    trial_ends_at: subscription.trial_end ? subscription.trial_end * 1000 : null,
    current_period_end: subscription.current_period_end ? subscription.current_period_end * 1000 : null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    subscription_tier: ACTIVE_STRIPE_STATUSES.has(status) ? tier : null,
  });

  syncUserPremiumFlag(db, userId, tier, status);
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
    const productDescription = "Monthly platform access — private 1:1 sessions on Tangent Club.";
    for (const priceId of [memberStripePriceId(), premiumStripePriceId()].filter(Boolean)) {
      try {
        const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
        const product = price.product;
        if (!product || typeof product === "string") continue;
        const suffix = priceId === premiumStripePriceId() ? " Premium" : " Member";
        const name = `${brandName}${suffix}`;
        if (product.name !== name || product.description !== productDescription) {
          await stripe.products.update(product.id, {
            name,
            description: productDescription,
          });
          console.log(`[billing] Stripe product renamed to "${name}"`);
        }
      } catch (err) {
        console.warn("[billing] Stripe product branding update failed:", err.message);
      }
    }
  })().finally(() => {
    brandingSyncPromise = null;
  });

  return brandingSyncPromise;
}
