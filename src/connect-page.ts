export const connectPage = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Conectar Olist</title>
<body><main><h1>Conectar Olist ERP</h1>
<p>Copie a URL de redirecionamento cadastrada no aplicativo Olist. Ela será comparada exatamente com a configuração do servidor.</p>
<form id="connect" autocomplete="off">
<p><label>URL cadastrada na Olist <input id="callback" type="url" required size="60"></label></p>
<p><label>Token administrativo local <input id="admin" type="password" required autocomplete="off"></label></p>
<p>Use ADMIN_BEARER_TOKEN do seu .env. O valor fica somente na memória desta página.</p>
<button type="submit">Autorizar na Olist</button></form><p id="message" role="status"></p>
<script src="/oauth/olist/connect.js" defer></script></main></body></html>`;
export const connectScript = `document.getElementById('connect').addEventListener('submit', async event => {
  event.preventDefault();
  const field = document.getElementById('admin');
  const token = field.value; field.value = '';
  const message = document.getElementById('message');
  try {
    const response = await fetch('/oauth/olist/start', { method: 'POST', credentials: 'same-origin',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ registered_redirect_uri: document.getElementById('callback').value }) });
    if (!response.ok) { message.textContent = response.status === 400 ? 'Callback divergente. Confira a URL cadastrada e a configuração local.' : 'Não foi possível iniciar. Confira o token administrativo e o servidor.'; return; }
    location.assign((await response.json()).authorization_url);
  } catch { message.textContent = 'Servidor indisponível. Tente novamente.'; }
});`;
