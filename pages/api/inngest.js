// pages/api/inngest.js
// Inngest API route — serves all YGG scheduled functions to Inngest.
// This is the endpoint Inngest calls to discover and execute your functions.

import { serve } from 'inngest/next';
import { Inngest } from 'inngest';
import { createClient } from '@supabase/supabase-js';

// ── Inngest client ────────────────────────────────────────────────────────────
export const inngest = new Inngest({
  id: 'you-glow-girl',
  signingKey: process.env.INNGEST_SIGNING_KEY,
});

// ── Supabase client ───────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ══════════════════════════════════════════════════════════════════════════════
// FUNCTION 1: Daily Morning Message Scheduler
// Runs every day at 7:00 AM Central Time
// Fetches all active users and sends each one a personalized text
// ══════════════════════════════════════════════════════════════════════════════
export const dailyMessageScheduler = inngest.createFunction(
  {
    id: 'daily-morning-messages',
    name: 'Daily Morning Messages',
  },
  // Cron schedule: 7:00 AM Central = 13:00 UTC (accounts for CST)
  // During CDT (summer) Central is UTC-5, so 7am = 12:00 UTC
  // During CST (winter) Central is UTC-6, so 7am = 13:00 UTC
  // Using 13:00 UTC as a safe default — adjust seasonally if needed
  { cron: '0 13 * * *' },

  async ({ step, logger }) => {
    logger.info('Starting daily message run...');

    // ── Step 1: Fetch all active users from Supabase ──────────────────────
    const users = await step.run('fetch-active-users', async () => {
      const { data, error } = await supabase
        .from('users')
        .select('id, name, email, phone, plan, tone, goals, relationship_status, kids, life_stage, texts_per_day, streak_count')
        .eq('status', 'active')
        .not('phone', 'is', null)
        .neq('phone', '');

      if (error) throw new Error(`Failed to fetch users: ${error.message}`);

      logger.info(`Found ${data.length} active users to message`);
      return data;
    });

    if (!users || users.length === 0) {
      logger.info('No active users found — skipping message run');
      return { sent: 0 };
    }

    // ── Step 2: Send a message to each user ───────────────────────────────
    // Process users in batches of 10 to avoid overwhelming the APIs
    const results = { sent: 0, failed: 0, errors: [] };
    const batchSize = 10;

    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);

      await step.run(`send-batch-${Math.floor(i / batchSize) + 1}`, async () => {
        const batchPromises = batch.map(user => sendMessageToUser(user, logger));
        const batchResults = await Promise.allSettled(batchPromises);

        batchResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            results.sent++;
          } else {
            results.failed++;
            results.errors.push({
              user: batch[index].email,
              error: result.reason?.message
            });
            logger.error(`Failed to message ${batch[index].email}: ${result.reason?.message}`);
          }
        });
      });
    }

    logger.info(`Daily run complete — sent: ${results.sent}, failed: ${results.failed}`);
    return results;
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// FUNCTION 2: Send a single message on demand
// Can be triggered manually for testing or for immediate delivery
// ══════════════════════════════════════════════════════════════════════════════
export const sendSingleMessage = inngest.createFunction(
  {
    id: 'send-single-message',
    name: 'Send Single Message',
  },
  { event: 'ygg/message.send' },

  async ({ event, step, logger }) => {
    const { userId } = event.data;

    // Fetch the specific user
    const user = await step.run('fetch-user', async () => {
      const { data, error } = await supabase
        .from('users')
        .select('id, name, email, phone, plan, tone, goals, relationship_status, kids, life_stage, texts_per_day, streak_count')
        .eq('id', userId)
        .single();

      if (error) throw new Error(`User not found: ${error.message}`);
      return data;
    });

    // Send the message
    await step.run('send-message', async () => {
      await sendMessageToUser(user, logger);
    });

    return { success: true, user: user.email };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// HELPER: Generate and send a message to a single user
// ══════════════════════════════════════════════════════════════════════════════
async function sendMessageToUser(user, logger) {
  // Step A: Generate personalized message via Claude API
  const message = await generateMessage(user);
  if (!message) throw new Error('No message generated');

  // Step B: Send via Twilio
  const twilioSid = await sendSMS(user.phone, message);

  // Step C: Log to Supabase messages table
  await logMessage(user.id, message, twilioSid);

  // Step D: Update user streak and last_text_sent
  await updateUserAfterSend(user.id, user.streak_count);

  logger.info(`Message sent to ${user.email}: "${message.substring(0, 50)}..."`);
  return { success: true };
}

// ── Generate message via Claude API ──────────────────────────────────────────
async function generateMessage(user) {
  const systemPrompt = `You are the You Glow Girl BFF — a warm, real, down-to-earth voice that shows up in women's text messages every morning. You are not a wellness app. You are not a life coach. You are not a therapist. You are the best friend who always knows what to say — the one who gets it without you having to explain everything.

YOUR VOICE:
- Casual, warm, and genuine — like a text from a real friend, not a brand
- Never preachy, never generic, never toxic positivity
- Short and punchy — a real text message, not a paragraph
- You can use light humor, warmth, directness, or softness depending on the user's tone preference
- Occasionally use emojis — sparingly and naturally, never forced
- Never start with "Hey girl!" every single time — vary your openings
- Never sound like AI. Never use words like "journey," "empower," "manifest," "hustle," or "boss babe"
- Never give advice unless it's the kind a best friend would give, not a coach

MESSAGE LENGTH:
- 1 to 4 sentences maximum
- Should feel like something you'd actually send in a text
- No bullet points, no lists, no headers — just a message

TONE VARIATIONS:
- Warm & gentle: soft, encouraging, like a hug in text form
- Bold & direct: confident, energizing, a little fire — tells her to go get it
- Spiritual & grounded: faith-forward, peaceful, rooted — trusts the bigger picture
- Funny & real: light, witty, makes her smile or laugh — still has heart underneath

WHAT TO AVOID:
- Generic affirmations ("You are enough!" "Believe in yourself!")
- Rhyming or sing-song language
- Overly long messages
- Mentioning You Glow Girl by name in the message
- Starting every message the same way`;

  const toneMap = {
    'Warm & gentle 🤍': 'warm and gentle — soft, encouraging, like a hug in text form',
    'Bold & direct 🔥': 'bold and direct — confident, energizing, a little fire',
    'Spiritual & grounded 🙏': 'spiritual and grounded — faith-forward, peaceful, trusting the bigger picture',
    'Funny & real 😂': 'funny and real — light, witty, makes her smile or laugh but still has heart'
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
Write exactly ONE text message — no more than 3-4 sentences. Do not add any explanation or preamble — just the message itself.`;

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
  if (!response.ok) throw new Error(`Claude API error: ${JSON.stringify(data)}`);

  return data.content?.[0]?.text?.trim() || null;
}

// ── Send SMS via Twilio ───────────────────────────────────────────────────────
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
      body: new URLSearchParams({
        To:   toPhone,
        From: fromPhone,
        Body: message,
      }).toString(),
    }
  );

  const data = await response.json();
  if (!response.ok) throw new Error(`Twilio error: ${data.message || JSON.stringify(data)}`);

  return data.sid; // Twilio message SID for tracking
}

// ── Log message to Supabase ───────────────────────────────────────────────────
async function logMessage(userId, messageText, twilioSid) {
  const { error } = await supabase
    .from('messages')
    .insert({
      user_id: userId,
      message_text: messageText,
      delivered: true,
      twilio_sid: twilioSid || null,
    });

  if (error) console.error('Failed to log message:', error.message);
}

// ── Update user after send ────────────────────────────────────────────────────
async function updateUserAfterSend(userId, currentStreak) {
  const { error } = await supabase
    .from('users')
    .update({
      last_text_sent: new Date().toISOString(),
      streak_count: (currentStreak || 0) + 1,
    })
    .eq('id', userId);

  if (error) console.error('Failed to update user after send:', error.message);
}

// ── Serve Inngest functions ───────────────────────────────────────────────────
export default serve({
  client: inngest,
  functions: [
    dailyMessageScheduler,
    sendSingleMessage,
  ],
});
