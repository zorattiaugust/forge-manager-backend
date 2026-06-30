async function callClaude({ system, messages, maxTokens = 800 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set on the server');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Claude API error');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return text;
}

module.exports = { callClaude };
