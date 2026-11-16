// « Nouveautés » editors: notes list (add, remove, reorder), live CRM preview, announcement targeting.
// The forms work without this file; it only makes editing and checking easier.
(() => {
  const labels = (() => {
    try { return JSON.parse(document.getElementById('nw-labels')?.textContent || '{}'); } catch { return {}; }
  })();
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---------- release notes ----------
  const list = $('[data-notes]');
  const tpl = $('#nw-note-template');
  const renumber = () => {
    if (!list) return;
    const rows = $$('[data-note]', list);
    rows.forEach((row, i) => {
      for (const el of $$('[aria-label]', row)) el.setAttribute('aria-label', el.getAttribute('aria-label').replace(/\d+$/, String(i + 1)));
      $('[data-move="-1"]', row).disabled = i === 0;
      $('[data-move="1"]', row).disabled = i === rows.length - 1;
    });
    const count = $('[data-count]');
    if (count) count.textContent = String(rows.filter((r) => $('.nw-note-title', r).value.trim()).length);
  };
  const tint = (select) => {
    select.className = select.className.replace(/\bnw-(new|improved|fixed)\b/g, '').trim() + ` nw-${select.value}`;
  };
  if (list && tpl) {
    $('[data-add]')?.addEventListener('click', () => {
      list.appendChild(tpl.content.cloneNode(true));
      const last = $$('[data-note]', list).pop();
      $('.nw-note-title', last).focus();
      renumber();
      preview();
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-note]');
      if (!row) return;
      const move = e.target.closest('[data-move]');
      if (move) {
        const dir = Number(move.dataset.move);
        const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
        if (sib) dir < 0 ? list.insertBefore(row, sib) : list.insertBefore(sib, row);
        move.focus();
      }
      if (e.target.closest('[data-remove]')) {
        const next = row.nextElementSibling || row.previousElementSibling;
        if ($$('[data-note]', list).length === 1) for (const f of $$('input, textarea', row)) f.value = '';
        else row.remove();
        $('.nw-note-title', next || list)?.focus();
      }
      renumber();
      preview();
    });
    list.addEventListener('change', (e) => {
      if (e.target.matches('.nw-type')) tint(e.target);
      preview();
    });
    $$('.nw-type', list).forEach(tint);
    renumber();
  }

  // ---------- announcement targeting ----------
  for (const radio of $$('[data-target-mode]')) {
    radio.addEventListener('change', () => {
      for (const panel of $$('[data-target-panel]')) panel.hidden = panel.dataset.targetPanel !== radio.value;
    });
  }

  // ---------- live preview ----------
  const out = (name) => $$(`[data-pv-out="${name}"]`);
  const field = (name) => $(`[data-pv="${name}"]`);
  const fmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const when = () => {
    const s = field('start')?.value, e = field('end')?.value;
    const d = (v) => fmt.format(new Date(v));
    if (s && e) return `${d(s)} → ${d(e)}`;
    if (s) return `à partir du ${d(s)}`;
    if (e) return `jusqu’au ${d(e)}`;
    return '';
  };

  function preview() {
    const title = field('title')?.value.trim();
    for (const el of out('title')) el.textContent = title || (list ? 'Sans titre' : 'Titre de l’annonce');
    const summary = field('summary')?.value.trim() || '';
    for (const el of out('summary')) { el.textContent = summary; el.hidden = !summary; }

    if (list) {
      const notes = $$('[data-note]', list)
        .map((r) => ({ type: $('.nw-type', r).value, title: $('.nw-note-title', r).value.trim(), module: $('.nw-note-module', r).value.trim(), body: $('textarea', r).value.trim() }))
        .filter((n) => n.title);
      const groups = ['new', 'improved', 'fixed']
        .map((t) => ({ t, notes: notes.filter((n) => n.type === t) }))
        .filter((g) => g.notes.length);
      for (const el of out('notes')) {
        el.innerHTML = groups.length
          ? groups.map((g) => `<section class="nw-crm-group"><h4 class="nw-crm-type nw-${g.t}">${esc(labels[g.t] || g.t)}</h4><ul>${g.notes
              .map((n) => `<li><span class="nw-crm-note">${esc(n.title)}</span>${n.module ? ` <span class="nw-crm-module">${esc(n.module)}</span>` : ''}${n.body ? `<p>${esc(n.body)}</p>` : ''}</li>`)
              .join('')}</ul></section>`).join('')
          : '<p class="nw-crm-empty">Les notes apparaîtront ici.</p>';
      }
    }

    const kind = $('input[name="kind"]:checked');
    if (kind) for (const el of out('kind')) { el.textContent = labels[kind.value] || kind.value; el.dataset.kind = kind.value; }
    const w = when();
    for (const el of out('when')) { el.textContent = w ? (el.closest('.nw-crm-banner') ? ` · ${w}` : w) : ''; el.hidden = !w && !el.closest('.nw-crm-banner'); }
    const cta = field('cta')?.value.trim();
    for (const el of out('cta')) { el.textContent = cta || ''; el.hidden = !cta; }
    const warn = field('severity');
    if (warn) {
      const banner = $('[data-preview="banner"]');
      if (banner) banner.hidden = !warn.checked;
      $('[data-preview="announcement"]')?.classList.toggle('is-warning', warn.checked);
    }
  }

  document.addEventListener('input', (e) => {
    if (e.target.closest('[data-pv], [data-notes]')) preview();
  });
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-pv]')) preview();
  });
  preview();
})();
