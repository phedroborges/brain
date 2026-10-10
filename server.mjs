// Brain: recebe um pedido (texto/áudio transcrito + anexos), descobre o projeto
// e abre uma sessão do Claude Code ou do Codex na pasta dele, em modo automático.
// Sem dependências: só módulos nativos do Node.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const PORTA = Number(process.env.BRAIN_PORT || 4848);
const DADOS = process.env.BRAIN_DATA_DIR || path.join(os.homedir(), '.brain');
const PEDIDOS = path.join(DADOS, 'pedidos');
const LIMITE_CORPO = 60 * 1024 * 1024;

// Configuração: variáveis de ambiente (VPS) ou ~/.brain/.env (PC).
function lerEnv() {
  const env = {};
  try {
    for (const l of fs.readFileSync(path.join(DADOS, '.env'), 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  return env;
}
const cfg = (nome) => process.env[nome] ?? lerEnv()[nome] ?? '';

// No PC a Brain só escuta em 127.0.0.1 e dispensa senha. Para escutar na rede
// (VPS) é obrigatório definir BRAIN_SENHA e os domínios em BRAIN_HOSTS.
const HOST = cfg('BRAIN_HOST') || '127.0.0.1';
const SENHA = cfg('BRAIN_SENHA');
const LOCAL = HOST === '127.0.0.1' || HOST === 'localhost';
const HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  'brain.localhost',
  ...cfg('BRAIN_HOSTS').split(',').map((h) => h.trim()).filter(Boolean),
]);
if (!LOCAL && !SENHA) {
  console.error('[brain] BRAIN_HOST fora de 127.0.0.1 exige BRAIN_SENHA. Encerrando.');
  process.exit(1);
}
const MODELO_ROTEADOR = process.env.BRAIN_ROUTER_MODEL || 'haiku';

fs.mkdirSync(PEDIDOS, { recursive: true });

const expandir = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// Cada projeto fica em <BRAIN_PROJETOS_DIR>/<id>, salvo se o cadastro disser outra pasta.
const PROJETOS_DIR = expandir(cfg('BRAIN_PROJETOS_DIR') || '~/projetos');

function lerProjetos() {
  const lista = JSON.parse(fs.readFileSync(path.join(RAIZ, 'projetos.json'), 'utf8'));
  return lista.map((p) => ({
    ativo: true,
    apelidos: [],
    ...p,
    pasta: p.pasta ? expandir(p.pasta) : path.join(PROJETOS_DIR, p.id),
  }));
}

// Nomes próprios que a transcrição costuma errar (clientes, pessoas, marcas).
function lerVocabulario() {
  try {
    return JSON.parse(fs.readFileSync(path.join(RAIZ, 'vocabulario.json'), 'utf8'));
  } catch {
    return [];
  }
}

// Na VPS o git precisa de identidade e de credencial para clonar e fazer push.
// GH_TOKEN (lido pelo gh) resolve a credencial; nome e e-mail vêm do ambiente.
function prepararGit() {
  const git = (...args) => spawnSync('git', ['config', '--global', ...args], { windowsHide: true });
  if (cfg('BRAIN_GIT_NOME')) git('user.name', cfg('BRAIN_GIT_NOME'));
  if (cfg('BRAIN_GIT_EMAIL')) git('user.email', cfg('BRAIN_GIT_EMAIL'));
  if (process.env.GH_TOKEN) spawnSync('gh', ['auth', 'setup-git'], { windowsHide: true });
}
prepararGit();

// ---------- pedidos em disco ----------

const emExecucao = new Map(); // id -> processo filho

const arquivoPedido = (id) => path.join(PEDIDOS, id, 'pedido.json');
const arquivoLog = (id) => path.join(PEDIDOS, id, 'saida.log');

function salvar(pedido) {
  pedido.atualizadoEm = new Date().toISOString();
  fs.writeFileSync(arquivoPedido(pedido.id), JSON.stringify(pedido, null, 2));
}

function carregar(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(arquivoPedido(id), 'utf8'));
  } catch {
    return null;
  }
}

function listar() {
  return fs
    .readdirSync(PEDIDOS)
    .map(carregar)
    .filter(Boolean)
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}

function log(id, texto) {
  fs.appendFileSync(arquivoLog(id), texto.endsWith('\n') ? texto : texto + '\n');
}

// Pedidos que ficaram "em andamento" de uma execução anterior do servidor.
for (const p of listar()) {
  if (p.status === 'roteando' || p.status === 'executando') {
    p.status = 'interrompido';
    p.erro = 'O servidor da Brain reiniciou durante a execução.';
    salvar(p);
  }
}

// ---------- roteador ----------

// Os agentes usam a assinatura (login do Claude Code e do Codex), nunca a API
// paga por uso: as chaves de API não chegam até eles, mesmo que existam no
// ambiente para outra finalidade (ex.: OPENAI_API_KEY para transcrever áudio).
const CHAVES_DE_API = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
function ambienteDoAgente() {
  const env = { ...process.env };
  for (const chave of CHAVES_DE_API) delete env[chave];
  return env;
}

function rodar(cmd, args, { cwd, entrada, aoLer }) {
  return new Promise((resolve) => {
    const filho = spawn(cmd, args, { cwd, windowsHide: true, env: ambienteDoAgente() });
    let saida = '';
    let erro = '';
    filho.stdout.on('data', (d) => {
      saida += d;
      aoLer?.(d.toString());
    });
    filho.stderr.on('data', (d) => (erro += d));
    filho.on('error', (e) => resolve({ codigo: -1, saida, erro: String(e), filho }));
    filho.on('close', (codigo) => resolve({ codigo, saida, erro, filho }));
    if (entrada != null) filho.stdin.end(entrada);
    aoLer?.('', filho);
  });
}

async function rotear(pedido, projetos) {
  const catalogo = projetos
    .map(
      (p) =>
        `- id: ${p.id} | nome: ${p.nome} | apelidos: ${p.apelidos.join(', ') || '-'} | ` +
        `${p.ativo ? 'disponível' : 'INDISPONÍVEL: ' + (p.motivo || '')} | ${p.descricao || ''}`,
    )
    .join('\n');
  const prompt =
    `Você recebe pedidos do Phedro, quase sempre ditados por voz. A transcrição erra nomes próprios: ` +
    `troca por palavras comuns de som parecido (ex.: "visando tarefas", "vizando" ou "bizantu" = Vizantu Tarefas; ` +
    `"renã" = Renan; "tauper" = Tawper). Sua tarefa tem duas partes.\n\n` +
    `1) Entender de qual projeto ele está falando. Leia pelo SOM e pelo sentido, não pela grafia. ` +
    `Escolha o projeto mais provável: não precisa de concordância exata, basta ser a leitura mais natural do pedido. ` +
    `O projeto "brain" só é a resposta quando o pedido é sobre o próprio Brain (este sistema de pedidos) ou sobre as ` +
    `anotações pessoais; o fato de o Brain registrar pedidos não o torna candidato para pedidos sobre outros projetos. ` +
    `Responda null apenas quando nenhum projeto da lista combinar de forma plausível.\n\n` +
    `2) Reescrever o pedido corrigindo SÓ os nomes que a transcrição errou (projetos, clientes, pessoas), usando a ` +
    `lista e o vocabulário abaixo. Não mude o sentido, não resuma, não acrescente nada.\n\n` +
    `Projetos:\n${catalogo}\n\n` +
    `Vocabulário (nomes que ele costuma falar): ${lerVocabulario().join(', ')}\n\n` +
    `Pedido transcrito:\n"""${pedido.texto}"""\n\n` +
    `Responda SOMENTE com um JSON: {"projeto":"<id ou null>","motivo":"<uma frase>","texto":"<pedido com os nomes corrigidos>"}. ` +
    `Não use ferramentas.`;
  const r = await rodar('claude', ['-p', '--model', MODELO_ROTEADOR, '--output-format', 'json'], {
    cwd: path.join(PEDIDOS, pedido.id),
    entrada: prompt,
  });
  if (r.codigo !== 0) {
    // O motivo vem no campo "result" do JSON (ex.: "Not logged in"); o resto é telemetria.
    let motivo = '';
    try {
      motivo = JSON.parse(r.saida).result || '';
    } catch {}
    throw new Error(`O Claude não conseguiu rotear o pedido: ${(motivo || r.erro || r.saida).trim().slice(0, 400)}`);
  }
  const texto = JSON.parse(r.saida).result ?? '';
  const achado = texto.match(/\{[\s\S]*\}/);
  if (!achado) throw new Error('roteador não devolveu JSON: ' + texto.slice(0, 200));
  return JSON.parse(achado[0]);
}

// ---------- executor ----------

// Como o agente entrega alterações de código, conforme "publicar" no cadastro:
// "main" (padrão) publica direto, "branch" envia uma branch e "nao" fica só local.
function regraDePublicacao(pedido, projeto) {
  const modo = projeto.publicar || 'main';
  if (modo === 'nao') {
    return `Se for alterar código, crie e use a branch "brain/${pedido.id}". Não faça push, deploy nem publique nada.`;
  }
  if (modo === 'branch') {
    return (
      `Se for alterar código, crie a branch "brain/${pedido.id}", faça commit e push dela e abra um pull request ` +
      `(gh pr create). Não faça merge nem mexa na branch principal.`
    );
  }
  return (
    `Se for alterar código: comece com git pull na branch principal, trabalhe nela, valide (build/testes/lint do projeto, ` +
    `quando existirem) e, passando, faça commit e push direto na branch principal, sem esperar aprovação. ` +
    `Se a validação falhar e você não conseguir corrigir, não faça push: deixe o trabalho em "brain/${pedido.id}" e explique.`
  );
}

function montarPrompt(pedido, projeto) {
  const anexos = pedido.anexos.length
    ? `\n\nAnexos deste pedido (leia todos antes de começar):\n${pedido.anexos.map((a) => '- ' + a).join('\n')}`
    : '';
  return (
    `${pedido.texto}${anexos}\n\n---\n` +
    `Contexto: este pedido chegou pela Brain do Phedro e você está rodando sozinho, sem ninguém acompanhando, ` +
    `no projeto "${projeto.nome}" (${projeto.pasta}).\n` +
    `Regras:\n` +
    `1. Antes de mexer, entenda o projeto: leia CLAUDE.md/AGENTS.md/README e os commits recentes (git log).\n` +
    `2. ${regraDePublicacao(pedido, projeto)}\n` +
    `3. Use as skills e ferramentas do projeto quando existirem para o tipo de entrega pedido.\n` +
    `4. Se faltar informação essencial, não invente: pare e diga o que falta.\n` +
    `5. Termine com um resumo curto do que fez, o que ficou pendente e como conferir.`
  );
}

// Transforma o stream-json do Claude Code em linhas legíveis.
function leitorClaude(id) {
  let resto = '';
  let final = null;
  const linha = (l) => {
    let ev;
    try {
      ev = JSON.parse(l);
    } catch {
      return log(id, l);
    }
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'text' && b.text.trim()) log(id, b.text.trim());
        if (b.type === 'tool_use') {
          const i = b.input ?? {};
          const alvo = i.command ?? i.file_path ?? i.pattern ?? i.description ?? i.url ?? '';
          log(id, `  → ${b.name}${alvo ? ': ' + String(alvo).split('\n')[0].slice(0, 160) : ''}`);
        }
      }
    } else if (ev.type === 'result') {
      final = { texto: ev.result ?? '', erro: !!ev.is_error };
    }
  };
  return {
    ler(pedaco) {
      resto += pedaco;
      const partes = resto.split('\n');
      resto = partes.pop();
      partes.filter((p) => p.trim()).forEach(linha);
    },
    fim() {
      if (resto.trim()) linha(resto);
      return final;
    },
  };
}

async function executar(pedido, projeto) {
  const dir = path.join(PEDIDOS, pedido.id);
  const prompt = montarPrompt(pedido, projeto);
  const registrar = (_, filho) => filho && emExecucao.set(pedido.id, filho);
  let resultado;

  if (pedido.agente === 'codex') {
    const ultima = path.join(dir, 'ultima-mensagem.txt');
    const r = await rodar(
      'codex',
      ['exec', '--approve-for-me', '--skip-git-repo-check', '-C', projeto.pasta, '--add-dir', dir, '-o', ultima, '-'],
      { cwd: projeto.pasta, entrada: prompt, aoLer: (t, f) => (t ? log(pedido.id, t) : registrar(t, f)) },
    );
    if (r.erro.trim()) log(pedido.id, r.erro);
    resultado = {
      texto: fs.existsSync(ultima) ? fs.readFileSync(ultima, 'utf8') : '',
      erro: r.codigo !== 0,
      codigo: r.codigo,
    };
  } else {
    const leitor = leitorClaude(pedido.id);
    const r = await rodar(
      'claude',
      ['-p', '--permission-mode', 'auto', '--add-dir', dir, '--output-format', 'stream-json', '--verbose'],
      { cwd: projeto.pasta, entrada: prompt, aoLer: (t, f) => (t ? leitor.ler(t) : registrar(t, f)) },
    );
    const final = leitor.fim();
    if (r.erro.trim()) log(pedido.id, r.erro);
    resultado = { texto: final?.texto ?? '', erro: r.codigo !== 0 || !!final?.erro, codigo: r.codigo };
  }
  emExecucao.delete(pedido.id);
  return resultado;
}

async function processar(pedido) {
  try {
    const projetos = lerProjetos();
    let projeto = projetos.find((p) => p.id === pedido.projeto);

    // Sem login não adianta tentar: o roteador usa o Claude e o executor, o agente escolhido.
    const conexoes = await statusConexoes();
    const precisa = [...new Set([...(projeto ? [] : ['claude']), pedido.agente || projeto?.agente || 'claude'])];
    const faltando = precisa.filter((id) => !conexoes[id]).map((id) => CONEXOES[id].nome);
    if (faltando.length) {
      pedido.status = 'erro';
      pedido.erro = `${faltando.join(' e ')} não está conectado nesta máquina. Vá em Conexões, no fim da página, e clique em Conectar.`;
      return salvar(pedido);
    }

    if (!projeto) {
      pedido.status = 'roteando';
      salvar(pedido);
      const escolha = await rotear(pedido, projetos);
      pedido.roteador = escolha;
      // O agente recebe o pedido com os nomes corrigidos; o ditado original fica guardado.
      const corrigido = typeof escolha.texto === 'string' ? escolha.texto.trim() : '';
      if (corrigido && corrigido !== pedido.texto && corrigido.length < pedido.texto.length * 1.5 + 40) {
        pedido.textoOriginal = pedido.texto;
        pedido.texto = corrigido;
      }
      projeto = projetos.find((p) => p.id === escolha.projeto);
      if (!projeto) {
        pedido.status = 'sem_projeto';
        pedido.erro = `Não identifiquei o projeto. ${escolha.motivo || ''} Escolha o projeto na lista e envie de novo.`;
        return salvar(pedido);
      }
      pedido.projeto = projeto.id;
    }
    if (!projeto.ativo) {
      pedido.status = 'erro';
      pedido.erro = `O projeto "${projeto.nome}" está indisponível: ${projeto.motivo || 'sem motivo cadastrado'}.`;
      return salvar(pedido);
    }
    // Primeira vez do projeto nesta máquina: clona do GitHub.
    if (!fs.existsSync(projeto.pasta) && projeto.repo) {
      log(pedido.id, `[brain] clonando ${projeto.repo} em ${projeto.pasta}`);
      fs.mkdirSync(path.dirname(projeto.pasta), { recursive: true });
      const c = await rodar('gh', ['repo', 'clone', projeto.repo, projeto.pasta], { cwd: path.dirname(projeto.pasta) });
      if (c.codigo !== 0) {
        pedido.status = 'erro';
        pedido.erro = `Não consegui clonar ${projeto.repo}: ${(c.erro || c.saida).slice(0, 300)}`;
        return salvar(pedido);
      }
    }
    if (!fs.existsSync(projeto.pasta)) {
      pedido.status = 'erro';
      pedido.erro = `A pasta do projeto não existe: ${projeto.pasta}`;
      return salvar(pedido);
    }

    pedido.status = 'executando';
    pedido.agente ||= projeto.agente || 'claude';
    salvar(pedido);
    log(pedido.id, `[brain] ${pedido.agente} em ${projeto.pasta}`);

    const r = await executar(pedido, projeto);
    const atual = carregar(pedido.id);
    if (atual?.status === 'cancelado') return;
    pedido.resultado = r.texto;
    pedido.status = r.erro ? 'erro' : 'concluido';
    if (r.erro) pedido.erro = `O agente terminou com erro (código ${r.codigo}). Veja o log.`;
    salvar(pedido);
  } catch (e) {
    emExecucao.delete(pedido.id);
    pedido.status = 'erro';
    pedido.erro = String(e.message || e);
    salvar(pedido);
  }
}

// ---------- HTTP ----------

function responder(res, status, corpo) {
  const json = JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on('data', (d) => {
      tamanho += d.length;
      if (tamanho > LIMITE_CORPO) {
        reject(new Error('pedido grande demais (limite de 60 MB)'));
        req.destroy();
      } else partes.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

// Um site qualquer aberto no navegador não pode disparar agentes: só aceita
// pedidos vindos da própria página (mesma origem, JSON e cabeçalho próprio).
function origemConfiavel(req) {
  const host = (req.headers.host || '').split(':')[0];
  if (!HOSTS.has(host)) return false;
  if (req.method === 'GET') return true;
  const origem = req.headers.origin;
  if (origem && !HOSTS.has(new URL(origem).hostname)) return false;
  return req.headers['x-brain'] === '1' && (req.headers['content-type'] || '').startsWith('application/json');
}

function novoId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const data = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${data}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- conexões dos agentes ----------
// O login do Claude, do Codex e do GitHub é feito pela própria página: o Brain
// inicia o login oficial de cada ferramenta nesta máquina, mostra o link de
// autorização e a credencial fica guardada aqui (em HOME), não em variáveis.

const CONEXOES = {
  claude: {
    nome: 'Claude',
    login: ['claude', ['auth', 'login', '--claudeai']],
    status: ['claude', ['auth', 'status', '--json']],
    // A página de autorização devolve um código para colar; o login é uma tela
    // interativa, então no Linux roda dentro de um pseudo-terminal.
    pedeCodigo: true,
    pty: true,
  },
  codex: {
    nome: 'Codex',
    login: ['codex', ['login', '--device-auth']],
    status: ['codex', ['login', 'status']],
  },
  github: {
    nome: 'GitHub',
    login: ['gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key']],
    status: ['gh', ['auth', 'status']],
    depois: () => spawnSync('gh', ['auth', 'setup-git'], { windowsHide: true }),
  },
};

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const logins = new Map(); // id -> login em andamento ou o último resultado
let cacheStatus = null;

function matar(filho) {
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(filho.pid), '/T', '/F'], { windowsHide: true });
  else filho.kill('SIGTERM');
}

async function statusConexoes() {
  if (cacheStatus && Date.now() - cacheStatus.em < 30000) return cacheStatus.valores;
  const pares = await Promise.all(
    Object.entries(CONEXOES).map(async ([id, c]) => {
      const r = await rodar(c.status[0], c.status[1], { cwd: DADOS });
      let ok = r.codigo === 0;
      if (id === 'claude') {
        try {
          const j = JSON.parse(r.saida);
          if (typeof j.loggedIn === 'boolean') ok = j.loggedIn;
        } catch {}
      }
      return [id, ok];
    }),
  );
  cacheStatus = { em: Date.now(), valores: Object.fromEntries(pares) };
  return cacheStatus.valores;
}

function iniciarLogin(id) {
  const c = CONEXOES[id];
  const anterior = logins.get(id);
  if (anterior?.estado === 'aguardando') matar(anterior.filho);

  const [cmd, args] = c.login;
  const opcoes = { env: ambienteDoAgente(), cwd: DADOS, windowsHide: true };
  const filho =
    c.pty && process.platform === 'linux'
      ? // Terminal largo para o link de autorização não ser quebrado em várias linhas.
        spawn('script', ['-qfec', `stty cols 4000 rows 50; exec ${[cmd, ...args].join(' ')}`, '/dev/null'], opcoes)
      : spawn(cmd, args, opcoes);

  const login = { filho, saida: '', url: '', codigo: '', estado: 'aguardando', erro: '', pedeCodigo: !!c.pedeCodigo };
  logins.set(id, login);

  const ler = (d) => {
    login.saida = (login.saida + d.toString().replace(ANSI, '')).slice(-8000);
    login.url = login.saida.match(/https:\/\/[^\s"'<>]+/)?.[0] ?? '';
    if (!c.pedeCodigo) login.codigo = login.saida.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0] ?? '';
  };
  filho.stdout.on('data', ler);
  filho.stderr.on('data', ler);

  const limite = setTimeout(() => {
    if (login.estado !== 'aguardando') return;
    login.estado = 'erro';
    login.erro = 'tempo esgotado (10 minutos)';
    matar(filho);
  }, 10 * 60 * 1000);

  filho.on('error', (e) => {
    clearTimeout(limite);
    login.estado = 'erro';
    login.erro = String(e.message || e);
  });
  filho.on('close', (codigo) => {
    clearTimeout(limite);
    cacheStatus = null;
    if (login.estado !== 'aguardando') return;
    if (codigo === 0) {
      c.depois?.();
      login.estado = 'ok';
    } else {
      login.estado = 'erro';
      login.erro = login.saida.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `terminou com código ${codigo}`;
    }
  });
  return login;
}

const verLogin = (l) => l && { estado: l.estado, url: l.url, codigo: l.codigo, pedeCodigo: l.pedeCodigo, erro: l.erro };

async function rotasConexoes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/conexoes') {
    const status = await statusConexoes();
    return responder(
      res,
      200,
      Object.entries(CONEXOES).map(([id, c]) => ({ id, nome: c.nome, conectado: !!status[id], login: verLogin(logins.get(id)) })),
    );
  }
  const m = url.pathname.match(/^\/api\/conexoes\/(claude|codex|github)\/(entrar|codigo)$/);
  if (!m || req.method !== 'POST') return responder(res, 404, { erro: 'rota não encontrada' });
  const [, id, acao] = m;

  if (acao === 'entrar') {
    await lerCorpo(req);
    const login = iniciarLogin(id);
    // Espera o link de autorização aparecer na saída do login.
    for (let i = 0; i < 40 && login.estado === 'aguardando' && !login.url; i++) await new Promise((r) => setTimeout(r, 500));
    return responder(res, 200, verLogin(login));
  }

  const login = logins.get(id);
  if (login?.estado !== 'aguardando') return responder(res, 409, { erro: 'não há login em andamento' });
  const codigo = String(JSON.parse(await lerCorpo(req)).codigo || '').replace(/[\r\n]/g, '').trim();
  if (!codigo) return responder(res, 400, { erro: 'cole o código' });
  login.filho.stdin.write(codigo + '\r');
  responder(res, 200, { ok: true });
}

// ---------- login (só quando há BRAIN_SENHA) ----------

const sessoes = new Map(); // token -> validade (ms)
const falhas = new Map(); // ip -> { n, ate }
const SESSAO_MS = 30 * 24 * 60 * 60 * 1000;

function logado(req) {
  if (!SENHA) return true;
  const token = (req.headers.cookie || '').match(/(?:^|;\s*)central_sessao=([a-f0-9]{64})/)?.[1];
  const validade = token && sessoes.get(token);
  if (!validade || validade < Date.now()) return false;
  return true;
}

async function entrar(req, res) {
  const ip = req.socket.remoteAddress || '?';
  const f = falhas.get(ip);
  if (f && f.n >= 8 && f.ate > Date.now()) return responder(res, 429, { erro: 'muitas tentativas; aguarde 15 minutos' });
  const { senha } = JSON.parse(await lerCorpo(req));
  const a = crypto.createHash('sha256').update(String(senha ?? '')).digest();
  const b = crypto.createHash('sha256').update(SENHA).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    falhas.set(ip, { n: (f && f.ate > Date.now() ? f.n : 0) + 1, ate: Date.now() + 15 * 60 * 1000 });
    await new Promise((r) => setTimeout(r, 800));
    return responder(res, 401, { erro: 'senha incorreta' });
  }
  falhas.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessoes.set(token, Date.now() + SESSAO_MS);
  const seguro = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('set-cookie', `central_sessao=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSAO_MS / 1000}${seguro}`);
  responder(res, 200, { ok: true });
}

// ---------- WhatsApp (entrada) ----------
// Por enquanto só captura: guarda em disco o que chegar do grupo de comandos,
// para conhecermos o formato real antes de transformar em pedido.

const CAPTURAS = path.join(DADOS, 'whatsapp');

async function webhookWhatsapp(req, res, caminho) {
  const fim = (status) => {
    res.writeHead(status);
    res.end();
  };
  try {
    const token = cfg('BRAIN_WEBHOOK_TOKEN');
    const grupo = cfg('BRAIN_WHATSAPP_GRUPO');
    if (!token || !grupo) return fim(503);
    if (req.method !== 'POST' || caminho !== `/wa/${token}`) return fim(404);
    const corpo = await lerCorpo(req);
    // Tudo que não for do grupo de comandos é descartado sem guardar nada.
    if (corpo.includes(grupo)) {
      fs.mkdirSync(CAPTURAS, { recursive: true });
      fs.writeFileSync(path.join(CAPTURAS, `${novoId()}.json`), corpo);
    }
    fim(200);
  } catch {
    fim(400);
  }
}

const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // O webhook vem do servidor da Stevo, não do navegador: vale o token do caminho.
    if (url.pathname.startsWith('/wa/')) return webhookWhatsapp(req, res, url.pathname);

    if (!origemConfiavel(req)) return responder(res, 403, { erro: 'origem não permitida' });
    const rota = `${req.method} ${url.pathname}`;

    if (rota === 'GET /') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(RAIZ, 'index.html')));
    }
    if (rota === 'POST /api/login' && SENHA) return entrar(req, res);
    if (!logado(req)) return responder(res, 401, { erro: 'faça login' });
    if (url.pathname.startsWith('/api/conexoes')) return await rotasConexoes(req, res, url);
    if (rota === 'GET /api/projetos') {
      return responder(
        res,
        200,
        lerProjetos().map(({ id, nome, ativo, motivo, descricao }) => ({ id, nome, ativo, motivo, descricao })),
      );
    }
    if (rota === 'GET /api/pedidos') return responder(res, 200, listar().slice(0, 50));

    const comId = url.pathname.match(/^\/api\/pedidos\/([\w-]+)(\/cancelar)?$/);
    if (comId && req.method === 'GET' && !comId[2]) {
      const pedido = carregar(comId[1]);
      if (!pedido) return responder(res, 404, { erro: 'pedido não encontrado' });
      const saida = fs.existsSync(arquivoLog(pedido.id)) ? fs.readFileSync(arquivoLog(pedido.id), 'utf8') : '';
      return responder(res, 200, { ...pedido, log: saida.slice(-60000) });
    }
    if (comId && req.method === 'POST' && comId[2]) {
      const pedido = carregar(comId[1]);
      if (!pedido) return responder(res, 404, { erro: 'pedido não encontrado' });
      const filho = emExecucao.get(pedido.id);
      if (!filho) return responder(res, 409, { erro: 'este pedido não está em execução' });
      pedido.status = 'cancelado';
      salvar(pedido);
      // No Windows o agente abre processos filhos; /T encerra a árvore toda.
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(filho.pid), '/T', '/F'], { windowsHide: true });
      else filho.kill('SIGTERM');
      return responder(res, 200, { ok: true });
    }

    if (rota === 'POST /api/pedidos') {
      const corpo = JSON.parse(await lerCorpo(req));
      const texto = String(corpo.texto || '').trim();
      if (!texto) return responder(res, 400, { erro: 'escreva ou dite o pedido' });
      const id = novoId();
      const dirAnexos = path.join(PEDIDOS, id, 'anexos');
      fs.mkdirSync(dirAnexos, { recursive: true });
      const anexos = [];
      for (const a of corpo.anexos || []) {
        const nome = path.basename(String(a.nome || 'anexo')).replace(/[<>:"/\\|?*]/g, '_');
        const destino = path.join(dirAnexos, nome);
        fs.writeFileSync(destino, Buffer.from(String(a.base64 || ''), 'base64'));
        anexos.push(destino);
      }
      const pedido = {
        id,
        texto,
        agente: corpo.agente === 'codex' ? 'codex' : corpo.agente === 'claude' ? 'claude' : null,
        projeto: corpo.projeto && corpo.projeto !== 'auto' ? String(corpo.projeto) : null,
        anexos,
        status: 'recebido',
        criadoEm: new Date().toISOString(),
      };
      salvar(pedido);
      processar(pedido);
      return responder(res, 201, pedido);
    }

    responder(res, 404, { erro: 'rota não encontrada' });
  } catch (e) {
    responder(res, 500, { erro: String(e.message || e) });
  }
});

servidor.listen(PORTA, HOST, () => {
  console.log(`[brain] no ar em http://${LOCAL ? 'localhost' : HOST}:${PORTA} · login ${SENHA ? 'ligado' : 'desligado (só local)'} · ${lerProjetos().length} projetos · dados em ${DADOS}`);
});
