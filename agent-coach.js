const { callClaude } = require('./claude');

const COACH_SYSTEM = `Your name is Rex. You are Forge's Coach — tough-love gym coach who actually has your back.
Talk like a real person: direct, blunt, occasionally dry or funny, never corporate. No "I'd be happy to help," no "Great question," no filler. Short punchy sentences. Contractions. Call out slacking when you see it but stay in their corner.

Your job is logging the user's day: workouts, exercises, runs, meals, supplements, water, reading, and budget.
You do not handle business ideas — that is the Manager's job. If asked, redirect them.

LOGGING RULES — read these carefully:
1. When the user mentions multiple things in one message, log ALL of them in one response. Do not ask follow-up questions for simple items. Ice cream + water = two entries in proposed_logs, done.
2. For meals, capture what they said in the text field. Do not ask about macros or exact weights. If they say "ice cream" just log { "text": "ice cream" }. Only ask a follow-up if the meal is completely vague like "ate something."
3. Water is always just cups: { "cups": 1 } per cup mentioned or implied.
4. Never split one message into multiple back-and-forths. One message = one JSON reply with everything logged.
5. The only time to ask a follow-up is when you genuinely cannot guess the category or amount.

When the user describes something to log, respond ONLY with a JSON object, no markdown, no extra text:
{ "reply": "short reply in your voice confirming what you got", "proposed_logs": [ { "category": "workout|exercise|run|meal|supplement|water|reading|budget", "payload": {} } ] }

If nothing to log:
{ "reply": "your conversational answer", "proposed_logs": [] }

Payload shapes:
exercise: { "name": "bench press", "weight": 135, "reps": 10, "sets": 4 }
run: { "dist": 2, "mins": 18 }
meal: { "text": "ice cream" }
supplement: { "name": "creatine" }
water: { "cups": 1 }
reading: { "pages": 20 }
budget: { "amount": 12.50, "note": "lunch" }
workout: { "split": "chest_tri" }

Never invent data the user did not mention. Keep replies 1 to 2 sentences max.`;

function extractJsonObject(text) {
  if (!text) throw new Error('Empty model response');
  var cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    var first = cleaned.indexOf('{');
    var last = cleaned.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) throw new Error('No JSON found');
    return JSON.parse(cleaned.slice(first, last + 1));
  }
}

var VALID_CATEGORIES = new Set([
  'workout', 'exercise', 'run', 'meal', 'supplement', 'water', 'reading', 'budget'
]);

function normalizeCoachResult(parsed) {
  var reply = (typeof parsed.reply === 'string' && parsed.reply.trim())
    ? parsed.reply.trim()
    : 'Got it. Try again if that did not look right.';

  var proposed_logs = Array.isArray(parsed.proposed_logs)
    ? parsed.proposed_logs
        .filter(function(log) {
          return log &&
            VALID_CATEGORIES.has(log.category) &&
            log.payload &&
            typeof log.payload === 'object' &&
            !Array.isArray(log.payload);
        })
        .map(function(log) {
          return { category: log.category, payload: log.payload };
        })
    : [];

  return { reply: reply, proposed_logs: proposed_logs };
}

async function runCoach(userMessage, recentForgeSummary, goalsContext, history, memory) {
  var context = recentForgeSummary || 'none yet';
  var goals = goalsContext ? '\n\nCurrent state:\n' + goalsContext : '';
  var systemContext = 'Recent logged data:\n' + context + goals;

  var messages = [];

  // Inject historical context as first system-style user/assistant pair if no history yet
  if (!history || history.length === 0) {
    messages.push({ role: 'user', content: systemContext + '\n\nHey.' });
    messages.push({ role: 'assistant', content: 'Got it. What\'s up?' });
  } else {
    // Prepend context to the first user message in history
    var first = history[0];
    messages.push({ role: 'user', content: systemContext + '\n\n' + first.content });
    for (var i = 1; i < history.length; i++) {
      messages.push({ role: history[i].role === 'user' ? 'user' : 'assistant', content: history[i].content });
    }
  }

  messages.push({ role: 'user', content: userMessage + '\n\nReturn only valid JSON. No markdown.' });

  var systemWithMemory = memory
    ? COACH_SYSTEM + '\n\nWhat you know about this person:\n' + memory
    : COACH_SYSTEM;

  var raw = await callClaude({
    system: systemWithMemory,
    messages: messages,
    maxTokens: 600
  });

  try {
    var parsed = extractJsonObject(raw);
    return normalizeCoachResult(parsed);
  } catch (e) {
    console.error('Coach parse failed:', e.message, raw);
    return {
      reply: 'Could not parse that. Try again.',
      proposed_logs: []
    };
  }
}

module.exports = { runCoach };
