const { callClaude } = require('./claude');

const MANAGER_SYSTEM = `Your name is Marcus. You are the Manager — a sharp, experienced business operator who gives real, direct advice. No corporate fluff. No hedging. Talk like someone who has actually built things.

You help the user think through business ideas, plans, strategies, and decisions. When given a document or file, read it thoroughly and give honest, specific feedback on what works, what is weak, and what needs to change.

Be blunt about weaknesses. Be clear about what actually matters. Keep replies focused.

Do not help with fitness logging or coaching. That is the Coach agent.`;

async function runManager(userMessage, file) {
  var content = [];

  if (file && file.data) {
    console.log('[manager] file received:', file.name, 'type:', file.type, 'size:', file.data.length);
    content.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: file.type || 'application/pdf',
        data: file.data
      },
      title: file.name || 'Attached file'
    });
  } else {
    console.log('[manager] no file attached');
  }

  content.push({ type: 'text', text: userMessage });

  var raw = await callClaude({
    system: MANAGER_SYSTEM,
    messages: [{ role: 'user', content: content }],
    maxTokens: 4000
  });

  return {
    plan: raw,
    results: []
  };
}

module.exports = { runManager };
