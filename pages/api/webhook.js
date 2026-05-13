// pages/api/webhook.js
// Receives Stripe webhook events and saves new Glow subscribers to Supabase.
// This fires automatically when someone completes the Stripe checkout flow.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Disable Next.js body parsing — Stripe sends raw body for signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper to read raw request body
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  // ── Verify the webhook came from Stripe ──────────────────────────────────
  try {
    // Dynamically import Stripe so it only loads server-side
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    console.log(`Stripe event received: ${event.type}`);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // ── Handle checkout.session.completed ────────────────────────────────────
  // This fires when a customer successfully completes Stripe checkout
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Extract customer details from Stripe session
    const email = session.customer_details?.email || null;
    const name  = session.customer_details?.name  || null;
    const phone = session.customer_details?.phone || null;

    console.log(`New Glow subscriber: ${email}`);

    if (!email) {
      console.error('No email found in Stripe session');
      return res.status(200).json({ received: true }); // Return 200 so Stripe doesn't retry
    }

    // ── Save to Supabase ────────────────────────────────────────────────────
    // Check if user already exists (e.g. they were on Spark free plan first)
    const { data: existingUser } = await supabase
      .from('users')
      .select('id, plan')
      .eq('email', email)
      .single();

    if (existingUser) {
      // User already exists — upgrade them from Spark to Glow
      const { error: updateError } = await supabase
        .from('users')
        .update({
          plan: 'glow',
          status: 'active',
          texts_per_day: 3,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          updated_at: new Date().toISOString(),
        })
        .eq('email', email);

      if (updateError) {
        console.error('Supabase update error:', updateError.message);
        return res.status(500).json({ error: 'Failed to update user' });
      }

      console.log(`Upgraded existing user ${email} to Glow`);

    } else {
      // Brand new user — insert full profile
      // Note: goals, tone, etc. come from EmailOctopus since Stripe
      // doesn't carry quiz answers. We insert what we have and the
      // message generator will use defaults until profile is enriched.
      const { error: insertError } = await supabase
        .from('users')
        .insert({
          email,
          name:  name  || '',
          phone: phone || '',
          plan:  'glow',
          status: 'active',
          texts_per_day: 3,
          timezone: 'America/Chicago', // default — update when timezone detection is built
          streak_count: 0,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          created_at: new Date().toISOString(),
        });

      if (insertError) {
        console.error('Supabase insert error:', insertError.message);
        return res.status(500).json({ error: 'Failed to create user' });
      }

      console.log(`Created new Glow user: ${email}`);
    }
  }

  // ── Handle customer.subscription.deleted ─────────────────────────────────
  // This fires when someone cancels their Glow subscription
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;

    const { error } = await supabase
      .from('users')
      .update({ 
        plan: 'spark',
        status: 'active', // keep them on free Spark plan — don't delete
        texts_per_day: 1,
        stripe_subscription_id: null,
      })
      .eq('stripe_subscription_id', subscription.id);

    if (error) {
      console.error('Supabase cancellation update error:', error.message);
    } else {
      console.log(`Subscription cancelled — user downgraded to Spark: ${subscription.id}`);
    }
  }

  // ── Handle customer.subscription.updated ─────────────────────────────────
  // This fires if payment fails, subscription pauses, etc.
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const status = subscription.status; // active, past_due, paused, etc.

    if (status === 'past_due' || status === 'unpaid') {
      await supabase
        .from('users')
        .update({ status: 'past_due' })
        .eq('stripe_subscription_id', subscription.id);

      console.log(`Payment issue — subscription ${subscription.id} marked past_due`);
    }

    if (status === 'active') {
      await supabase
        .from('users')
        .update({ status: 'active' })
        .eq('stripe_subscription_id', subscription.id);
    }
  }

  // Always return 200 to acknowledge receipt — Stripe will retry if it gets anything else
  return res.status(200).json({ received: true });
}
