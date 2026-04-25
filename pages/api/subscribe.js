const EO_API_KEY = process.env.EO_API_KEY;
const EO_LIST_ID = process.env.EO_LIST_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Debug: check env vars are present
  if (!EO_API_KEY) {
    console.error('Missing EO_API_KEY environment variable');
    return res.status(500).json({ error: 'Server configuration error: missing API key' });
  }
  if (!EO_LIST_ID) {
    console.error('Missing EO_LIST_ID environment variable');
    return res.status(500).json({ error: 'Server configuration error: missing list ID' });
  }

  const { email, name, phone, plan, tone, goals } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email address is required' });
  }

  try {
    console.log(`Subscribing ${email} to list ${EO_LIST_ID}`);

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
            Phone: phone || '',
            Plan: plan || 'spark',
            Tone: tone || '',
            Goals: Array.isArray(goals) ? goals.join(', ') : (goals || ''),
          },
          status: 'SUBSCRIBED',
        }),
      }
    );

    const data = await response.json();
    console.log('EmailOctopus response:', JSON.stringify(data));

    if (response.ok) {
      return res.status(200).json({ success: true });
    }

    if (data?.error?.code === 'MEMBER_EXISTS_WITH_EMAIL_ADDRESS') {
      return res.status(200).json({ success: true, note: 'already subscribed' });
    }

    console.error('EmailOctopus error:', JSON.stringify(data));
    return res.status(500).json({ error: 'Failed to subscribe', details: data });

  } catch (err) {
    console.error('Subscribe function error:', err.message);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}
