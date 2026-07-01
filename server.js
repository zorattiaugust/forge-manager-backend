require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { runCoach } = require('./agent-coach');
const { runManager } = require('./agent-manager');
const { callClaude } = require('./claude');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// memoryStorage only — audio must never touch disk (privacy requirement)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.get('/health', (req, res) => res.json({ ok: true }));

async function getAgentMemory(userId, agent) {
  if (!userId) return '';
  const { data } = await supabase.from('user_state').select('data').eq('user_id', userId).single();
  return (data?.data?.[agent + 'Memory']) || '';
}

async function updateAgentMemory(userId, agent, userMessage, agentReply, currentMemory) {
  if (!userId) return;
  try {
    const updated = await callClaude({
      system: `You maintain a compact, always-current memory summary for an AI assistant named ${agent === 'marcus' ? 'Marcus' : 'Rex'}.
Extract and merge key facts about the user: their projects, preferences, communication style, ongoing goals, decisions made, and personal context.
Overwrite outdated info with new info. Keep it under 300 words. Plain bullet points. No fluff.`,
      messages: [{ role: 'user', content: 'Current memory:\n' + (currentMemory || 'none yet') + '\n\nNew exchange:\nUser: ' + userMessage + '\n' + (agent === 'marcus' ? 'Marcus' : 'Rex') + ': ' + agentReply }],
      maxTokens: 400
    });
    const { data } = await supabase.from('user_state').select('data').eq('user_id', userId).single();
    const existing = data?.data || {};
    existing[agent + 'Memory'] = updated;
    await supabase.from('user_state').upsert({ user_id: userId, data: existing, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  } catch (e) {
    console.error('memory update failed:', e.message);
  }
}

// --- Coach: chat + propose logs ---
app.post('/api/coach/message', async (req, res) => {
  try {
    const { message, userId, goalsContext } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const rexMemory = await getAgentMemory(userId, 'rex');

    const { data: recentLogs } = await supabase
      .from('forge_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    const summary = (recentLogs || [])
      .map(l => `${l.log_date} [${l.category}]: ${JSON.stringify(l.payload)}`)
      .join('\n');

    const { data: history } = await supabase
      .from('coach_messages')
      .select('role, content')
      .order('created_at', { ascending: true })
      .limit(40);

    await supabase.from('coach_messages').insert({ role: 'user', content: message });

    const result = await runCoach(message, summary, goalsContext, history || [], rexMemory);

    await supabase.from('coach_messages').insert({ role: 'assistant', content: result.reply });
    updateAgentMemory(userId, 'rex', message, result.reply, rexMemory);

    const pending = [];
    for (const log of result.proposed_logs || []) {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('pending_logs')
        .insert({ log_date: today, category: log.category, payload: log.payload, status: 'pending' })
        .select('id, log_date, category, payload, status')
        .single();
      if (error) {
        console.error('Could not insert pending log:', error.message, log);
      } else {
        pending.push(data);
      }
    }

    res.json({ reply: result.reply, pending });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Coach: confirm or reject a pending log ---
app.post('/api/coach/confirm', async (req, res) => {
  try {
    const { id, approve } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const { data: pending, error: fetchErr } = await supabase
      .from('pending_logs')
      .select('*')
      .eq('id', id)
      .single();
    if (fetchErr || !pending) return res.status(404).json({ error: 'pending log not found' });

    if (approve) {
      await supabase.from('forge_logs').insert({
        log_date: pending.log_date,
        category: pending.category,
        payload: pending.payload
      });
      await supabase.from('pending_logs').update({ status: 'confirmed' }).eq('id', id);
    } else {
      await supabase.from('pending_logs').update({ status: 'rejected' }).eq('id', id);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/coach/pending', async (req, res) => {
  const { data } = await supabase.from('pending_logs').select('*').eq('status', 'pending');
  res.json(data || []);
});

app.get('/api/forge/logs', async (req, res) => {
  const { data } = await supabase.from('forge_logs').select('*').order('log_date', { ascending: false }).limit(100);
  res.json(data || []);
});

// Direct log from Goals tab (no pending step)
app.post('/api/forge/log', async (req, res) => {
  try {
    const { category, payload } = req.body;
    if (!category || !payload) return res.status(400).json({ error: 'category and payload required' });
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from('forge_logs')
      .insert({ log_date: today, category, payload })
      .select('id')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ id: data.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a log
app.delete('/api/forge/log/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('forge_logs')
      .delete()
      .eq('id', Number(req.params.id));
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Manager: business idea conversations ---
app.post('/api/manager/message', async (req, res) => {
  try {
    const { message, userId, threadId, goalsContext, fileData, fileType, fileName } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    let tid = threadId;
    if (!tid) {
      const { data, error } = await supabase
        .from('manager_threads')
        .insert({ title: message.slice(0, 60) })
        .select()
        .single();
      if (error) return res.status(500).json({ error: 'Could not create thread: ' + error.message });
      tid = data.id;
    }

    await supabase.from('manager_messages').insert({ thread_id: tid, role: 'user', content: message });

    const marcusMemory = await getAgentMemory(userId, 'marcus');

    const { data: threadHistory } = await supabase
      .from('manager_messages')
      .select('role, content')
      .eq('thread_id', tid)
      .order('created_at', { ascending: true })
      .limit(40);

    const file = fileData ? { data: fileData, type: fileType || 'application/pdf', name: fileName || 'attachment' } : null;
    const result = await runManager(message, file, goalsContext, threadHistory || [], marcusMemory);

    await supabase.from('manager_messages').insert({ thread_id: tid, role: 'manager', content: result.plan });
    updateAgentMemory(userId, 'marcus', message, result.plan, marcusMemory);
    for (const r of result.results) {
      await supabase.from('manager_messages').insert({
        thread_id: tid,
        role: `agent:${r.specialist}`,
        content: r.answer
      });
    }

    res.json({ threadId: tid, plan: result.plan, results: result.results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/manager/threads', async (req, res) => {
  const { data } = await supabase.from('manager_threads').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});

app.get('/api/manager/threads/:id/messages', async (req, res) => {
  const { data } = await supabase
    .from('manager_messages')
    .select('*')
    .eq('thread_id', req.params.id)
    .order('created_at', { ascending: true });
  res.json(data || []);
});

// --- Full state sync ---
app.get('/api/state/:userId', async (req, res) => {
  try {
    const { data } = await supabase
      .from('user_state')
      .select('data')
      .eq('user_id', req.params.userId)
      .single();
    res.json(data ? data.data : null);
  } catch (e) {
    res.json(null);
  }
});

app.post('/api/state', async (req, res) => {
  try {
    const { userId, data } = req.body;
    if (!userId || !data) return res.status(400).json({ error: 'userId and data required' });
    await supabase.from('user_state').upsert({
      user_id: userId,
      data,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Recommendations
app.post('/api/recommendations', async (req, res) => {
  try {
    const { context } = req.body;
    const system = `You are Forge, a personal performance app. Based on the user's current data, give 4 short personalized recommendations covering: their reading, health habits, workouts, and one general life/mindset tip. Be direct, specific, and motivating. Not generic.

Respond ONLY with a JSON array, no markdown:
[
  { "label": "Reading", "text": "recommendation here" },
  { "label": "Health", "text": "recommendation here" },
  { "label": "Training", "text": "recommendation here" },
  { "label": "Mindset", "text": "recommendation here" }
]`;
    const raw = await callClaude({
      system,
      messages: [{ role: 'user', content: 'My current data:\n' + context }],
      maxTokens: 600
    });
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const recommendations = JSON.parse(cleaned.slice(cleaned.indexOf('['), cleaned.lastIndexOf(']') + 1));
    res.json({ recommendations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Exercise search (wger). wger removed its autocomplete/search endpoint and its
// list endpoints ignore query filters entirely, so we cache the full catalog
// (~859 exercises) and filter it ourselves.
let exerciseCache = { list: [], fetchedAt: 0 };
const EXERCISE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function loadExerciseCache() {
  const now = Date.now();
  if (exerciseCache.list.length && now - exerciseCache.fetchedAt < EXERCISE_CACHE_TTL_MS) {
    return exerciseCache.list;
  }
  const url = 'https://wger.de/api/v2/exerciseinfo/?limit=900&language=2';
  const r = await fetch(url, { headers: { 'User-Agent': 'ForgeApp/1.0' } });
  const data = await r.json();
  const list = (data.results || []).map(ex => {
    const translation = (ex.translations || []).find(t => t.language === 2) || ex.translations?.[0];
    if (!translation) return null;
    return {
      id: ex.id,
      name: translation.name,
      category: ex.category?.name || '',
      muscles: (ex.muscles || []).map(m => m.name_en || m.name).filter(Boolean)
    };
  }).filter(Boolean);
  exerciseCache = { list, fetchedAt: now };
  return list;
}

app.get('/api/exercises/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    if (!q || q.length < 2) return res.json([]);
    const list = await loadExerciseCache();
    const results = list.filter(ex => ex.name.toLowerCase().includes(q)).slice(0, 20);
    res.json(results);
  } catch(e) {
    res.json([]);
  }
});

// Book search proxy (Open Library)
app.get('/api/books/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json([]);
    const url = 'https://openlibrary.org/search.json?q=' + encodeURIComponent(q) + '&limit=6&fields=key,title,author_name,number_of_pages_median,cover_i';
    const r = await fetch(url, { headers: { 'User-Agent': 'ForgeApp/1.0' } });
    const data = await r.json();
    const results = (data.docs || []).map(doc => ({
      id: doc.key || doc.title,
      title: doc.title || 'Unknown',
      author: doc.author_name ? doc.author_name[0] : 'Unknown',
      pages: doc.number_of_pages_median || null,
      cover: doc.cover_i ? 'https://covers.openlibrary.org/b/id/' + doc.cover_i + '-S.jpg' : ''
    }));
    res.json(results);
  } catch (e) {
    console.error('book search error:', e.message);
    res.json([]);
  }
});

app.post('/api/transcribe', (req, res, next) => {
  upload.single('audio')(req, res, (err) => {
    if (err) {
      console.error('transcribe upload error:', err.message);
      return res.json({ text: '', error: 'Upload failed' });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.json({ text: '', error: 'No audio received' });
    const form = new FormData();
    form.append('model_id', 'scribe_v1');
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), 'audio.webm');
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      body: form
    });
    if (!r.ok) {
      const errBody = await r.text();
      console.error('transcribe error:', r.status, errBody);
      return res.json({ text: '', error: 'Transcription failed' });
    }
    const data = await r.json();
    res.json({ text: data.text || '' });
  } catch (e) {
    console.error('transcribe error:', e.message);
    res.json({ text: '', error: 'Transcription failed' });
  }
});

app.post('/api/speak', async (req, res) => {
  try {
    const { text, agent } = req.body;
    if (!text || !agent) return res.status(400).json({ error: 'text and agent required' });
    const voiceId = agent === 'rex' ? process.env.ELEVENLABS_VOICE_REX
      : agent === 'marcus' ? process.env.ELEVENLABS_VOICE_MARCUS
      : null;
    if (!voiceId) return res.status(400).json({ error: 'Unknown agent' });
    const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' })
    });
    if (!r.ok) {
      const errBody = await r.text();
      console.error('speak error:', r.status, errBody);
      return res.status(502).json({ error: 'Speech generation failed' });
    }
    const audioBuffer = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch (e) {
    console.error('speak error:', e.message);
    res.status(500).json({ error: 'Speech generation failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
