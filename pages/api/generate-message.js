// pages/api/generate-message.js
// Calls the Claude API to generate a personalized daily text message
// for a YGG subscriber based on their profile.
// This is called by the daily scheduler (Inngest) each morning.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, goals, tone, relationship_status, kids, life_stage } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'User profile is required' });
  }

  // ── Build the system prompt ───────────────────────────────────────────────
  // This defines the YGG voice and persona for Claude
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

WHAT MAKES A GREAT YGG MESSAGE:
- It feels like it was written specifically for her, not for "women in general"
- It meets her where she actually is — her real life, not an aspirational version of it
- It asks nothing of her — no calls to action, no "now go do this"
- It lands and lets go — she reads it, feels something, moves on with her day
- It's the kind of thing she'd screenshot and send to a friend

WHAT TO AVOID:
- Generic affirmations ("You are enough!" "Believe in yourself!")
- Rhyming or sing-song language
- Overly long messages
- Mentioning You Glow Girl by name in the message
- Starting every message the same way
- Sounding like a motivational poster`;

  // ── Build the user prompt ─────────────────────────────────────────────────
  // This passes the subscriber's profile to Claude
  const userPrompt = buildUserPrompt({
    name,
    goals,
    tone,
    relationship_status,
    kids,
    life_stage
  });

  // ── Call the Claude API ───────────────────────────────────────────────────
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // Fast and cost-effective — ~$0.0006/message
        max_tokens: 150, // Keeps messages short — a real text message length
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userPrompt
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Claude API error:', data);
      return res.status(500).json({ error: 'Failed to generate message' });
    }

    const message = data.content?.[0]?.text?.trim();

    if (!message) {
      return res.status(500).json({ error: 'No message returned from Claude' });
    }

    return res.status(200).json({ message });

  } catch (err) {
    console.error('Message generation error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Build user prompt from profile ───────────────────────────────────────────
// Constructs a natural language description of the user for Claude to work with
function buildUserPrompt({ name, goals, tone, relationship_status, kids, life_stage }) {

  // Map tone preference to instruction
  const toneMap = {
    'Warm & gentle 🤍': 'warm and gentle — soft, encouraging, like a hug in text form',
    'Bold & direct 🔥': 'bold and direct — confident, energizing, a little fire',
    'Spiritual & grounded 🙏': 'spiritual and grounded — faith-forward, peaceful, trusting the bigger picture',
    'Funny & real 😂': 'funny and real — light, witty, makes her smile or laugh but still has heart'
  };

  const toneInstruction = toneMap[tone] || 'warm and genuine';

  // Build life context string
  const lifeContext = [];

  if (relationship_status && relationship_status !== 'Not specified') {
    lifeContext.push(`relationship status: ${relationship_status}`);
  }

  if (kids && kids !== 'Not specified') {
    lifeContext.push(`kids: ${kids}`);
  }

  if (life_stage && life_stage !== 'N/A') {
    lifeContext.push(`youngest child stage: ${life_stage}`);
  }

  // Build goals string
  const goalsText = Array.isArray(goals)
    ? goals.join(', ')
    : (goals || 'daily peace of mind');

  const lifeContextText = lifeContext.length > 0
    ? `Her life context: ${lifeContext.join(', ')}.`
    : '';

  return `Write a single personalized morning text message for ${name}.

${lifeContextText}
Her current goals and focus areas: ${goalsText}.
Her preferred tone: ${toneInstruction}.

Write exactly ONE text message — no more than 3-4 sentences — in the YGG BFF voice. Make it feel like it was written specifically for her life right now. Do not add any explanation, label, or preamble — just the message itself.`;
}
