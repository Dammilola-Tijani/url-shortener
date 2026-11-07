// Minimal landing page so visitors (and reviewers) can try the service in a browser.
// Output is built with textContent/DOM APIs, never innerHTML, so server data can't inject markup.
export const landingPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>URL Shortener</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 620px; margin: 3rem auto; padding: 0 1rem; color: #1f1f1f; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  p.sub { color: #555; margin-top: 0; }
  form { display: flex; gap: 8px; margin: 1.5rem 0 1rem; }
  input { flex: 1; padding: 10px; font-size: 1rem; border: 1px solid #bbb; border-radius: 6px; }
  button { padding: 10px 16px; font-size: 1rem; border: 0; border-radius: 6px; background: #1f1f1f; color: #fff; cursor: pointer; }
  #out { padding: 12px; border-radius: 6px; background: #f3f3f3; display: none; word-break: break-all; }
  #out.err { background: #fdeaea; color: #8a1f1f; }
  footer { margin-top: 2rem; font-size: .9rem; color: #555; }
</style>
</head>
<body>
<h1>URL Shortener</h1>
<p class="sub">Paste a link to get a short one. Visits to the short link are counted.</p>
<form id="f">
  <input id="url" type="url" placeholder="https://example.com/a/very/long/path" required>
  <button>Shorten</button>
</form>
<div id="out" role="status"></div>
<footer>
  This is a demo of a backend API. Data may be reset at any time.
  <a href="/health">Health</a> ·
  <a href="https://github.com/Dammilola-Tijani/url-shortener">Source and README</a>
</footer>
<script>
  const out = document.getElementById('out');
  const show = (node, isErr) => { out.replaceChildren(node); out.className = isErr ? 'err' : ''; out.style.display = 'block'; };
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: document.getElementById('url').value }),
      });
      const data = await res.json();
      if (!res.ok) return show(document.createTextNode(data.error || 'Something went wrong.'), true);
      const box = document.createElement('div');
      const link = document.createElement('a');
      link.href = data.shortUrl; link.textContent = data.shortUrl;
      const stats = document.createElement('a');
      stats.href = '/api/links/' + data.code + '/stats'; stats.textContent = 'view stats';
      box.append('Short link: ', link, ' (', stats, ')');
      show(box, false);
    } catch {
      show(document.createTextNode('Could not reach the server.'), true);
    }
  });
</script>
</body>
</html>`;
