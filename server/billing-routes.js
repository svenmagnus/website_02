import { Router } from "express";
import { getDb } from "./db.js";
import { getAppPublicUrl } from "./mail.js";
import {
  getStripe,
  getSubscriptionRow,
  getOrCreateStripeCustomer,
  isStripeConfigured,
  isPremiumStripeConfigured,
  isPremiumOneTimeBilling,
  premiumPriceLabel,
  remainingTrialSeconds,
  resolveSubscriptionAccess,
  syncSubscriptionFromStripe,
  grantOneTimePremium,
  userHasPremiumAddon,
  MEMBER_PRICE_EUR,
  PREMIUM_PRICE_EUR,
  TRIAL_DAYS,
  upsertSubscriptionRow,
  ensureStripeCheckoutBranding,
  stripeBrandName,
  memberStripePriceId,
  premiumStripePriceId,
  normalizeSubscriptionTier,
} from "./billing.js";
import { handleConnectBookingCheckout } from "./connect-routes.js";

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

export const billingRouter = Router();

billingRouter.get("/billing/status", requireAuth, (req, res) => {
  const access = resolveSubscriptionAccess(req.authUser);
  res.json({
    ok: true,
    configured: isStripeConfigured(),
    premiumConfigured: isPremiumStripeConfigured(),
    premiumOneTime: isPremiumOneTimeBilling(),
    premiumPriceLabel: premiumPriceLabel(),
    priceEurMember: MEMBER_PRICE_EUR,
    priceEurPremium: PREMIUM_PRICE_EUR,
    trialDays: TRIAL_DAYS,
    subscription: access,
  });
});

billingRouter.post("/billing/checkout", requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ ok: false, error: "stripe_not_configured" });
  }

  const db = getDb();
  const user = req.authUser;
  const access = resolveSubscriptionAccess(user);
  const requestedTier = normalizeSubscriptionTier(req.body?.tier) || "member";

  if (access.exempt) {
    return res.status(400).json({ ok: false, error: "subscription_exempt" });
  }

  if (requestedTier === "premium") {
    if (!premiumStripePriceId()) {
      return res.status(503).json({ ok: false, error: "premium_not_configured" });
    }
    if (userHasPremiumAddon(user)) {
      return res.status(400).json({ ok: false, error: "subscription_active" });
    }
  } else if (access.accessGranted && ["active", "trialing"].includes(access.status)) {
    return res.status(400).json({ ok: false, error: "subscription_active" });
  }

  const priceId = requestedTier === "premium" ? premiumStripePriceId() : memberStripePriceId();
  if (!priceId) {
    return res.status(503).json({ ok: false, error: "stripe_not_configured" });
  }

  try {
    const customerId = await getOrCreateStripeCustomer(db, user);
    const subRow = getSubscriptionRow(db, user.id);
    const appUrl = getAppPublicUrl();
    const brandName = stripeBrandName();
    const tierLabel = requestedTier === "premium" ? "Premium" : "Member";
    const premiumOneTime = requestedTier === "premium" && isPremiumOneTimeBilling();

    await ensureStripeCheckoutBranding(stripe);

    if (premiumOneTime) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: customerId,
        client_reference_id: user.id,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${appUrl}/index.html?billing=success&tier=premium`,
        cancel_url: `${appUrl}/index.html?billing=cancel`,
        metadata: { userId: user.id, tier: "premium", purchaseType: "one_time" },
        custom_text: {
          submit: {
            message: `${brandName} — one-time Premium add-on (${PREMIUM_PRICE_EUR} €). Member subscription (${MEMBER_PRICE_EUR} €/month) remains required for platform access.`,
          },
        },
      });
      return res.json({ ok: true, url: session.url, tier: requestedTier, billingMode: "one_time" });
    }

    const trialSeconds = requestedTier === "member" ? remainingTrialSeconds(user, subRow) : 0;
    const sessionParams = {
      mode: "subscription",
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/index.html?billing=success`,
      cancel_url: `${appUrl}/index.html?billing=cancel`,
      metadata: { userId: user.id, tier: requestedTier },
      subscription_data: {
        metadata: { userId: user.id, tier: requestedTier },
        description: `${brandName} ${tierLabel} subscription`,
      },
      custom_text: {
        submit: {
          message: `${brandName} — secure monthly ${tierLabel} subscription. Cancel anytime in billing settings.`,
        },
      },
    };

    if (trialSeconds > 0) {
      sessionParams.subscription_data.trial_period_days = Math.max(
        1,
        Math.ceil(trialSeconds / (24 * 60 * 60))
      );
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ ok: true, url: session.url, tier: requestedTier, billingMode: "subscription" });
  } catch (err) {
    console.error("[billing] checkout failed:", err);
    res.status(500).json({ ok: false, error: "checkout_failed", message: err.message });
  }
});

billingRouter.post("/billing/portal", requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ ok: false, error: "stripe_not_configured" });
  }

  const db = getDb();
  const subRow = getSubscriptionRow(db, req.authUser.id);
  if (!subRow?.stripe_customer_id) {
    return res.status(400).json({ ok: false, error: "no_stripe_customer" });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: subRow.stripe_customer_id,
      return_url: `${getAppPublicUrl()}/index.html`,
    });
    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[billing] portal failed:", err);
    res.status(500).json({ ok: false, error: "portal_failed", message: err.message });
  }
});

export async function handleStripeWebhook(req, res) {
  const stripe = getStripe();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!stripe || !webhookSecret) {
    return res.status(503).send("Stripe webhook not configured");
  }

  const signature = req.get("stripe-signature");
  if (!signature) {
    return res.status(400).send("Missing stripe-signature");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    console.error("[billing] webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = getDb();

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (await handleConnectBookingCheckout(session)) {
          break;
        }
        const userId = session.client_reference_id || session.metadata?.userId;
        const tier = normalizeSubscriptionTier(session.metadata?.tier);
        const isOneTimePremium =
          session.mode === "payment" &&
          (tier === "premium" || session.metadata?.purchaseType === "one_time");

        if (userId && isOneTimePremium && session.payment_status === "paid") {
          grantOneTimePremium(db, userId, {
            stripeCustomerId: session.customer ? String(session.customer) : null,
          });
          break;
        }

        if (userId && session.customer) {
          upsertSubscriptionRow(db, userId, {
            stripe_customer_id: String(session.customer),
            status: "trialing",
            subscription_tier: tier || "member",
          });
        }
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(String(session.subscription));
          syncSubscriptionFromStripe(sub);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        syncSubscriptionFromStripe(event.data.object);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error("[billing] webhook handler error:", err);
    return res.status(500).send("Webhook handler failed");
  }

  res.json({ received: true });
}
