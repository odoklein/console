// Copy buttons, confirm prompts, and one-click guard on every POST form.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const el = document.querySelector(btn.getAttribute('data-copy'));
  if (!el) return;
  navigator.clipboard.writeText(el.textContent.replace(/\s+/g, ' ').trim()).then(() => {
    const label = btn.textContent;
    btn.textContent = 'Copié';
    setTimeout(() => (btn.textContent = label), 1500);
  });
});

document.addEventListener('submit', (e) => {
  const form = e.target;
  const question = form.getAttribute('data-confirm');
  if (question && !window.confirm(question)) {
    e.preventDefault();
    return;
  }
  if (form.method.toLowerCase() === 'post') {
    // A double click must not queue the same operation twice.
    for (const b of form.querySelectorAll('button[type="submit"]')) b.disabled = true;
  }
});
