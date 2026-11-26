// Human approval console. All remote text is rendered with textContent (never innerHTML): marketplace/ERP data is untrusted.
// Visual language follows the ERP the operator already uses (dark rail, warm off-white panels, blue pill actions), without its brand.
export const adminPage = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aprovações do agente</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600&display=swap">
<style>
:root{--rail:#13224a;--rail-2:#1c2f5f;--bg:#f7f5f1;--panel:#fbfaf7;--card:#fff;--line:#e8e4dc;--text:#1e2330;--muted:#6c7080;--blue:#1458e8;--blue-2:#0f47c2;--blue-soft:#e3eafb;
--warn-bg:#fdf1e2;--warn-line:#f4d6ad;--warn:#f39a1d;--ok:#11845b;--ok-soft:#e2f4ec;--bad:#c62f3a;--bad-soft:#fbe7e8;--gray-soft:#eeece7;--radius:14px}
*{box-sizing:border-box}[hidden]{display:none!important}html,body{margin:0;height:100%}body{font:15px/1.45 Lexend,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);background:var(--bg);font-weight:300}
button,input,select{font:inherit;color:inherit}button{cursor:pointer}b,strong,h1,h2,h3{font-weight:500}
.shell{display:grid;grid-template-columns:76px 300px 1fr;min-height:100vh}
.rail{background:var(--rail);display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 0;border-radius:0 18px 18px 0;margin:8px 0}
.mark{width:36px;height:36px;border-radius:50%;background:conic-gradient(#ffb020 0 50%,#2f6bff 50% 100%);margin-bottom:14px}
.rail button{width:48px;height:48px;border-radius:14px;border:0;background:transparent;color:#c8d2ee;display:grid;place-items:center}
.rail button.on{background:linear-gradient(180deg,#4f8dff,#2f6bff);color:#fff;box-shadow:0 4px 14px #2f6bff55}
.rail button:hover:not(.on){background:var(--rail-2)}.rail svg{width:22px;height:22px}.rail .sep{width:22px;height:2px;background:#ffffff40;margin:4px 0}
.rail .grow{flex:1}.avatar{width:38px;height:38px;border-radius:50%;background:#2f6bff;color:#fff;display:grid;place-items:center;font-size:13px;font-weight:600}
.side{background:var(--panel);margin:8px 0 8px 8px;border-radius:18px;padding:22px 14px;box-shadow:0 1px 0 var(--line)}
.side h2{font-size:18px;margin:0 8px 18px;display:flex;align-items:center;gap:10px}.side a{display:flex;gap:12px;align-items:center;padding:12px 16px;border-radius:12px;color:var(--text);text-decoration:none;margin-bottom:6px}
.side a.on{background:var(--blue-soft);color:var(--blue)}.side a:hover:not(.on){background:#f1eee8}.side .count{margin-left:auto;font-size:12px;background:var(--blue);color:#fff;border-radius:999px;padding:1px 8px}
.side .count:empty{display:none}.side svg{width:20px;height:20px;flex:none}
main{padding:22px 34px 40px;min-width:0}
.crumbs{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:15px}.crumbs b{color:var(--text);font-weight:400}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.actions{display:flex;gap:10px;flex-wrap:wrap}
.pill{border-radius:999px;border:1px solid var(--line);background:var(--card);padding:9px 18px;display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:var(--text)}
.pill:hover{border-color:#cfc9be}.primary{background:var(--blue);border-color:var(--blue);color:#fff}.primary:hover{background:var(--blue-2);border-color:var(--blue-2)}
.danger{color:var(--bad)}.pill:disabled{opacity:.5;cursor:not-allowed}
h1{font-size:30px;margin:14px 0 14px;letter-spacing:-.01em}
.search{display:flex;align-items:center;max-width:820px;border:2px solid #a9c1f7;border-radius:12px;background:var(--card);padding:4px 6px 4px 18px;box-shadow:0 0 0 4px #e8effd}
.search input{flex:1;border:0;outline:0;padding:10px 0;background:transparent;font-size:16px}.search svg{width:22px;height:22px;color:var(--muted);margin-right:8px}
.chips{display:flex;gap:8px;margin:14px 0 18px;flex-wrap:wrap}
.banner{display:flex;align-items:center;gap:18px;background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:var(--radius);padding:16px 20px;margin:6px 0 18px}
.banner .ico{width:50px;height:50px;border-radius:50%;background:var(--warn);display:grid;place-items:center;color:#2b1a00;font-size:22px;flex:none}
.banner.info{background:#eef3fd;border-color:#cddcfb}.banner.info .ico{background:var(--blue);color:#fff}
.tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin-top:8px;overflow-x:auto}
.tabs button{border:0;background:none;padding:10px 26px 12px;text-align:center;color:var(--muted);border-bottom:3px solid transparent;min-width:120px;font-size:17px}
.tabs button span{display:block;color:var(--text);font-size:17px}.tabs button.on{color:var(--text);border-bottom-color:var(--text)}
table{width:100%;border-collapse:collapse}th{font-weight:400;color:var(--muted);text-align:left;padding:16px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:16px 12px;border-bottom:1px solid var(--line);vertical-align:top}tr.row{cursor:pointer}tr.row:hover td{background:#f3f0ea}
.desc{font-size:16px}.sub{color:var(--muted);font-size:13px}.link{color:var(--blue)}
.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 12px;font-size:13px;white-space:nowrap;background:var(--gray-soft)}
.b-pending{background:#fff1d6;color:#8a5300}.b-executing,.b-preparing{background:var(--blue-soft);color:var(--blue)}.b-succeeded{background:var(--ok-soft);color:var(--ok)}
.b-failed,.b-rejected,.b-conflict,.b-unknown,.b-invalid{background:var(--bad-soft);color:var(--bad)}.b-partial{background:#fde9d6;color:#9a4a00}.b-blocked{background:#ece7f8;color:#5b3fa5}
.b-skipped,.b-cancelled,.b-expired{background:var(--gray-soft);color:var(--muted)}
.kind{display:inline-grid;place-items:center;width:44px;height:44px;border-radius:12px;background:var(--blue-soft);color:var(--blue);font-size:12px;font-weight:600}
.chev{width:34px;height:34px;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;background:var(--card);transition:transform .15s}.open .chev{transform:rotate(180deg)}
.detail td{background:var(--panel);padding:18px 22px 22px}.risks{list-style:none;padding:0;margin:0 0 14px}.risks li{background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:10px;padding:8px 12px;margin-bottom:6px;font-size:14px}
.blocked{background:#ece7f8;border:1px solid #d6cbf1;color:#3f2a80;border-radius:10px;padding:10px 12px;margin-bottom:12px}
.items{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}.items th{font-size:13px;padding:10px 12px;background:#faf8f4}.items td{font-size:14px;padding:12px}
.diff{display:flex;flex-direction:column;gap:2px}.diff .from{color:var(--muted);text-decoration:line-through;text-decoration-color:#c9c4ba}.diff .to{font-weight:500}
.foot{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap}.foot .warn{color:#8a5300;margin-right:auto}
.empty{padding:60px 20px;text-align:center;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-top:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:18px}.card h3{margin:0 0 4px;font-size:16px}.card p{margin:0 0 12px;color:var(--muted);font-size:14px}
.switch{position:relative;width:46px;height:26px;border-radius:999px;border:0;background:#d6d2c9;flex:none}.switch::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .15s}
.switch.on{background:var(--blue)}.switch.on::after{left:23px}.row-between{display:flex;justify-content:space-between;align-items:center;gap:12px}
.login{min-height:100vh;display:grid;place-items:center;padding:16px}.login form{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:34px;width:min(440px,100%);box-shadow:0 10px 40px #13224a14}
.login h1{font-size:24px;margin:16px 0 6px}.login p{color:var(--muted);margin:0 0 18px;font-size:14px}.field{width:100%;border:2px solid #a9c1f7;border-radius:12px;padding:12px 14px;margin-bottom:14px;outline:0}
.field:focus{box-shadow:0 0 0 4px #e8effd}.toast{position:fixed;right:20px;bottom:20px;background:var(--rail);color:#fff;border-radius:12px;padding:12px 18px;max-width:420px;box-shadow:0 8px 30px #0003}
.toast:empty{display:none}.toast.err{background:var(--bad)}
@media (max-width:1100px){.shell{grid-template-columns:76px 1fr}.side{display:none}}
@media (max-width:640px){.shell{grid-template-columns:1fr}.rail{display:none}main{padding:16px}.hide-sm{display:none}h1{font-size:24px}}
</style></head>
<body><div id="login" class="login"><form id="loginForm" autocomplete="off"><div class="mark"></div><h1>Aprovações do agente</h1>
<p>Entre com o token administrativo (ADMIN_BEARER_TOKEN do .env). Ele fica só na memória desta aba.</p>
<input id="admin" class="field" type="password" placeholder="Token administrativo" required autocomplete="off"><button class="pill primary" style="width:100%;justify-content:center">entrar</button></form></div>
<div id="app" class="shell" hidden>
<nav class="rail" aria-label="Navegação"><div class="mark"></div><div class="sep"></div>
<button data-view="aprovacoes" title="Aprovações"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg></button>
<button data-view="historico" title="Histórico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/></svg></button>
<button data-view="automacoes" title="Automações"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2L3 14h9l-1 8 10-12h-9z"/></svg></button>
<button data-view="status" title="Conexão"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>
<div class="grow"></div><div class="avatar">AG</div></nav>
<aside class="side"><h2>Agente IA</h2>
<a href="#aprovacoes" data-view="aprovacoes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>Aprovações<span class="count" id="sideCount"></span></a>
<a href="#historico" data-view="historico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/></svg>Histórico de alterações</a>
<a href="#automacoes" data-view="automacoes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 2L3 14h9l-1 8 10-12h-9z"/></svg>Automações</a>
<a href="#status" data-view="status"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12h14M12 5v14"/><circle cx="12" cy="12" r="9"/></svg>Conexão e permissões</a></aside>
<main id="main"></main></div><div id="toast" class="toast" role="status"></div>
<script src="/admin/admin.js" defer></script></body></html>`;

export const adminScript = `'use strict';
let token = '', view = 'aprovacoes', tab = 'pending', query = '', open = null, confirming = null, cache = [], summary = {}, status = {};
const $ = id => document.getElementById(id);
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v); }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return e;
}
function toast(msg, err) { const t = $('toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => { t.textContent = ''; }, 6000); }
async function api(path, init = {}) {
  const r = await fetch('/admin/api' + path, { ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
  return body;
}
const STATUS = { pending: 'aguardando aprovação', preparing: 'validando', executing: 'executando', succeeded: 'concluída', partial: 'parcial', failed: 'falhou', expired: 'expirada',
  cancelled: 'cancelada', rejected: 'rejeitada', blocked: 'bloqueada', skipped: 'omitido', invalid: 'com erro', conflict: 'conflito', unknown: 'conferir no ERP' };
const KIND = { stock: ['EST', 'Estoque'], price: ['R$', 'Preço'], product: ['PRD', 'Produto'], sku: ['SKU', 'SKU'], batch: ['LOT', 'Lote'] };
const OP = { stock_balance: 'Ajuste de estoque', price: 'Preço', product_update: 'Edição de produto', sku_update: 'Troca de SKU', product_create: 'Cadastro de produto', variation_create: 'Nova variação', images_add: 'Adicionar imagens', product_delete: 'EXCLUIR produto', variation_delete: 'EXCLUIR variação' };
const brl = v => typeof v === 'number' ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—';
const num = v => typeof v === 'number' ? v.toLocaleString('pt-BR') : '—';
const when = d => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const badge = s => el('span', { class: 'badge b-' + s }, STATUS[s] || s);
const isExpired = p => p.status === 'pending' && new Date(p.expires_at) <= new Date();
function describe(i) {
  const b = i.before || {}, a = i.after || {};
  switch (i.operation) {
    case 'stock_balance': return [
      ['Físico ' + num(b.saldoDeposito) + ' · Reservado ' + num(b.reservadoDeposito) + ' · Disponível ' + num(b.disponivelDeposito)],
      ['Físico ' + num(a.quantidade) + ' · Disponível ' + num(a.disponivelResultante) + (typeof a.movimentacaoCalculada === 'number' ? ' (' + (a.movimentacaoCalculada > 0 ? '+' : '') + num(a.movimentacaoCalculada) + ')' : '')]];
    case 'price': return [[brl(b.preco) + (b.precoPromocional ? ' · promo ' + brl(b.precoPromocional) : '')],
      [brl(a.preco) + (a.precoPromocional ? ' · promo ' + brl(a.precoPromocional) : '') + (typeof a.variacaoPercentual === 'number' ? ' (' + (a.variacaoPercentual > 0 ? '+' : '') + num(a.variacaoPercentual) + '%)' : '')]];
    case 'product_create': return [['novo cadastro'], [[a.descricao, a.precos && a.precos.preco !== undefined ? brl(a.precos.preco) : null, a.variacoes ? a.variacoes.length + ' variações' : 'simples', a.anexos ? a.anexos.length + ' imagem(ns)' : null].filter(Boolean).join(' · ')]];
    case 'product_delete': case 'variation_delete': return [
      [[b.descricao, b.produtoPai ? 'variação de ' + b.produtoPai : null, b.variacoes && b.variacoes.length ? b.variacoes.length + ' variações' : null,
        b.estoque ? 'físico ' + num(b.estoque.fisico) + ' · reservado ' + num(b.estoque.reservado) : null].filter(Boolean).join(' · ')],
      ['será EXCLUÍDO' + (a.excluirAnexosVinculados === false ? ' (mantendo imagens)' : (i.operation === 'product_delete' ? ' com as imagens' : ''))]];
    case 'images_add': return [[num(b.imagens) + ' imagem(ns) hoje'], ['+ ' + (a.imagens || []).length + ' imagem(ns): ' + (a.imagens || []).map(u => u.split('/').pop()).join(', ')]];
    case 'variation_create': return [['nova variação'], [(a.grade || []).map(g => g.chave + ': ' + g.valor).join(', ') + (a.precos && a.precos.preco !== undefined ? ' · ' + brl(a.precos.preco) : '')]];
    default: { const keys = Object.keys(a); return [keys.map(k => k + ': ' + fmt(b[k])), keys.map(k => k + ': ' + fmt(a[k]))]; }
  }
}
function fmt(v) { if (v === null || v === undefined) return '—'; if (typeof v === 'object') return v.id !== undefined ? 'ID ' + v.id : JSON.stringify(v); const s = String(v); return s.length > 140 ? s.slice(0, 140) + '…' : s; }
function diffCell(i) { const [from, to] = describe(i); return el('div', { class: 'diff' }, ...from.map(f => el('span', { class: 'from' }, f)), ...to.map(t => el('span', { class: 'to' }, t))); }

async function loadSummary() { summary = await api('/summary'); $('sideCount').textContent = summary.pending ? String(summary.pending) : ''; }
const TABS = [['pending', 'pendentes'], ['executing', 'executando'], ['succeeded', 'concluídas'], ['failed', 'com falha'], ['blocked', 'bloqueadas'], ['', 'todas']];
function tabCount(key) { if (!key) return Object.values(summary).reduce((a, b) => a + b, 0); if (key === 'failed') return (summary.failed || 0) + (summary.partial || 0); if (key === 'executing') return (summary.executing || 0) + (summary.preparing || 0); return summary[key] || 0; }

async function render() {
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === view);
  const main = $('main'); main.replaceChildren();
  try {
    await loadSummary();
    if (view === 'aprovacoes' || view === 'historico') await renderProposals(main);
    else if (view === 'automacoes') await renderAutomations(main);
    else await renderStatus(main);
  } catch (e) { if (/401|Unauthorized/.test(e.message)) return logout('Sessão expirada; entre novamente.'); main.append(el('div', { class: 'empty' }, 'Falha ao carregar: ' + e.message)); }
}
function header(main, crumb, title, ...actions) {
  main.append(el('div', { class: 'top' }, el('div', { class: 'crumbs' }, 'início', el('span', {}, '≡ agente'), el('b', {}, crumb)), el('div', { class: 'actions' }, ...actions)));
  main.append(el('h1', {}, title));
}
async function renderProposals(main) {
  const history = view === 'historico';
  const current = history ? '' : tab;
  header(main, history ? 'histórico' : 'aprovações', history ? 'Histórico de alterações' : 'Aprovações',
    el('button', { class: 'pill', onclick: () => render() }, '↻ atualizar'), el('a', { class: 'pill primary', href: '#status' }, 'conexão e permissões'));
  const lens = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); lens.setAttribute('viewBox', '0 0 24 24'); lens.setAttribute('fill', 'none'); lens.setAttribute('stroke', 'currentColor'); lens.setAttribute('stroke-width', '2');
  for (const [tag, attrs] of [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M20 20l-4-4' }]]) { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); lens.append(n); }
  main.append(el('label', { class: 'search' }, el('input', { id: 'q', placeholder: 'Pesquise por descrição, SKU ou ID da proposta', value: query, oninput: e => { query = e.target.value; paint(); } }), lens));
  status = await api('/status');
  const writes = status.writeMode === 'enabled';
  main.append(el('div', { class: 'banner' + (writes ? '' : ' info') }, el('div', { class: 'ico' }, writes ? '!' : 'i'),
    el('div', {}, writes ? el('span', {}, 'Escrita real habilitada: cada aprovação altera a Olist. Operações liberadas: ', el('b', {}, (status.writeOperations || []).join(', ') || 'nenhuma'), '.')
      : 'Modo somente leitura: aprovações serão recusadas pelo servidor até a escrita ser habilitada.')));
  if (!history) main.append(el('div', { class: 'tabs', role: 'tablist' }, ...TABS.map(([k, label]) => el('button', { role: 'tab', class: tab === k ? 'on' : '', onclick: () => { tab = k; open = null; render(); } }, label, el('span', {}, String(tabCount(k)))))));
  const fetchStatus = current === 'failed' ? ['failed', 'partial'] : current === 'executing' ? ['executing', 'preparing'] : [current];
  cache = (await Promise.all(fetchStatus.map(s => api('/proposals?status=' + encodeURIComponent(s))))).flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  main.append(el('div', { id: 'list' })); paint();
}
function paint() {
  const box = $('list'); if (!box) return; box.replaceChildren();
  const q = query.trim().toLowerCase();
  const rows = cache.filter(p => !q || (p.summary + ' ' + p.id).toLowerCase().includes(q));
  if (!rows.length) { box.append(el('div', { class: 'empty' }, view === 'aprovacoes' && tab === 'pending' ? 'Nenhuma alteração aguardando aprovação. Peça uma pelo ChatGPT ou Codex.' : 'Nada por aqui.')); return; }
  const t = el('table', {}, el('thead', {}, el('tr', {}, el('th', { class: 'hide-sm' }), el('th', {}, 'Descrição'), el('th', { class: 'hide-sm' }, 'Tipo'), el('th', {}, 'Situação'), el('th', { class: 'hide-sm' }, 'Criada'), el('th', { class: 'hide-sm' }, 'Expira'), el('th'))));
  const body = el('tbody');
  for (const p of rows) {
    const st = isExpired(p) ? 'expired' : p.status; const k = KIND[p.kind] || ['?', p.kind];
    const tr = el('tr', { class: 'row' + (open === p.id ? ' open' : ''), onclick: () => { open = open === p.id ? null : p.id; confirming = null; paint(); } },
      el('td', { class: 'hide-sm' }, el('span', { class: 'kind' }, k[0])),
      el('td', {}, el('div', { class: 'desc' }, p.summary), el('div', { class: 'sub' }, 'ID ' + p.id.slice(0, 8))),
      el('td', { class: 'hide-sm' }, k[1]), el('td', {}, badge(st)), el('td', { class: 'hide-sm' }, when(p.created_at)),
      el('td', { class: 'hide-sm' }, p.status === 'pending' ? when(p.expires_at) : '—'), el('td', {}, el('span', { class: 'chev' }, '⌄')));
    body.append(tr);
    if (open === p.id) { const cell = el('td', { colspan: '7' }, 'Carregando…'); body.append(el('tr', { class: 'detail' }, cell)); loadDetail(p.id, cell); }
  }
  t.append(body); box.append(t);
}
async function loadDetail(id, cell) {
  try {
    const d = await api('/proposals/' + id); cell.replaceChildren();
    if (d.blocked_reason) cell.append(el('div', { class: 'blocked' }, el('b', {}, 'Bloqueada: '), d.blocked_reason));
    if (d.risks && d.risks.length) cell.append(el('ul', { class: 'risks' }, ...d.risks.map(r => el('li', {}, '⚠ ' + r))));
    const items = el('table', { class: 'items' }, el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Produto / SKU'), el('th', {}, 'Operação'), el('th', {}, 'Antes → depois'), el('th', {}, 'Situação'), el('th', {}, 'Observação'))));
    const tb = el('tbody');
    for (const i of d.itens) tb.append(el('tr', {}, el('td', {}, String(i.seq + 1)),
      el('td', {}, el('div', {}, i.target.sku || '—'), el('div', { class: 'sub' }, (i.target.idProduto ? 'ID ' + i.target.idProduto : 'novo') + (i.target.idDeposito ? ' · depósito ' + i.target.idDeposito : '') + (i.target.linha ? ' · linha ' + i.target.linha : ''))),
      el('td', {}, OP[i.operation] || i.operation), el('td', {}, diffCell(i)),
      el('td', {}, i.status === 'pending' ? el('span', { class: 'badge b-executing' }, d.status === 'pending' ? 'pronto' : 'na fila') : badge(i.status), i.verified ? el('div', { class: 'sub' }, '✓ conferido no ERP') : null), el('td', { class: 'sub' }, i.message || '')));
    items.append(tb); cell.append(items);
    const pending = d.status === 'pending', executable = d.itens.filter(i => i.status === 'pending').length;
    const foot = el('div', { class: 'foot' });
    const deleting = d.itens.some(i => /_delete$/.test(i.operation) && i.status === 'pending');
    if (pending && confirming === id) foot.append(el('span', { class: 'warn' }, deleting
        ? 'EXCLUIR ' + executable + ' item(ns) na Olist agora? Esta ação é IRREVERSÍVEL.'
        : 'Executar ' + executable + ' item(ns) na Olist agora? Esta ação altera dados reais.'),
      el('button', { class: 'pill', onclick: e => { e.stopPropagation(); confirming = null; paint(); } }, 'voltar'),
      el('button', { class: 'pill primary', onclick: e => { e.stopPropagation(); act(id, 'approve'); } }, deleting ? 'confirmar EXCLUSÃO' : 'confirmar execução'));
    else if (pending) foot.append(el('span', { class: 'sub', style: 'margin-right:auto' }, executable + ' item(ns) executável(is) · expira ' + when(d.expires_at)),
      el('button', { class: 'pill danger', onclick: e => { e.stopPropagation(); act(id, 'reject'); } }, 'rejeitar'),
      el('button', { class: 'pill primary', onclick: e => { e.stopPropagation(); confirming = id; paint(); } }, 'aprovar e executar'));
    else if (['blocked', 'preparing'].includes(d.status)) foot.append(el('button', { class: 'pill danger', onclick: e => { e.stopPropagation(); act(id, 'reject'); } }, 'descartar'));
    if (d.proximoPasso && !pending) foot.prepend(el('span', { class: 'sub', style: 'margin-right:auto' }, d.proximoPasso));
    cell.append(foot);
  } catch (e) { cell.textContent = 'Falha ao carregar: ' + e.message; }
}
async function act(id, what) {
  try {
    toast(what === 'approve' ? 'Executando na Olist…' : 'Registrando…');
    const r = await api('/proposals/' + id + '/' + what, { method: 'POST', body: '{}' });
    confirming = null; open = id;
    toast(what === 'approve' ? 'Resultado: ' + (STATUS[r.status] || r.status) : 'Proposta ' + (STATUS[r.status] || r.status), ['failed', 'partial'].includes(r.status));
    await render();
  } catch (e) { toast(e.message, true); }
}
async function renderAutomations(main) {
  header(main, 'automações', 'Automações', el('button', { class: 'pill', onclick: () => render() }, '↻ atualizar'));
  main.append(el('div', { class: 'banner info' }, el('div', { class: 'ico' }, 'i'), 'Rotinas de relatório. Nenhuma corrige dados sozinha; correções sempre passam por aprovação.'));
  const list = await api('/automations'); const grid = el('div', { class: 'grid' });
  for (const a of list) grid.append(el('div', { class: 'card' },
    el('div', { class: 'row-between' }, el('h3', {}, a.name.replaceAll('_', ' ')), el('button', { class: 'switch' + (a.enabled ? ' on' : ''), 'aria-pressed': String(a.enabled), title: a.enabled ? 'desativar' : 'ativar',
      onclick: async () => { try { await api('/automations/' + a.name, { method: 'PUT', body: JSON.stringify({ enabled: !a.enabled }) }); render(); } catch (e) { toast(e.message, true); } } })),
    el('p', {}, a.descricao), el('div', { class: 'sub' }, (a.enabled ? 'a cada ' + a.interval_minutes + ' min' : 'desativada') + ' · última execução ' + when(a.last_run_at))));
  main.append(grid);
}
async function renderStatus(main) {
  header(main, 'conexão', 'Conexão e permissões', el('a', { class: 'pill primary', href: '/oauth/olist/connect' }, 'reautorizar Olist'));
  const s = await api('/status');
  const ops = { stock: 'Estoque', price: 'Preço', create: 'Cadastro de produtos/variações', product: 'Edição de produto', sku: 'Troca de SKU', delete: 'Exclusão de produtos/variações' };
  main.append(el('div', { class: 'grid' },
    el('div', { class: 'card' }, el('h3', {}, 'Escrita na Olist'), el('p', {}, s.writeMode === 'enabled' ? 'Habilitada — somente após sua aprovação nesta tela.' : 'Desabilitada (somente leitura).'), badge(s.writeMode === 'enabled' ? 'succeeded' : 'skipped')),
    el('div', { class: 'card' }, el('h3', {}, 'Aprovação'), el('p', {}, s.approvalMode === 'admin' ? 'Humana, neste painel. O ChatGPT e o Codex não conseguem aprovar.' : 'Pelo cliente MCP com código de confirmação.')),
    el('div', { class: 'card' }, el('h3', {}, 'Operações liberadas'), ...Object.entries(ops).map(([k, label]) => el('div', { class: 'row-between', style: 'padding:6px 0' }, el('span', {}, label), badge((s.writeOperations || []).includes(k) ? 'succeeded' : 'skipped'))))));
  main.append(el('p', { class: 'sub', style: 'margin-top:18px' }, 'Depois de alterar permissões do aplicativo na Olist, use "reautorizar Olist": o escopo do token é fixado na autorização.'));
}
function logout(msg) { token = ''; $('app').hidden = true; $('login').hidden = false; if (msg) toast(msg, true); }
function route() { const h = location.hash.slice(1); view = ['aprovacoes', 'historico', 'automacoes', 'status'].includes(h) ? h : 'aprovacoes'; open = null; confirming = null; if (token) render(); }
for (const b of document.querySelectorAll('.rail [data-view]')) b.addEventListener('click', () => { location.hash = b.dataset.view; });
window.addEventListener('hashchange', route);
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault(); token = $('admin').value; $('admin').value = '';
  try { await api('/status'); $('login').hidden = true; $('app').hidden = false; route(); } catch (err) { token = ''; toast('Token inválido ou servidor indisponível.', true); }
});
// Light auto-refresh of the approvals list; never while the operator is confirming an execution.
setInterval(() => { if (token && view === 'aprovacoes' && !confirming && !open && document.visibilityState === 'visible') render(); }, 20000);`;
