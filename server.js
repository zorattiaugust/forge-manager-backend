require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { runCoach } = require('./agent-coach');
const { runManager } = require('./agent-manager');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.get('/health', (req, res) => res.json({ ok: true }));

// --- Coach: chat + propose logs ---
app.post('/api/coach/message', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const { data: recentLogs } = await supabase
      .from('forge_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    const summary = (recentLogs || [])
      .map(l => `${l.log_date} [${l.category}]: ${JSON.stringify(l.payload)}`)
      .join('\n');

    await supabase.from('coach_messages').insert({ role: 'user', content: message });

    const result = await runCoach(message, summary);

    await supabase.from('coach_messages').insert({ role: 'assistant', content: result.reply });

    const pendingIds = [];
    for (const log of result.proposed_logs || []) {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('pending_logs')
        .insert({ log_date: today, category: log.category, payload: log.payload, status: 'pending' })
        .select()
        .single();
      if (!error) pendingIds.push(data.id);
    }

    res.json({ reply: result.reply, pending: pendingIds });
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

// --- Manager: business idea conversations ---
app.post('/api/manager/message', async (req, res) => {
  try {
    const { message, threadId } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    let tid = threadId;
    if (!tid) {
      const { data } = await supabase
        .from('manager_threads')
        .insert({ title: message.slice(0, 60) })
        .select()
        .single();
      tid = data.id;
    }

    await supabase.from('manager_messages').insert({ thread_id: tid, role: 'user', content: message });

    const result = await runManager(message);

    await supabase.from('manager_messages').insert({ thread_id: tid, role: 'manager', content: result.plan });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
