// pages/api/inngest.js
import { serve } from 'inngest/next';
import { Inngest } from 'inngest';
import { createClient } from '@supabase/supabase-js';

const inngest = new Inngest({ id: 'you-glow-girl' });

// Lazy Supabase client — created when called, not at module load
function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

// ── FUNCTION 1: Daily Morning Messages (7am Central = 13:00 UTC) ──────────
const dailyMessageScheduler = inngest.createFunction(
  { id: 'daily-morning-messages', name: 'Daily Morning Messages' },
  { cron: '0 13 * * *' },
  async ({ step, logger }) => {
    logger.info('Starting daily message run...');

    const users = await step.run('fetch-active-users', async () => {
      const { data, error } = await getSupabase()
        .from('users')
        .select('id, name, email, phone, plan, tone, goals, relationship_status, kids, life_stage, texts_per_day, streak_count')
        .eq('status', 'active')
        .not('phone', 'is', null)
        .neq('phone', '');
      if (error) throw new Error(`Failed to fetch users: ${error.message}`);
      logger.info(`Found ${data.length} active users`);
      return data;
    });

    if (!users || users.length === 0) {
      logger.info('No active users — skipping');
      return { sent: 0 };
    }

    const results = { sent: 0, failed: 0 };
    const batchSize = 10;

    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      await step.run(`send-batch-${Math.floor(i / batchSize) + 1}`, async () => {
        const batchResults = await Promise.allSettled(
          batch.map(user => sendMessageToUser(user, logger))
        );
        batchResults.forEach(result => {
          if (result.status === 'fulfilled') results.sent++;
          else results.failed++;
        });
      });
    }

    logger.info(`Done — sent: ${results.sent}, failed: ${results.failed}`);
    return results;
  }
);

// ── FUNCTION 2: Send single message on demand (testing) ───────────────────
const sendSingleMessage = inngest.createFunction(
  { id: 'send-single-message', name: 'Send Single Message' },
  { event: 'ygg/message.send' },
  async ({ event, step, logger }) => {
    const { userId } = event.data;

    const user = await step.run('fetch-user', async () => {
      const { data, error } = await getSupabase()
        .from('users')
        .select('id, name, email, phone, plan, tone, goals, relationship_status, kids, life_stage, texts_per_day, streak_count')
        .eq('id', userId)
        .single();
      if (error) throw new Error(`User not found: ${error.message}`);
      return data;
    });

    await step.run('send-message', async () => {
      await sendMessageToUser(user, logger);
    });

    return { success: true, user: user.email };
  }
);

// ── HELPERS ───────────────────────────────────────────────────────────────
async function sendMessageToUser(user, logger) {
  const message = await generateMessage(user);
  if (!message) throw new Error('No message generated');
  const twilioSid = await sendSMS(user.phone, message);
  await logMessage(user.id, message, twilioSid);
  await updateUserAfterSend(user.id, user.streak_count);
  logger.info(`Sent to ${user.email}`);
}

async function generateMessage(user) {
  const systemPrompt = `You are the You Glow Girl BFF — a warm, real, down-to-earth voice that shows up in women's text messages every morning. You are not a wellness app. You are not a life coach. You are not a therapist. You are the best friend who always knows what to say.

YOUR VOICE:
- Casual, warm, and genuine — like a text from a real friend, not a brand
- Never preachy, never generic, never toxic positivity
- Short and punchy — a real text message, not a paragraph
- Occasionally use emojis — sparingly and naturally, never forced
- Never start with "Hey girl!" every single time — vary your openings
- Never sound like AI. Never use words like "journey," "empower," "manifest," "hustle," or "boss babe"

MESSAGE LENGTH: 1 to 4 sentences maximum. No bullet points, no lists — just a message.

TONE VARIATIONS:
- Warm & gentle: soft, encouraging, like a hug in text form
- Bold & direct: confident, energizing, a little fire
- Spiritual & grounded: faith-forward, peaceful, trusting the bigger picture
- Funny & real: light, witty, makes her smile — still has heart

AVOID: Generic affirmations, rhyming language, overly long messages, mentioning You Glow Girl by name.`;

  const toneMap = {
    'Warm & gentle 🤍': 'warm and gentle — soft, encouraging, like a hug in text form',
    'Bold & direct 🔥': 'bold and direct — confident, energizing, a little fire',
    'Spiritual & grounded 🙏': 'spiritual and grounded — faith-forward, peaceful',
    'Funny & real 😂': 'funny and real — light, witty, makes her smile but still has heart'
  };

  const toneInstruction = toneMap[user.tone] || 'warm and genuine';
  const goalsText = user.goals || 'daily peace of mind';
  const lifeContext = [];
  if (user.relationship_status) lifeContext.push(`relationship status: ${user.relationship_status}`);
  if (user.kids) lifeContext.push(`kids: ${user.kids}`);
  if (user.life_stage && user.life_stage !== 'N/A') lifeContext.push(`youngest child stage: ${user.life_stage}`);

  const userPrompt = `Write a single personalized morning text message for ${user.name}.
${lifeContext.length > 0 ? `Her life context: ${lifeContext.join(', ')}.` : ''}
Her current goals: ${goalsText}.
Her preferred tone: ${toneInstruction}.
Write exactly ONE text message — no more than 3-4 sentences. Just the message itself, no preamble.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Claude error: ${JSON.stringify(data)}`);
  return data.content?.[0]?.text?.trim() || null;
}

async function sendSMS(toPhone, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone  = process.env.TWILIO_PHONE_NUMBER;

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: toPhone, From: fromPhone, Body: message }).toString(),
    }
  );

  const data = await response.json();
  if (!response.ok) throw new Error(`Twilio error: ${data.message}`);
  return data.sid;
}

async function logMessage(userId, messageText, twilioSid) {
  const { error } = await getSupabase()
    .from('messages')
    .insert({ user_id: userId, message_text: messageText, delivered: true, twilio_sid: twilioSid || null });
  if (error) console.error('Failed to log message:', error.message);
}

async function updateUserAfterSend(userId, currentStreak) {
  const { error } = await getSupabase()
    .from('users')
    .update({ last_text_sent: new Date().toISOString(), streak_count: (currentStreak || 0) + 1 })
    .eq('id', userId);
  if (error) console.error('Failed to update user:', error.message);
}

// ── Serve ─────────────────────────────────────────────────────────────────
export default serve({
  client: inngest,
  functions: [dailyMessageScheduler, sendSingleMessage],
});
