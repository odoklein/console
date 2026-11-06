// "Nouvelle agence": step navigation, slug from the name, pack defaults, live brand preview, recap.
(() => {
  const form = document.getElementById('wizard');
  const data = JSON.parse(document.getElementById('wizard-data').textContent);
  const $ = (sel, root = form) => root.querySelector(sel);
  const $$ = (sel, root = form) => [...root.querySelectorAll(sel)];
  const field = (name) => form.elements.namedItem(name);
  let step = 1;

  // ---------- steps ----------
  function show(n) {
    step = n;
    for (const p of $$('[data-panel]')) p.hidden = Number(p.dataset.panel) !== n;
    for (const li of $$('.wizard-steps li')) {
      const s = Number(li.dataset.step);
      li.classList.toggle('is-current', s === n);
      li.classList.toggle('is-done', s < n);
    }
    $('[data-prev]').hidden = n === 1;
    $('[data-next]').hidden = n === 5;
    $('[data-submit]').hidden = n !== 5;
    if (n === 5) recap();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function panelValid(n) {
    const panel = $(`[data-panel="${n}"]`);
    for (const input of $$('input, select', panel)) {
      if (input.closest('[hidden]') && input.closest('[hidden]') !== panel) continue;
      if (!input.checkValidity()) {
        input.reportValidity();
        return false;
      }
    }
    if (n === 1 && slugState.taken) {
      field('slug').setCustomValidity(slugState.reason || 'Nom court indisponible');
      field('slug').reportValidity();
      return false;
    }
    if (n === 3 && field('addressMode').value === 'own' && !field('domain').value.trim()) {
      field('domain').setCustomValidity('Indiquez le domaine');
      field('domain').reportValidity();
      return false;
    }
    return true;
  }
  $('[data-next]').addEventListener('click', () => panelValid(step) && show(step + 1));
  $('[data-prev]').addEventListener('click', () => show(step - 1));
  form.addEventListener('submit', (e) => {
    for (let n = 1; n <= 4; n++) {
      if (!panelValid(n)) {
        e.preventDefault();
        show(n);
        panelValid(n);
        return;
      }
    }
  });
  form.addEventListener('input', (e) => e.target.setCustomValidity && e.target.setCustomValidity(''));

  // ---------- slug ----------
  const slugState = { edited: !!field('slug').value, taken: false, reason: '' };
  const slugify = (s) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/, '');
  let slugTimer;
  function checkSlug() {
    const slug = field('slug').value.trim();
    for (const el of $$('[data-slug-host]')) el.textContent = `${slug || 'nom-court'}.${data.platformDomain}`;
    clearTimeout(slugTimer);
    if (!slug) return;
    slugTimer = setTimeout(async () => {
      const res = await fetch(`/api/slug?slug=${encodeURIComponent(slug)}`);
      const j = await res.json();
      slugState.taken = !j.available;
      slugState.reason = j.reason || '';
      const help = document.getElementById('slug-help');
      help.textContent = j.available ? `Disponible : ${j.host}` : `Indisponible : ${j.reason}`;
      help.className = j.available ? 'text-ok' : 'text-danger';
    }, 300);
  }
  field('name').addEventListener('input', () => {
    if (!slugState.edited) field('slug').value = slugify(field('name').value);
    checkSlug();
    preview();
  });
  field('slug').addEventListener('input', () => {
    slugState.edited = true;
    checkSlug();
  });
  if (field('slug').value) checkSlug();

  // ---------- address ----------
  function address() {
    const own = form.querySelector('input[name="addressMode"]:checked')?.value === 'own';
    $('.own-domain').hidden = !own;
    for (const el of $$('[data-domain]')) el.textContent = field('domain').value.trim() || 'crm.agence.fr';
  }
  for (const r of $$('input[name="addressMode"]')) r.addEventListener('change', address);
  field('domain').addEventListener('input', address);

  // ---------- pack ----------
  function applyPack(force) {
    const id = form.querySelector('input[name="pack"]:checked')?.value;
    const pack = data.packs.find((p) => p.id === id);
    if (!pack) return;
    if (force || !field('seatLimit').value) field('seatLimit').value = pack.seats ?? '';
    if (force || !field('aiMonthlyQuota').value) field('aiMonthlyQuota').value = pack.aiMonthlyQuota ?? '';
    for (const [k, v] of Object.entries(pack.features)) {
      const box = field(`feature_${k}`);
      if (box) box.checked = v;
    }
  }
  for (const r of $$('input[name="pack"]')) r.addEventListener('change', () => applyPack(true));
  if (form.dataset.fresh === '1') applyPack(true);

  // ---------- brand preview ----------
  const pv = document.getElementById('brand-preview');
  function lum(hex) {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  const contrast = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  function preview() {
    const primary = field('primaryColor').value;
    const accent = field('accentColor').value;
    pv.style.setProperty('--pv-primary', primary);
    pv.style.setProperty('--pv-accent', accent);
    const ink = contrast(primary, '#ffffff') >= contrast(primary, '#17202b') ? '#ffffff' : '#17202b';
    pv.style.setProperty('--pv-ink', ink);
    for (const el of $$('[data-echo]')) el.textContent = field(el.dataset.echo).value.toUpperCase();
    const font = data.fonts.find((f) => f.id === field('fontPreset').value);
    pv.style.fontFamily = font ? font.css : '';
    const warn = [];
    if (contrast(primary, ink) < 4.5) warn.push(`Texte peu lisible sur la couleur principale (contraste ${contrast(primary, ink).toFixed(1)}:1, 4,5 conseillé).`);
    if (contrast(accent, '#ffffff') < 3) warn.push(`Boutons d’accent peu lisibles (contraste ${contrast(accent, '#ffffff').toFixed(1)}:1 avec le blanc, 3 conseillé).`);
    const box = document.getElementById('contrast-warning');
    box.hidden = !warn.length;
    box.textContent = warn.join(' ');
    const name = field('name').value || 'Agence';
    for (const el of $$('[data-pv]', pv)) if (!el.querySelector('img')) el.textContent = name;
  }
  for (const n of ['primaryColor', 'accentColor', 'fontPreset']) field(n).addEventListener('input', preview);
  for (const input of $$('input[data-logo]')) {
    input.addEventListener('change', () => {
      const file = input.files[0];
      const target = input.dataset.logo === 'full' ? 'logo' : input.dataset.logo === 'fullInverse' ? 'logo-inverse' : null;
      if (file && file.size > 1048576) {
        input.setCustomValidity('1 Mo maximum');
        input.reportValidity();
        input.value = '';
        return;
      }
      input.setCustomValidity('');
      if (!target) return;
      const el = $(`[data-pv="${target}"]`, pv);
      if (!file) return preview();
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = '';
      el.replaceChildren(img);
    });
  }
  preview();
  address();

  // ---------- recap ----------
  function recap() {
    const v = (n) => (field(n)?.value || '').trim();
    const own = form.querySelector('input[name="addressMode"]:checked')?.value === 'own';
    const pack = data.packs.find((p) => p.id === form.querySelector('input[name="pack"]:checked')?.value);
    const features = Object.entries(data.featureLabels).filter(([k]) => field(`feature_${k}`)?.checked).map(([, l]) => l);
    const logos = $$('input[data-logo]').filter((i) => i.files.length).length;
    const rows = [
      ['Agence', `${v('name')} (${v('slug')})`],
      ['Manager', `${v('managerName')} <${v('managerEmail')}>`],
      ['Adresse', `https://${v('slug')}.${data.platformDomain}${own ? `, puis https://${v('domain')} quand le DNS sera prêt` : ''}`],
      ['Marque', `${v('primaryColor').toUpperCase()} / ${v('accentColor').toUpperCase()}, ${logos} logo(s)`],
      ['Offre', `${pack ? pack.label : '—'}, ${v('seatLimit') || 'illimité'} utilisateurs${features.length ? `, ${features.join(', ')}` : ''}`],
      ['Facturation', v('billingEmail') || '—'],
    ];
    document.getElementById('recap').replaceChildren(
      ...rows.flatMap(([k, val]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = val;
        return [dt, dd];
      }),
    );
  }

  show(1);
})();
