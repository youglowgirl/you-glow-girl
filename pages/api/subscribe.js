// pages/api/subscribe.js
// Vercel serverless function — receives subscriber data from the YGG onboarding
// quiz and forwards it to EmailOctopus from the server side (no CORS issues).

const EO_API_KEY = process.env.EO_API_KEY;
const EO_LIST_ID = process.env.EO_LIST_ID;

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, name, plan, tone, goals } = req.body;

  // Basic validation — email is required
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email address is required' });
  }

  try {
    const response = await fetch(
      `https://emailoctopus.com/api/1.6/lists/${EO_LIST_ID}/contacts`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: EO_API_KEY,
          email_address: email,
          fields: {
            FirstName: name || '',
            Plan: plan || 'spark',
            Tone: tone || '',
            Goals: Array.isArray(goals) ? goals.join(', ') : (goals || ''),
          },
          status: 'SUBSCRIBED',
        }),
      }
    );

    const data = await response.json();

    // EmailOctopus returns 200 on success
    if (response.ok) {
      return res.status(200).json({ success: true });
    }

    // Handle duplicate subscriber gracefully — not an error for us
    if (data?.error?.code === 'MEMBER_EXISTS_WITH_EMAIL_ADDRESS') {
      return res.status(200).json({ success: true, note: 'already subscribed' });
    }

    // Any other EmailOctopus error
    console.error('EmailOctopus error:', data);
    return res.status(500).json({ error: 'Failed to subscribe' });

  } catch (err) {
    console.error('Subscribe function error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
