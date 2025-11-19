// app-index.js - moved from inline script in index.html
// Toast helper — displays transient messages in #toasts
const toasts = document.getElementById('toasts') || (function createToasts() {
  const el = document.createElement('div');
  el.id = 'toasts';
  el.className = 'toast-wrap';
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
  return el;
})();

function showToast(message, type = 'info', timeout = 2200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  // entrance
  el.style.opacity = '0';
  el.style.transform = 'translateY(6px) scale(.98)';
  toasts.appendChild(el);
  requestAnimationFrame(() => {
    el.style.transition = 'opacity 220ms ease, transform 220ms ease';
    el.style.opacity = '1';
    el.style.transform = 'translateY(0) scale(1)';
  });
  // auto-hide
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px) scale(.98)';
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

const form = document.getElementById('hostForm');
const result = document.getElementById('result');
const openViewerBtn = document.getElementById('openViewerBtn');
if (openViewerBtn) openViewerBtn.addEventListener('click', () => { location.href = '/view'; });

function makeCopyButton(text) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.textContent = 'Copy';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
      showToast('Copied to clipboard', 'success');
      setTimeout(() => btn.textContent = 'Copy', 1500);
    } catch (e) {
      showToast('Copy failed — select and copy manually', 'error');
      try { window.prompt('Copy the text below', text); } catch (_) {}
    }
  });
  return btn;
}

if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    result.innerHTML = '<div class="muted">Hosting…</div>';
    const data = new FormData(form);
    try {
      const res = await fetch('/api/host', { method: 'POST', body: data });
      const json = await res.json();
      if (!json || !json.success) {
        result.innerHTML = `<pre>${JSON.stringify(json, null, 2)}</pre>`;
        return;
      }
      result.innerHTML = '';
      const info = document.createElement('div');
      info.innerHTML = `<div><strong style="color:#fff">Hosted:</strong> <span class="muted">${json.id}</span></div>`;

      const kpdiv = document.createElement('div');
      kpdiv.style.marginTop = '10px';
      kpdiv.innerHTML = `<div class="muted">Keyphrase</div><div style="font-weight:700;color:#fff">${json.keyphrase}</div>`;
      kpdiv.appendChild(makeCopyButton(json.keyphrase));

      const pcdiv = document.createElement('div');
      pcdiv.style.marginTop = '10px';
      pcdiv.innerHTML = `<div class="muted">Passcode</div><div style="font-weight:700;color:#fff">${json.passcode}</div>`;
      pcdiv.appendChild(makeCopyButton(json.passcode));

      const shareDiv = document.createElement('div');
      shareDiv.className = 'share-link';
      const shareAnchor = document.createElement('a');
      shareAnchor.href = json.shareUrl;
      shareAnchor.textContent = json.shareUrl;
      shareAnchor.target = '_blank';
      shareAnchor.style.color = 'var(--accent-2)';
      shareDiv.appendChild(shareAnchor);
      shareDiv.appendChild(makeCopyButton(json.shareUrl));

      info.appendChild(kpdiv);
      info.appendChild(pcdiv);
      info.appendChild(shareDiv);
      result.appendChild(info);
    } catch (err) {
      result.innerHTML = `<pre>Upload failed: ${err.message}</pre>`;
    }
  });
}
