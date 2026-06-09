// api/worker.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    // 1. взять одну queued задачу
    const { data: task, error: selectError } = await supabase
      .from('tasks')
      .select('*')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1)
      .single();

    if (selectError || !task) {
      return res.status(200).json({ message: 'no queued tasks' });
    }

    // 2. пометить processing
    await supabase
      .from('tasks')
      .update({ status: 'processing', attempts: (task.attempts || 0) + 1 })
      .eq('id', task.id);

    const url = task.url;
    if (!url) {
      await supabase
        .from('tasks')
        .update({ status: 'failed', result: { error: 'no url' } })
        .eq('id', task.id);
      return res.status(400).json({ error: 'task has no url' });
    }

    // 3. fetch(url) с таймаутом 60s
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    let html;
    try {
      const response = await fetch(url, { signal: controller.signal });
      html = await response.text();
    } catch (err) {
      clearTimeout(timeout);
      await supabase
        .from('tasks')
        .update({ status: 'failed', result: { error: err.message } })
        .eq('id', task.id);
      return res.status(500).json({ error: 'fetch failed', details: err.message });
    }

    clearTimeout(timeout);

    // 4. сохранить HTML в bucket raw как raw/<id>.html (upsert)
    const path = `raw/${task.id}.html`;
    const { error: uploadError } = await supabase.storage
      .from('raw')
      .upload(path, html, {
        contentType: 'text/html',
        upsert: true
      });

    if (uploadError) {
      await supabase
        .from('tasks')
        .update({ status: 'failed', result: { error: uploadError.message } })
        .eq('id', task.id);
      return res.status(500).json({ error: 'upload failed' });
    }

    // 5. обновить task → done
    await supabase
      .from('tasks')
      .update({
        status: 'done',
        storage_path: path,
        result: { storage_path: path }
      })
      .eq('id', task.id);

    return res.status(200).json({
      message: 'task processed',
      id: task.id,
      storage_path: path
    });
  } catch (e) {
    return res.status(500).json({ error: 'unexpected', details: e.message });
  }
}
