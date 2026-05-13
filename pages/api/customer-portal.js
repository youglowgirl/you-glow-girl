// pages/api/customer-portal.js
// Creates a Stripe Customer Portal session and redirects the user.
// This allows Glow subscribers to manage their own subscription —
// cancel, update payment method, view invoices — without contacting support.
//
// Usage: Link users to /api/customer-portal?email=their@email.com

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // Find the Stripe customer by email
    const customers = await stripe.customers.list({
      email: email,
      limit: 1,
    });

    if (!customers.data.length) {
      // No Stripe customer found — redirect to home
      return res.redirect('/');
    }

    const customer = customers.data[0];

    // Create a billing portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: 'https://youglowgirl.app', // Return here after managing subscription
    });

    // Redirect user to Stripe's hosted portal
    return res.redirect(session.url);

  } catch (err) {
    console.error('Customer portal error:', err.message);
    return res.status(500).json({ error: 'Could not create portal session' });
  }
}
