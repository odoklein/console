// Support inbox: keyboard shortcuts, drafts kept per ticket, canned replies, auto-submitted
// selects and a "new changes" banner. The page works without it; this only makes it faster.
(() => {
  const data = JSON.parse(document.getElementById('support-data')?.textContent || '{}');
  const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  // ---------- selects submit their form ----------
  for (const form of document.querySelectorAll('form[data-autosubmit]')) {
    for (const sel of form.querySelectorAll('select')) sel.addEventListener('change', () => form.requestSubmit());
  }

  // ---------- the list: keep the open ticket in sight, j/k to move ----------
  const rows = [...document.querySelectorAll('[data-row]')];
  const active = document.querySelector('.tk.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });

  function move(step) {
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement.closest?.('[data-row]') || active);
    const next = rows[Math.min(rows.length - 1, Math.max(0, i < 0 ? 0 : i + step))];
    if (next) next.focus();
  }

  // ---------- the thread: start at the latest message ----------
  const scroller = document.querySelector('[data-thread]');
  const threadEl = document.getElementById('thread');
  if (scroller && threadEl) scroller.scrollTop = threadEl.offsetTop + threadEl.offsetHeight - scroller.clientHeight + 40;

  // ---------- composer ----------
  const composer = document.querySelector('form[data-composer]');
  const reply = composer?.querySelector('[data-reply]');
  if (composer && reply) {
    const key = `support-draft:${composer.dataset.key}`;
    if (data.sent) store.set(key, null);
    else if (!reply.value && store.get(key)) reply.value = store.get(key);
    const grow = () => {
      reply.style.height = 'auto';
      reply.style.height = `${Math.min(reply.scrollHeight + 2, window.innerHeight * 0.4)}px`;
    };
    grow();
    reply.addEventListener('input', () => {
      store.set(key, reply.value.trim() ? reply.value : null);
      grow();
    });
    reply.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        composer.requestSubmit();
      }
      if (e.key === 'Escape') reply.blur();
    });
    composer.addEventListener('submit', (e) => {
      const status = composer.querySelector('select[name="status"]');
      if (!reply.value.trim() && !(status && status.value)) {
        e.preventDefault();
        reply.focus();
        return;
      }
      const btn = composer.querySelector('button[type="submit"]');
      if (btn) btn.textContent = 'Envoi…';
    });

    const macros = JSON.parse(document.getElementById('macros-data')?.textContent || '{}');
    const picker = composer.querySelector('[data-macro]');
    picker?.addEventListener('change', () => {
      const text = macros[picker.value];
      picker.value = '';
      if (!text) return;
      const { selectionStart: a, selectionEnd: b, value } = reply;
      const before = value.slice(0, a);
      const glue = before && !before.endsWith('\n') ? '\n' : '';
      reply.value = before + glue + text + value.slice(b);
      reply.focus();
      reply.selectionStart = reply.selectionEnd = (before + glue + text).length;
      reply.dispatchEvent(new Event('input'));
    });
  }

  // The "Envoyé" notice is for this view only: a reload must not show it again.
  if (data.sent) {
    const url = new URL(location.href);
    url.searchParams.delete('sent');
    history.replaceState(null, '', url);
  }

  // ---------- shortcuts ----------
  const search = document.querySelector('[data-search]');
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || typing(document.activeElement)) return;
    if (e.key === '/' && search) {
      e.preventDefault();
      search.focus();
      search.select();
    } else if (e.key === 'j' || e.key === 'ArrowDown') {
      if (e.key === 'ArrowDown' && !document.activeElement.closest?.('[data-row]')) return;
      e.preventDefault();
      move(1);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      if (e.key === 'ArrowUp' && !document.activeElement.closest?.('[data-row]')) return;
      e.preventDefault();
      move(-1);
    } else if (e.key === 'r' && reply) {
      e.preventDefault();
      reply.focus();
    }
  });

  // ---------- something changed since the page was drawn ----------
  const fresh = document.getElementById('ib-fresh');
  const badge = document.getElementById('nav-support-badge');
  async function poll() {
    if (document.hidden) return;
    try {
      const res = await fetch(`/support/poll?since=${encodeURIComponent(data.latest || 0)}`, { headers: { accept: 'application/json' } });
      if (res.status === 401) return location.assign('/login');
      const j = await res.json();
      if (fresh && j.changed) fresh.hidden = false;
      if (badge) {
        badge.textContent = String(j.unread);
        badge.hidden = !j.unread;
      }
    } catch {
      /* offline for a moment: next round */
    }
  }
  fresh?.querySelector('[data-reload]')?.addEventListener('click', (e) => {
    e.preventDefault();
    location.reload();
  });
  setInterval(poll, 45_000);
  document.addEventListener('visibilitychange', () => !document.hidden && poll());
})();
