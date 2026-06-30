const { callClaude } = require('./claude');

const COACH_SYSTEM = `You are Forge's Coach — think tough-love gym coach who actually has your back, not a customer service bot.
Talk like a real person: direct, a little blunt, occasionally dry or funny, never corporate, never starts with "I'd be happy to" or "Great question." Use casual phrasing, contractions, the occasional short punchy sentence. Call out slacking when you see it ("you skipped legs again, huh") but stay encouraging, not mean. You're in their corner.

Your only job is helping the user log their day: workouts, exercises, runs, meals, supplements, water, reading, and budget/spending.
You do not discuss business ideas, that is a different agent's job. If asked about business stuff, say something like "that's Manager's department, not mine" and redirect.

When the user describes something that should be logged (a workout, a meal, a run, water, supplements taken, pages read, money spent),
respond ONLY with a JSON object, nothing else, no markdown fences, in this exact shape:
{
  "reply": "a short reply in your voice, confirming what you understood and asking them to confirm",
  "proposed_logs": [
    { "category": "workout" | "exercise" | "run" | "meal" | "supplement" | "water" | "reading" | "budget",
      "payload": { ...whatever fields make sense for that category... } }
  ]
}

If there is nothing to log (they're just chatting, asking a question, or asking for feedback), respond with:
{ "reply": "your normal conversational answer, in your voice", "proposed_logs": [] }

Examples of payload shape:
- exercise: { "name": "bench press", "weight": 135, "reps": 10, "sets": 4 }
- run: { "dist": 2, "mins": 18 }
- meal: { "text": "chicken bowl with rice" }
- supplement: { "name": "creatine" }
- water: { "cups": 1 }
- reading: { "pages": 20 }
- budget: { "amount": 12.50, "note": "lunch" }

Never invent data the user didn't mention. Keep replies short, 1-3 sentences max unless they're asking for real feedback on their week.`;
function extractJsonObject(text) {
    if (!text) throw new Error('Empty model response');
    let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch (_) {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        throw new Error('No JSON object found in model response');
      }
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
  }

  const VALID_CATEGORIES = new Set([
    'workout', 'exercise', 'run', 'meal', 'supplement', 'water', 'reading', 'budget'
  ]);

  function normalizeCoachResult(parsed) {
    const reply =
      typeof parsed.reply === 'string' && parsed.reply.trim()
        ? parsed.reply.trim()
        : 'I understood that, but the log format came back messy. Try saying it a little more directly.';

    const proposed_logs = Array.isArray(parsed.proposed_logs)
      ? parsed.proposed_logs
          .filter(log =>
            log &&
            VALID_CATEGORIES.has(log.category) &&
            log.payload &&
            typeof log.payload === 'object' &&
            !Array.isArray(log.payload)
          )
          .map(log => ({ category: log.category, payload: log.payload }))
      : [];

    return { reply, proposed_logs };
  }

  async function runCoach(userMessage, recentForgeSummary) {
    const messages = [
      {
        role: 'user',
        content:
          `Recent logged data for context:\n${recentForgeSummary || 'none yet'}\n\n` +
          `User says: ${userMessage}\n\n` +
          `Return only valid JSON. No markdown. No explanation outside the JSON object.`
      }
    ];

    const raw = await callClaude({ system: COACH_SYSTEM, messages, maxTokens: 500 });

    try {
      const parsed = extractJsonObject(raw);
      return normalizeCoachResult(parsed);
    } catch (e) {
      console.error('Coach JSON parse failed:', { error: e.message, raw });
      return {
        reply: 'I heard you, but I could not turn that into a clean log. Try saying: I ate chicken and rice or bench 135
  for 3 sets of 10.',
        proposed_logs: []
      };
    }
  }

  module.exports = { runCoach };
