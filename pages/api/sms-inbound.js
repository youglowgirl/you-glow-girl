// pages/api/sms-inbound.js
// Handles inbound SMS messages from Twilio.
// When a user replies STOP, this cancels their Stripe subscription
// and updates their status in Supabase.
// Twilio automatically handles the STOP opt-out for SMS delivery —
// this handler takes care of the Stripe cancellation side.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // Twilio sends form-encoded data, not JSON
  const body = req.body;
  const incomingMessage = (body.Body || '').trim().toUpperCase();
  const fromPhone = body.From || '';

  console.log(`Inbound SMS from ${fromPhone}: "${incomingMessage}"`);

  // ── Handle STOP ────────────────────────────────────────────────────────────
  if (incomingMessage === 'STOP' || incomingMessage === 'STOPALL' ||
      incomingMessage === 'UNSUBSCRIBE' || incomingMessage === 'CANCEL' ||
      incomingMessage === 'END' || incomingMessage === 'QUIT') {

    // Find the user in Supabase by phone number
    const { data: user, error: findError } = await supabase
      .from('users')
      .select('id, email, plan, status, stripe_subscription_id')
      .eq('phone', fromPhone)
      .single();

    if (findError || !user) {
      console.log(`No user found for phone ${fromPhone}`);
      // Still return 200 — Twilio handles the SMS opt-out automatically
      return res.status(200).send('<Response></Response>');
    }

    // Update user status in Supabase
    await supabase
      .from('users')
      .update({
        status: 'opted_out',
        texts_per_day: 0,
      })
      .eq('id', user.id);

    console.log(`User ${user.email} opted out via STOP`);

    // Cancel Stripe subscription if they're a paid Glow member
    if (user.plan === 'glow' && user.stripe_subscription_id) {
      try {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

        // Cancel at period end — they keep access until billing cycle ends
        await stripe.subscriptions.update(user.stripe_subscription_id, {
          cancel_at_period_end: true,
        });

        console.log(`Stripe subscription ${user.stripe_subscription_id} set to cancel at period end for ${user.email}`);

        // Update Supabase to reflect pending cancellation
        await supabase
          .from('users')
          .update({ status: 'cancelling' })
          .eq('id', user.id);

      } catch (stripeError) {
        console.error('Stripe cancellation error:', stripeError.message);
        // Don't fail the whole request — SMS opt-out should still work
      }
    }
  }

  // ── Handle START (re-subscribe to texts) ──────────────────────────────────
  if (incomingMessage === 'START' || incomingMessage === 'UNSTOP' ||
      incomingMessage === 'YES') {

    const { data: user } = await supabase
      .from('users')
      .select('id, plan')
      .eq('phone', fromPhone)
      .single();

    if (user) {
      await supabase
        .from('users')
        .update({
          status: 'active',
          texts_per_day: user.plan === 'glow' ? 3 : 1,
        })
        .eq('id', user.id);

      console.log(`User resubscribed via START: ${fromPhone}`);
    }
  }

  // ── Handle HELP ───────────────────────────────────────────────────────────
  // Twilio auto-responds to HELP but we can also log it
  if (incomingMessage === 'HELP') {
    console.log(`HELP request from ${fromPhone}`);
  }

  // Always return empty TwiML response — Twilio handles STOP/START/HELP
  // auto-replies automatically. We return empty so Twilio doesn't
  // send a duplicate message.
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send('<Response></Response>');
}
