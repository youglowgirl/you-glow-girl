// pages/api/subscribe.js
// Handles new YGG signups from the onboarding quiz.
// Simultaneously saves the user profile to Supabase AND adds them to EmailOctopus.
// Both run in parallel so neither slows the other down.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const EO_API_KEY = process.env.EO_API_KEY;
const EO_LIST_ID = process.env.EO_LIST_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check env vars
  if (!EO_API_KEY) {
    console.error('Missing EO_API_KEY environment variable');
    return res.status(500).json({ error: 'Server configuration error: missing API key' });
  }
  if (!EO_LIST_ID) {
    console.error('Missing EO_LIST_ID environment variable');
    return res.status(500).json({ error: 'Server configuration error: missing list ID' });
  }

  const { email, name, phone, plan, tone, goals, relationship_status, kids, life_stage } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email address is required' });
  }

  console.log(`New signup: ${email} — plan: ${plan || 'spark'}`);

  // Run Supabase and EmailOctopus in parallel
  const [supabaseResult, eoResult] = await Promise.allSettled([

    // 1. Save to Supabase
    (async () => {
      const { data: existing } = await supabase
        .from('users')
        .select('id, plan')
        .eq('email', email)
        .single();

      if (existing) {
        const { error } = await supabase
          .from('users')
          .update({
            name: name || existing.name,
            phone: phone || '',
            plan: plan || 'spark',
            tone: tone || '',
            goals: Array.isArray(goals) ? goals.join(', ') : (goals || ''),
            relationship_status: relationship_status || '',
            kids: kids || '',
            life_stage: life_stage || '',
            status: 'active',
            texts_per_day: plan === 'glow' ? 3 : 1,
          })
          .eq('email', email);

        if (error) throw new Error(`Supabase update error: ${error.message}`);
        console.log(`Updated existing user in Supabase: ${email}`);
        return { action: 'updated' };

      } else {
        const { error } = await supabase
          .from('users')
          .insert({
            email,
            name: name || '',
            phone: phone || '',
            plan: plan || 'spark',
            status: 'active',
            tone: tone || '',
            goals: Array.isArray(goals) ? goals.join(', ') : (goals || ''),
            relationship_status: relationship_status || '',
            kids: kids || '',
            life_stage: life_stage || '',
            timezone: 'America/Chicago',
            texts_per_day: plan === 'glow' ? 3 : 1,
            streak_count: 0,
          });

        if (error) throw new Error(`Supabase insert error: ${error.message}`);
        console.log(`Created new user in Supabase: ${email}`);
        return { action: 'created' };
      }
    })(),

    // 2. Add to EmailOctopus
    (async () => {
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

      if (data?.error?.code === 'MEMBER_EXISTS_WITH_EMAIL_ADDRESS') {
        console.log(`EmailOctopus: ${email} already subscribed`);
        return { action: 'already_subscribed' };
      }

      if (!response.ok) {
        throw new Error(`EmailOctopus error: ${JSON.stringify(data)}`);
      }

      console.log(`Added to EmailOctopus: ${email}`);
      return { action: 'subscribed' };
    })()

  ]);

  // Log results
  if (supabaseResult.status === 'rejected') {
    console.error('Supabase failed:', supabaseResult.reason);
  }
  if (eoResult.status === 'rejected') {
    console.error('EmailOctopus failed:', eoResult.reason);
  }

  const supabaseOk = supabaseResult.status === 'fulfilled';
  const eoOk = eoResult.status === 'fulfilled';

  if (!supabaseOk && !eoOk) {
    return res.status(500).json({ error: 'Failed to save signup data' });
  }

  return res.status(200).json({
    success: true,
    supabase: supabaseOk ? supabaseResult.value.action : 'failed',
    emailoctopus: eoOk ? eoResult.value.action : 'failed'
  });
}
