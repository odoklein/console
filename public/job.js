// Live checklist: polls the job every 2 s until it ends.
(() => {
  const data = JSON.parse(document.getElementById('job-data').textContent);
  const list = document.getElementById('checklist');
  const log = document.getElementById('log');
  const statusBox = document.getElementById('job-status');
  const errorBox = document.getElementById('job-error');
  let lastLogId = data.lastLogId;
  let hadInvite = false;
  const done = (s) => s === 'succeeded' || s === 'failed' || s === 'canceled';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderSteps(steps) {
    list.replaceChildren(
      ...steps.map((s) => {
        const li = el('li', `step step-${s.result}`);
        li.dataset.id = s.id;
        li.append(el('span', 'step-icon', data.icons[s.result] || ''));
        const body = el('div', 'step-body');
        body.append(el('span', 'step-label', s.label));
        if (s.note) body.append(el('pre', 'step-note', s.note));
        if (s.result === 'failed' && data.hints[s.id]) body.append(el('p', 'step-hint', data.hints[s.id]));
        li.append(body);
        return li;
      }),
    );
  }

  function showActions(status) {
    for (const f of document.querySelectorAll('#job-actions [data-when]')) f.hidden = !f.dataset.when.split(' ').includes(status);
  }

  async function poll() {
    try {
      const res = await fetch(`/jobs/${data.id}/poll?after=${lastLogId}`, { headers: { accept: 'application/json' } });
      if (res.status === 401) return location.assign('/login');
      const j = await res.json();
      renderSteps(j.steps);
      statusBox.replaceChildren(el('span', `pill pill-${j.statusTone}`, j.statusLabel));
      errorBox.hidden = !j.error;
      // Same rule as the server (jobErrorSummary): point at the failed step instead of repeating its error.
      const failed = (j.steps || []).find((s) => s.result === 'failed');
      errorBox.textContent = !j.error ? '' : failed ? `Arrêt à l’étape « ${failed.label} ». La cause et quoi faire sont indiqués ci-dessous, puis « Relancer ».` : j.error;
      showActions(j.status);
      for (const l of j.logs) {
        log.append(`${new Date(l.at).toISOString().slice(11, 19)}  ${l.line}\n`);
        lastLogId = Math.max(lastLogId, l.id);
      }
      // The invite link is rendered server-side only (sealed): reload once when it appears.
      if (j.hasInvite && !hadInvite && !document.querySelector('.invite')) {
        hadInvite = true;
        if (done(j.status)) return location.reload();
      }
      if (!done(j.status)) setTimeout(poll, 2000);
      else if (j.hasInvite && !document.querySelector('.invite')) location.reload();
    } catch {
      setTimeout(poll, 5000);
    }
  }

  if (!done(data.status)) setTimeout(poll, 1000);
})();
