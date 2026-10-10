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
  avisarWhatsapp(pedido);
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
  if (['recebido', 'roteando', 'na_fila', 'executando'].includes(p.status)) {
    p.status = 'interrompido';
    p.erro = 'O servidor do Brain reiniciou durante a execução.';
    // Grava direto: nesta altura o resto do servidor (avisos do WhatsApp) ainda não foi carregado.
    fs.writeFileSync(arquivoPedido(p.id), JSON.stringify(p, null, 2));
  }
}

// ---------- processos ----------

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

// ---------- agentes ----------
// A conversa é uma só. Cada pedido de trabalho é entregue a um dos oito agentes,
// que trabalham em paralelo. Um agente guarda a sessão do último trabalho, então
// dá para continuar falando com ele ("Trixie, muda também o rodapé").

const NOMES = ['Junior', 'Trixie', 'Flocos', 'Ágato', 'Guará', 'Marsha', 'Dino', 'Paçoca'];
const ARQ_AGENTES = path.join(DADOS, 'agentes.json');
const agentes = new Map(NOMES.map((nome) => [nome, { nome, ocupado: null, sessao: null, motor: null, projeto: null, pasta: null, usadoEm: 0, resumo: '' }]));
try {
  for (const a of JSON.parse(fs.readFileSync(ARQ_AGENTES, 'utf8'))) {
    if (agentes.has(a.nome)) Object.assign(agentes.get(a.nome), a, { ocupado: null });
  }
} catch {}
const salvarAgentes = () => fs.writeFileSync(ARQ_AGENTES, JSON.stringify([...agentes.values()], null, 2));

const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const acharAgente = (nome) => [...agentes.values()].find((a) => semAcento(a.nome) === semAcento(nome ?? ''));

const fila = []; // ids de pedidos esperando um agente
const atividade = new Map(); // id do pedido -> passos recentes (o que o agente está fazendo)

function passo(id, texto) {
  log(id, `  → ${texto}`);
  const lista = atividade.get(id) ?? [];
  lista.push(texto);
  atividade.set(id, lista.slice(-40));
}

// ---------- consumo ----------
// O que cada chamada ao modelo gastou. O custo é o equivalente no preço da API:
// como os agentes rodam pela assinatura, ele serve de medida, não é cobrança.
function usoDoClaude(json) {
  const u = json?.usage;
  if (!u) return null;
  return {
    entrada: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    saida: u.output_tokens ?? 0,
    cache: u.cache_read_input_tokens ?? 0,
    custo: json.total_cost_usd ?? 0,
  };
}
function somarUso(pedido, uso) {
  if (!uso) return;
  const a = pedido.uso ?? { entrada: 0, saida: 0, cache: 0, custo: 0 };
  pedido.uso = { entrada: a.entrada + uso.entrada, saida: a.saida + uso.saida, cache: a.cache + uso.cache, custo: a.custo + uso.custo };
}

// ---------- roteador ----------

const curto = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

function contextoDaConversa(idAtual) {
  const recentes = listar().filter((p) => p.id !== idAtual).slice(0, 10).reverse();
  const historico = recentes
    .map((p) => {
      const resposta = p.resultado ? `\n${p.agente || 'Brain'}${p.projeto ? ` (${p.projeto})` : ''}: ${curto(p.resultado, 350)}` : '';
      return `${lerPerfil().nome}: ${curto(p.texto, 300)}${resposta}`;
    })
    .join('\n');
  const equipe = [...agentes.values()]
    .map((a) => {
      if (a.ocupado) return `- ${a.nome}: TRABALHANDO AGORA${a.projeto ? ` em ${a.projeto}` : ''} — "${curto(a.resumo, 160)}"`;
      if (a.sessao) return `- ${a.nome}: livre; último trabalho${a.projeto ? ` em ${a.projeto}` : ''} — "${curto(a.resumo, 160)}"`;
      return `- ${a.nome}: livre, ainda sem trabalho`;
    })
    .join('\n');
  return { historico, equipe };
}

async function rotear(pedido, projetos) {
  const catalogo = projetos
    .map(
      (p) =>
        `- id: ${p.id} | nome: ${p.nome} | apelidos: ${p.apelidos.join(', ') || '-'} | ` +
        `${p.ativo ? 'disponível' : 'INDISPONÍVEL: ' + (p.motivo || '')} | ${p.descricao || ''}`,
    )
    .join('\n');
  const { historico, equipe } = contextoDaConversa(pedido.id);
  const prompt =
    `Você é o Brain, o assistente pessoal de ${lerPerfil().nome}. Ele conversa com você como num WhatsApp, quase sempre por voz. ` +
    `A transcrição erra nomes próprios: troca por palavras comuns de som parecido (ex.: "visando tarefas", "vizando" ` +
    `ou "bizantu" = Vizantu Tarefas; "renã" = Renan; "tauper" = Tawper). Leia pelo SOM e pelo sentido, não pela grafia.\n\n` +
    `Você coordena oito agentes que executam trabalho: ${NOMES.join(', ')}. Para cada mensagem, decida o TIPO:\n\n` +
    `- "resposta": você mesmo responde agora, de cabeça. Use para conversa, contas, definições, dúvidas simples e ` +
    `perguntas sobre a equipe ou sobre o que já foi conversado (use o histórico e o estado da equipe abaixo). ` +
    `Escreva a resposta no campo "resposta", em português, curta e natural. Só use se tiver certeza: nada que ` +
    `dependa de fatos recentes, de pesquisa ou de olhar dentro de um projeto.\n` +
    `- "geral": precisa de pesquisa na internet ou de informação atual (notícias, leis, preços, o que mudou em tal ` +
    `data), ou é um trabalho que não pertence a nenhum projeto (escrever um texto, analisar um anexo, comparar opções).\n` +
    `- "projeto": é trabalho ou pergunta sobre um dos projetos da lista. Escolha o mais provável: não precisa de ` +
    `concordância exata, basta ser a leitura mais natural. O projeto "brain" só vale quando o assunto é este próprio ` +
    `sistema ou as anotações pessoais.\n` +
    `- "continuar": a mensagem é para um agente que já está no assunto. Vale quando ele chama o agente pelo nome e ` +
    `também quando NÃO chama, mas a mensagem só faz sentido como sequência da conversa: usa "ele", "isso", "esse", ` +
    `"e...?", "também", "agora", pede mais detalhe, corrige ou aprofunda o que um agente acabou de responder ou de ` +
    `fazer. Nesse caso o agente é quem deu a última resposta sobre aquele assunto no histórico. Ponha o nome em ` +
    `"agente". Na dúvida entre "continuar" e abrir um pedido novo ("geral" ou "projeto") sobre o mesmo assunto, ` +
    `prefira "continuar": o agente já tem o contexto. Só abra pedido novo quando o assunto mudar de verdade. ` +
    `Perguntar SOBRE um agente (o que ele está fazendo, se já terminou, quem está livre) não é "continuar": é ` +
    `"resposta", e você responde com o estado da equipe.\n\n` +
    `Além disso, reescreva a mensagem em "texto" corrigindo SÓ os nomes que a transcrição errou (projetos, clientes, ` +
    `pessoas). Não mude o sentido, não resuma, não acrescente nada.\n\n` +
    `Projetos:\n${catalogo}\n\n` +
    `Vocabulário (nomes que ele costuma falar): ${lerVocabulario().join(', ')}\n\n` +
    `Estado da equipe:\n${equipe}\n\n` +
    `Histórico recente da conversa:\n${historico || '(conversa começando agora)'}\n\n` +
    `Mensagem nova${pedido.anexos.length ? ` (veio com ${pedido.anexos.length} anexo(s), que você não consegue abrir)` : ''}:\n` +
    `"""${pedido.texto}"""\n\n` +
    `Responda SOMENTE com um JSON: {"tipo":"resposta|geral|projeto|continuar","resposta":"<só no tipo resposta>",` +
    `"projeto":"<id ou null>","agente":"<nome ou null>","imagem":<true se ele pede para CRIAR ou EDITAR uma imagem ` +
    `(arte, post, logo, ilustração, foto); false para todo o resto, inclusive analisar uma imagem enviada ou ` +
    `escrever legenda>,"texto":"<mensagem com os nomes corrigidos>","motivo":"<uma frase>"}. ` +
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
    throw new Error(`O Claude não conseguiu ler a mensagem: ${(motivo || r.erro || r.saida).trim().slice(0, 400)}`);
  }
  const resposta = JSON.parse(r.saida);
  somarUso(pedido, usoDoClaude(resposta));
  const texto = resposta.result ?? '';
  const achado = texto.match(/\{[\s\S]*\}/);
  if (!achado) throw new Error('o roteador não devolveu JSON: ' + texto.slice(0, 200));
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

// A base de processos é o projeto marcado com "base": true no cadastro: lá ficam os
// passo a passos (POPs) e os contextos de clientes que valem para qualquer pedido.
function lerBase() {
  return lerProjetos().find((p) => p.base && p.ativo) ?? null;
}

// Deixa a base clonada e atualizada antes do agente começar. Sem ela o pedido segue.
async function prepararBase(pedido) {
  const base = lerBase();
  if (!base) return;
  if (!fs.existsSync(base.pasta)) {
    if (!base.repo) return;
    passo(pedido.id, `clonando ${base.repo}`);
    fs.mkdirSync(path.dirname(base.pasta), { recursive: true });
    const c = await rodar('gh', ['repo', 'clone', base.repo, base.pasta], { cwd: path.dirname(base.pasta) });
    if (c.codigo !== 0) log(pedido.id, `[brain] não consegui clonar a base ${base.repo}: ${(c.erro || c.saida).slice(0, 300)}`);
    return;
  }
  // Quando o pedido é na própria base, o agente já faz o git pull dele.
  if (pedido.projeto === base.id) return;
  const p = await rodar('git', ['pull', '--ff-only'], { cwd: base.pasta });
  if (p.codigo !== 0) log(pedido.id, `[brain] não consegui atualizar a base: ${(p.erro || p.saida).slice(0, 300)}`);
}

function regraDeProcessos(projeto) {
  const base = lerBase();
  if (!base || !fs.existsSync(base.pasta)) return '';
  const naBase = projeto?.id === base.id;
  const onde = naBase ? 'neste projeto' : `em "${base.pasta}" (${base.nome})`;
  return (
    `Temos passo a passo: não faça do jeito que você acha. Antes de produzir qualquer entrega (legenda, copy, roteiro, ` +
    `tarefa, plano, relatório, documento, mensagem para cliente), procure ${onde} o processo daquele tipo de entrega e o ` +
    `contexto do cliente envolvido, começando pelo CLAUDE.md/README, e siga o que estiver escrito. ` +
    (naBase ? '' : `Só leia essa pasta, não altere nada nela. `) +
    `Se não existir passo a passo para o que foi pedido, faça pelo seu melhor critério e avise em uma linha que não havia ` +
    `processo documentado. Se não souber de qual cliente é o pedido e isso mudar o resultado, pergunte antes.`
  );
}

function montarPrompt(pedido, agente, projeto, continuando) {
  const dir = path.join(PEDIDOS, pedido.id);
  const processos = regraDeProcessos(projeto);
  const anexos = pedido.anexos.length
    ? `\n\nAnexos desta mensagem (leia todos antes de começar):\n${pedido.anexos.map((a) => '- ' + a).join('\n')}`
    : '';
  const entrega =
    `Se produzir arquivos para entregar (documentos, imagens, planilhas), salve-os em "${path.join(dir, 'entrega')}": ` +
    `eles aparecem na conversa como anexos. Se o pedido for criar ou editar uma imagem, use a sua ferramenta de ` +
    `geração de imagem e salve o resultado (PNG ou JPG) nessa mesma pasta.`;
  const tom =
    `Responda em português, curto e direto, como numa conversa de WhatsApp. Quem lê é rápido e quer só o resultado: ` +
    `diga o que foi feito em uma ou duas frases (ex.: "Atualizei X no sistema. Commit e push feitos, pode fazer o ` +
    `deploy."). Não repita o que foi pedido, não narre o passo a passo, não liste arquivos nem justifique escolhas, ` +
    `a menos que ele peça os detalhes. Diga também, em uma linha, só o que ele precisa fazer ou saber (algo que ` +
    `falhou, ficou pendente ou depende dele). Pergunta factual: responda o que foi perguntado, sem introdução. ` +
    `Se o pedido não estiver claro, ou puder ser entendido de mais de um jeito que mude o resultado, NÃO execute ` +
    `nem chute: faça uma pergunta curta e objetiva (com opções, se ajudar) e pare. Dados em linhas e colunas vão em tabela markdown. Quando um gráfico ajudar de verdade a ver ` +
    `números (comparação, evolução, proporção) ou ele pedir, inclua um bloco de código com a linguagem "grafico" ` +
    `contendo só um JSON neste formato: {"tipo":"barras|linhas|pizza","titulo":"…","rotulos":["jan","fev"],` +
    `"series":[{"nome":"Receita","valores":[10,20]}],"prefixo":"R$ ","sufixo":""}. A conversa desenha o gráfico.`;

  // Continuação na mesma sessão: o agente já tem todo o contexto.
  if (continuando) return `${pedido.texto}${anexos}\n\n---\n${processos ? processos + ' ' : ''}${entrega} ${tom}`;

  // Pedido novo também recebe a conversa recente, para o agente não começar no escuro.
  const { historico } = contextoDaConversa(pedido.id);
  const conversa = historico ? `\nConversa recente (só para contexto; responda apenas à mensagem acima):\n${historico}\n` : '';
  const quem = `Você é ${agente.nome}, um dos agentes do Brain, o assistente pessoal de ${lerPerfil().nome}. Você está rodando sozinho, sem ninguém acompanhando.`;
  if (!projeto) {
    return (
      `${pedido.texto}${anexos}\n\n---\n${quem}\n${conversa}` +
      `Esta mensagem não é sobre um projeto específico. Regras:\n` +
      `1. Responda ao que foi pedido. Se depender de informação atual ou que você não tem certeza, pesquise na ` +
      `internet antes e cite as fontes em uma linha no final.\n` +
      `2. Não altere nenhum projeto nem repositório.\n` +
      (processos ? `3. ${processos}\n4. ${entrega}\n5. ${tom}` : `3. ${entrega}\n4. ${tom}`)
    );
  }
  return (
    `${pedido.texto}${anexos}\n\n---\n${quem} Projeto: "${projeto.nome}" (${projeto.pasta}).\n${conversa}` +
    `Regras:\n` +
    `1. Antes de mexer, entenda o projeto: leia CLAUDE.md/AGENTS.md/README e os commits recentes (git log).\n` +
    `2. ${regraDePublicacao(pedido, projeto)}\n` +
    `3. Use as skills e ferramentas do projeto quando existirem para o tipo de entrega pedido.\n` +
    `4. Se faltar informação essencial, não invente: pergunte antes de mexer.\n` +
    (processos ? `5. ${processos}\n6. ${entrega}\n7. ${tom}` : `5. ${entrega}\n6. ${tom}`)
  );
}

// Descreve uma ação do agente do jeito que aparece na conversa.
function descreverFerramenta(nome, i = {}) {
  const arquivo = (p) => path.basename(String(p ?? ''));
  const linha = (s, n = 110) => curto(String(s ?? '').split('\n')[0], n);
  if (nome === 'Read') return `lendo ${arquivo(i.file_path)}`;
  if (nome === 'Edit' || nome === 'Write' || nome === 'NotebookEdit') return `editando ${arquivo(i.file_path)}`;
  if (nome === 'Bash' || nome === 'PowerShell') return `rodando: ${linha(i.description || i.command)}`;
  if (nome === 'Grep' || nome === 'Glob') return `procurando ${linha(i.pattern, 60)}`;
  if (nome === 'WebSearch') return `pesquisando: ${linha(i.query, 90)}`;
  if (nome === 'WebFetch') return `abrindo ${linha(i.url, 80)}`;
  if (nome === 'Agent' || nome === 'Task') return `delegando: ${linha(i.description, 80)}`;
  if (nome === 'Skill') return `usando a skill ${linha(i.skill, 60)}`;
  return nome;
}

// Lê o stream-json do Claude Code: registra os passos e guarda a sessão e o resultado.
function leitorClaude(id) {
  let resto = '';
  let final = null;
  let sessao = null;
  const linha = (l) => {
    let ev;
    try {
      ev = JSON.parse(l);
    } catch {
      return log(id, l);
    }
    if (ev.session_id) sessao = ev.session_id;
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'text' && b.text.trim()) log(id, b.text.trim());
        if (b.type === 'tool_use') passo(id, descreverFerramenta(b.name, b.input));
      }
    } else if (ev.type === 'result') {
      final = { texto: ev.result ?? '', erro: !!ev.is_error, uso: usoDoClaude(ev) };
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
      return { final, sessao };
    },
  };
}

async function executar(pedido, agente, projeto, pasta, continuando) {
  const dir = path.join(PEDIDOS, pedido.id);
  fs.mkdirSync(path.join(dir, 'entrega'), { recursive: true });
  const registrar = (_, filho) => filho && emExecucao.set(pedido.id, filho);

  if (pedido.motor === 'codex') {
    // O Codex não retoma a sessão por aqui: a continuação leva um resumo do que veio antes.
    const antes = continuando && agente.resumo ? `Contexto: você está continuando este trabalho anterior: "${agente.resumo}".\n\n` : '';
    const ultima = path.join(dir, 'ultima-mensagem.txt');
    const r = await rodar(
      'codex',
      ['exec', '--approve-for-me', '--skip-git-repo-check', '-C', pasta, '--add-dir', dir, '-o', ultima, '-'],
      { cwd: pasta, entrada: antes + montarPrompt(pedido, agente, projeto, false), aoLer: (t, f) => (t ? log(pedido.id, t) : registrar(t, f)) },
    );
    if (r.erro.trim()) log(pedido.id, r.erro);
    const total = Number(((r.saida + r.erro).match(/tokens used[:\s]*([\d.,]+)/i)?.[1] ?? '').replace(/[.,]/g, '')) || 0;
    return {
      texto: fs.existsSync(ultima) ? fs.readFileSync(ultima, 'utf8') : '',
      erro: r.codigo !== 0,
      codigo: r.codigo,
      sessao: null,
      uso: total ? { entrada: total, saida: 0, cache: 0, custo: 0 } : null,
    };
  }

  const tentar = async (retomar) => {
    const leitor = leitorClaude(pedido.id);
    const args = ['-p', '--permission-mode', 'auto', '--add-dir', dir, '--output-format', 'stream-json', '--verbose'];
    if (retomar) args.push('--resume', agente.sessao);
    // Fora de um projeto o agente pode pesquisar na internet sem pedir permissão.
    if (!projeto) args.push('--allowedTools', 'WebSearch', 'WebFetch');
    const r = await rodar('claude', args, {
      cwd: pasta,
      entrada: montarPrompt(pedido, agente, projeto, retomar),
      aoLer: (t, f) => (t ? leitor.ler(t) : registrar(t, f)),
    });
    const { final, sessao } = leitor.fim();
    if (r.erro.trim()) log(pedido.id, r.erro);
    return { texto: final?.texto ?? '', erro: r.codigo !== 0 || !!final?.erro, codigo: r.codigo, sessao, uso: final?.uso ?? null };
  };

  let r = await tentar(continuando && !!agente.sessao);
  // Se a sessão antiga não puder ser retomada, recomeça do zero em vez de falhar.
  if (r.erro && continuando && agente.sessao && !r.texto && carregar(pedido.id)?.status !== 'cancelado') {
    log(pedido.id, '[brain] não deu para retomar a sessão; começando uma nova');
    r = await tentar(false);
  }
  return r;
}

function falhar(pedido, mensagem) {
  pedido.status = 'erro';
  pedido.erro = mensagem;
  salvar(pedido);
}

// Lê a mensagem, decide o que ela é e, se for trabalho, entrega a um agente.
async function processar(pedido) {
  try {
    const projetos = lerProjetos();
    const conexoes = await statusConexoes();
    if (!conexoes.claude) return falhar(pedido, 'O Claude não está conectado nesta máquina. Abra Conexões (a engrenagem no topo) e clique em Conectar.');

    pedido.status = 'roteando';
    salvar(pedido);

    let alvo = acharAgente(pedido.para);
    let projeto = projetos.find((p) => p.id === pedido.projeto);
    // Agente sem trabalho anterior não tem o que continuar: a mensagem é roteada
    // normalmente e ele só fica como o preferido para pegar o pedido.
    if (alvo && !alvo.sessao && !alvo.ocupado) {
      pedido.preferir = alvo.nome;
      pedido.para = null;
      alvo = null;
    }

    if (alvo) {
      pedido.tipo = 'continuar';
    } else if (projeto) {
      pedido.tipo = 'projeto';
    } else {
      const escolha = await rotear(pedido, projetos);
      pedido.roteador = { tipo: escolha.tipo, motivo: escolha.motivo };
      // O agente recebe a mensagem com os nomes corrigidos; o ditado original fica guardado.
      const corrigido = typeof escolha.texto === 'string' ? escolha.texto.trim() : '';
      if (corrigido && corrigido !== pedido.texto && corrigido.length < pedido.texto.length * 1.5 + 40) {
        pedido.textoOriginal = pedido.texto;
        pedido.texto = corrigido;
      }
      pedido.tipo = ['resposta', 'geral', 'projeto', 'continuar'].includes(escolha.tipo) ? escolha.tipo : 'geral';
      // O roteador não abre anexos: com anexo, quem responde é um agente.
      if (pedido.tipo === 'resposta' && (pedido.anexos.length || !String(escolha.resposta || '').trim())) pedido.tipo = 'geral';
      // Criar ou editar imagem é trabalho do Codex, que tem a ferramenta de geração de imagem.
      if (escolha.imagem === true) {
        pedido.motor = 'codex';
        if (pedido.tipo === 'resposta') pedido.tipo = 'geral';
      }

      if (pedido.tipo === 'resposta') {
        pedido.agente = 'Brain';
        pedido.resultado = String(escolha.resposta).trim();
        pedido.status = 'concluido';
        return salvar(pedido);
      }
      if (pedido.tipo === 'continuar') {
        alvo = acharAgente(escolha.agente);
        // Agente sem trabalho anterior não tem o que continuar: vira um pedido novo.
        // Também vira pedido novo quando é imagem e o agente estava trabalhando com o Claude.
        if (!alvo || (!alvo.sessao && !alvo.ocupado) || (escolha.imagem === true && alvo.motor !== 'codex')) {
          if (alvo && !alvo.ocupado) pedido.preferir = alvo.nome;
          alvo = null;
          pedido.tipo = escolha.projeto ? 'projeto' : 'geral';
        }
      }
      if (pedido.tipo === 'projeto') {
        projeto = projetos.find((p) => p.id === escolha.projeto);
        if (!projeto) pedido.tipo = 'geral';
      }
    }

    if (alvo) {
      pedido.para = alvo.nome;
      pedido.projeto = alvo.projeto;
    } else if (pedido.tipo === 'projeto') {
      if (!projeto.ativo) return falhar(pedido, `O projeto "${projeto.nome}" está indisponível: ${projeto.motivo || 'sem motivo cadastrado'}.`);
      pedido.projeto = projeto.id;
    } else {
      pedido.projeto = null;
    }
    pedido.status = 'na_fila';
    salvar(pedido);
    fila.push(pedido.id);
    despachar();
  } catch (e) {
    falhar(pedido, String(e.message || e));
  }
}

// Entrega os pedidos da fila aos agentes livres. Uma continuação espera o agente dela.
function despachar() {
  for (const id of [...fila]) {
    const pedido = carregar(id);
    if (!pedido || pedido.status !== 'na_fila') {
      fila.splice(fila.indexOf(id), 1);
      continue;
    }
    let agente;
    if (pedido.para) {
      agente = acharAgente(pedido.para);
      if (agente.ocupado) continue;
    } else {
      const livres = [...agentes.values()].filter((a) => !a.ocupado).sort((a, b) => a.usadoEm - b.usadoEm);
      agente = livres.find((a) => a.nome === pedido.preferir) ?? livres[0];
      if (!agente) break;
    }
    fila.splice(fila.indexOf(id), 1);
    agente.ocupado = pedido.id;
    trabalhar(pedido, agente);
  }
}

async function trabalhar(pedido, agente) {
  try {
    const continuando = !!pedido.para;
    const projeto = lerProjetos().find((p) => p.id === pedido.projeto) ?? null;
    let pasta;

    if (continuando && agente.pasta && fs.existsSync(agente.pasta)) {
      pasta = agente.pasta;
    } else if (projeto) {
      // Primeira vez do projeto nesta máquina: clona do GitHub.
      if (!fs.existsSync(projeto.pasta) && projeto.repo) {
        passo(pedido.id, `clonando ${projeto.repo}`);
        fs.mkdirSync(path.dirname(projeto.pasta), { recursive: true });
        const c = await rodar('gh', ['repo', 'clone', projeto.repo, projeto.pasta], { cwd: path.dirname(projeto.pasta) });
        if (c.codigo !== 0) return falhar(pedido, `Não consegui clonar ${projeto.repo}: ${(c.erro || c.saida).slice(0, 300)}`);
      }
      if (!fs.existsSync(projeto.pasta)) return falhar(pedido, `A pasta do projeto não existe: ${projeto.pasta}`);
      pasta = projeto.pasta;
    } else {
      pasta = path.join(DADOS, 'geral');
      fs.mkdirSync(pasta, { recursive: true });
    }

    await prepararBase(pedido);

    pedido.motor = pedido.motor || (continuando && agente.motor) || projeto?.motor || projeto?.agente || 'claude';
    const conexoes = await statusConexoes();
    if (!conexoes[pedido.motor]) return falhar(pedido, `${CONEXOES[pedido.motor].nome} não está conectado nesta máquina. Abra Conexões e clique em Conectar.`);

    pedido.agente = agente.nome;
    pedido.status = 'executando';
    pedido.iniciadoEm = new Date().toISOString();
    salvar(pedido);
    log(pedido.id, `[brain] ${agente.nome} (${pedido.motor}) em ${pasta}`);

    // Uma continuação soma ao resumo; um pedido novo substitui.
    Object.assign(agente, { projeto: pedido.projeto, pasta, motor: pedido.motor, usadoEm: Date.now(), resumo: continuando && agente.resumo ? `${agente.resumo} / depois: ${curto(pedido.texto, 120)}` : curto(pedido.texto, 200) });
    if (!continuando) agente.sessao = null;
    salvarAgentes();

    const r = await executar(pedido, agente, projeto, pasta, continuando);
    if (r.sessao) agente.sessao = r.sessao;

    const dirEntrega = path.join(PEDIDOS, pedido.id, 'entrega');
    const entregas = fs.readdirSync(dirEntrega).map((nome) => ({ nome, tamanho: fs.statSync(path.join(dirEntrega, nome)).size }));

    if (carregar(pedido.id)?.status === 'cancelado') return;
    pedido.resultado = r.texto;
    somarUso(pedido, r.uso);
    pedido.entregas = entregas;
    pedido.status = r.erro ? 'erro' : 'concluido';
    if (r.erro) pedido.erro = r.texto ? 'O agente terminou com erro.' : `O agente terminou com erro (código ${r.codigo}) e sem resposta. Veja o log.`;
    salvar(pedido);
  } catch (e) {
    if (carregar(pedido.id)?.status !== 'cancelado') falhar(pedido, String(e.message || e));
  } finally {
    emExecucao.delete(pedido.id);
    atividade.delete(pedido.id);
    agente.ocupado = null;
    agente.usadoEm = Date.now();
    salvarAgentes();
    despachar();
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

// ---------- transcrição de áudio ----------
// Única parte paga por uso (API da OpenAI). A lista de nomes vai junto para o
// modelo acertar "Vizantu", "Lourival" etc.; o roteador ainda corrige o que sobrar.

async function transcrever(audioBase64, tipo) {
  const chave = cfg('OPENAI_API_KEY');
  if (!chave) throw new Error('transcrição desligada: falta OPENAI_API_KEY');
  const ext = /mp4|m4a|aac/.test(tipo) ? 'mp4' : /ogg/.test(tipo) ? 'ogg' : /wav/.test(tipo) ? 'wav' : /mpeg|mp3/.test(tipo) ? 'mp3' : 'webm';
  const audio = new Blob([Buffer.from(audioBase64, 'base64')], { type: tipo.split(';')[0] || 'audio/webm' });
  const nomes = [...new Set([...lerVocabulario(), ...lerProjetos().map((p) => p.nome)])].join(', ');

  const tentar = async (modelo) => {
    const form = new FormData();
    form.append('file', audio, `audio.${ext}`);
    form.append('model', modelo);
    form.append('language', 'pt');
    form.append('prompt', nomes);
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${chave}` },
      body: form,
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, texto: j.text ?? '', erro: j.error?.message ?? '' };
  };

  const preferido = cfg('BRAIN_TRANSCRICAO_MODELO') || 'gpt-4o-transcribe';
  let r = await tentar(preferido);
  // Se a conta não tiver o modelo preferido, cai no Whisper clássico.
  if (!r.ok && r.status !== 401 && preferido !== 'whisper-1') r = await tentar('whisper-1');
  if (!r.ok) throw new Error(`transcrição falhou (${r.status}): ${r.erro}`.slice(0, 300));
  return r.texto.trim();
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

// As sessões ficam em disco (só o hash do token) para o login sobreviver a
// reinícios e redeploys do servidor.
const ARQ_SESSOES = path.join(DADOS, 'sessoes.json');
const hashDe = (token) => crypto.createHash('sha256').update(token).digest('hex');
const sessoes = new Map(); // hash do token -> validade (ms)
try {
  for (const [h, validade] of Object.entries(JSON.parse(fs.readFileSync(ARQ_SESSOES, 'utf8')))) {
    if (validade > Date.now()) sessoes.set(h, validade);
  }
} catch {}
const salvarSessoes = () => fs.writeFileSync(ARQ_SESSOES, JSON.stringify(Object.fromEntries(sessoes)), { mode: 0o600 });
const falhas = new Map(); // ip -> { n, ate }
const SESSAO_MS = 90 * 24 * 60 * 60 * 1000;

// A senha trocada pela página fica guardada (scrypt) e passa a valer no lugar de BRAIN_SENHA.
const ARQ_SENHA = path.join(DADOS, 'senha.json');
function senhaConfere(tentativa) {
  let guardada = null;
  try {
    guardada = JSON.parse(fs.readFileSync(ARQ_SENHA, 'utf8'));
  } catch {}
  if (guardada) {
    const h = crypto.scryptSync(String(tentativa ?? ''), Buffer.from(guardada.sal, 'hex'), 64);
    return crypto.timingSafeEqual(h, Buffer.from(guardada.hash, 'hex'));
  }
  const a = crypto.createHash('sha256').update(String(tentativa ?? '')).digest();
  const b = crypto.createHash('sha256').update(SENHA).digest();
  return crypto.timingSafeEqual(a, b);
}
function gravarSenha(nova) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(nova, sal, 64);
  fs.writeFileSync(ARQ_SENHA, JSON.stringify({ sal: sal.toString('hex'), hash: hash.toString('hex') }), { mode: 0o600 });
}
const tokenDaSessao = (req) => (req.headers.cookie || '').match(/(?:^|;\s*)central_sessao=([a-f0-9]{64})/)?.[1];

function logado(req) {
  if (!SENHA) return true;
  const token = (req.headers.cookie || '').match(/(?:^|;\s*)central_sessao=([a-f0-9]{64})/)?.[1];
  const validade = token && sessoes.get(hashDe(token));
  if (!validade || validade < Date.now()) return false;
  return true;
}

async function entrar(req, res) {
  const ip = req.socket.remoteAddress || '?';
  const f = falhas.get(ip);
  if (f && f.n >= 8 && f.ate > Date.now()) return responder(res, 429, { erro: 'muitas tentativas; aguarde 15 minutos' });
  const { senha } = JSON.parse(await lerCorpo(req));
  if (!senhaConfere(senha)) {
    falhas.set(ip, { n: (f && f.ate > Date.now() ? f.n : 0) + 1, ate: Date.now() + 15 * 60 * 1000 });
    await new Promise((r) => setTimeout(r, 800));
    return responder(res, 401, { erro: 'senha incorreta' });
  }
  falhas.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessoes.set(hashDe(token), Date.now() + SESSAO_MS);
  salvarSessoes();
  const seguro = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('set-cookie', `central_sessao=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSAO_MS / 1000}${seguro}`);
  responder(res, 200, { ok: true });
}

// ---------- WhatsApp ----------
// O grupo de comandos funciona como a conversa do site: o que qualquer
// participante escreve lá vira pedido, e a resposta volta para o mesmo grupo.
// Mensagens de outros grupos e de conversas particulares são descartadas.
//
// O formato do webhook da Stevo não está documentado; a leitura abaixo segue o
// formato das bibliotecas em que ela se baseia e procura os campos de forma
// tolerante. As últimas mensagens do grupo ficam guardadas para conferência.

const CAPTURAS = path.join(DADOS, 'whatsapp');
const MARCA = '\u200b'; // caractere invisível no começo do que o Brain envia, para ele não ler a própria resposta
const idsVistos = new Set(); // mensagens já tratadas (o webhook pode repetir)
const estadoWhatsapp = { ultimoEvento: null, ultimoErro: null, chamadas: 0, ultimaChamada: null, estruturas: [], tentativas: [] };

// Só a forma da chamada, sem conteúdo: nomes dos campos e tipos. Textos viram o
// tamanho; números de telefone e ids de conversa são mascarados, sobrando só o
// tipo (@g.us, @s.whatsapp.net…) e se é ou não o grupo de comandos.
function estrutura(valor, chave = '', nivel = 0) {
  if (typeof valor === 'string') {
    if (valor.includes('@')) {
      const ehOGrupo = valor.startsWith(cfg('BRAIN_WHATSAPP_GRUPO').split('@')[0]);
      return `${ehOGrupo ? 'GRUPO-DE-COMANDOS' : '…'}@${valor.split('@')[1].slice(0, 20)}`;
    }
    return /^(event|type|mediatype|category)$/i.test(chave) ? valor.slice(0, 40) : `texto(${valor.length})`;
  }
  if (Array.isArray(valor)) return valor.length ? [estrutura(valor[0], chave, nivel + 1)] : [];
  if (valor && typeof valor === 'object') {
    if (nivel > 6) return '{…}';
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, estrutura(v, k, nivel + 1)]));
  }
  return valor === null ? null : typeof valor;
}

const whatsappConfigurado = () => !!(cfg('STEVO_API_URL') && cfg('STEVO_API_KEY') && cfg('BRAIN_WHATSAPP_GRUPO') && cfg('BRAIN_WEBHOOK_TOKEN'));

async function stevo(caminho, corpo) {
  const r = await fetch(cfg('STEVO_API_URL').replace(/\/+$/, '') + caminho, {
    method: corpo ? 'POST' : 'GET',
    headers: { apikey: cfg('STEVO_API_KEY'), 'content-type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stevo respondeu ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// Procura em qualquer profundidade; as chaves são comparadas sem diferenciar maiúsculas.
function buscar(obj, teste, profundidade = 0) {
  if (!obj || typeof obj !== 'object' || profundidade > 8) return undefined;
  for (const [chave, valor] of Object.entries(obj)) {
    if (teste(chave.toLowerCase(), valor)) return valor;
  }
  for (const valor of Object.values(obj)) {
    const achado = buscar(valor, teste, profundidade + 1);
    if (achado !== undefined) return achado;
  }
  return undefined;
}
const campo = (obj, nome) => buscar(obj, (chave) => chave === nome.toLowerCase());

// Markdown dos agentes -> formatação do WhatsApp.
function paraWhatsapp(texto) {
  return String(texto ?? '')
    // gráfico e tabela não existem no WhatsApp: o gráfico vira um aviso e a tabela, linhas de texto
    .replace(/```\s*gr[aá]fico[\s\S]*?```/gi, (bloco) => {
      const titulo = bloco.match(/"titulo"\s*:\s*"([^"]*)"/)?.[1];
      return `📊 Gráfico${titulo ? `: ${titulo}` : ''} (veja no site)`;
    })
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$\n?/gm, '')
    .replace(/^\s*\|(.+)\|\s*$/gm, (_, miolo) => '• ' + miolo.split('|').map((c) => c.trim()).join(' — '))
    .replace(/^#{1,6}\s+(.*)$/gm, '*$1*')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2');
}

async function enviarWhatsapp(texto) {
  if (!whatsappConfigurado()) return;
  // O WhatsApp corta mensagens muito longas: envia em partes.
  const partes = String(texto).match(/[\s\S]{1,3500}(?:\n|$)|[\s\S]{1,3500}/g) ?? [];
  for (const parte of partes) {
    try {
      const r = await stevo('/send/text', { number: cfg('BRAIN_WHATSAPP_GRUPO'), text: MARCA + parte.trim() });
      const id = buscar(r, (chave, valor) => (chave === 'id' || chave === 'messageid') && typeof valor === 'string');
      if (id) idsVistos.add(id);
    } catch (e) {
      estadoWhatsapp.ultimoErro = `envio: ${e.message}`;
    }
  }
}

// Avisa no grupo quando um pedido vindo de lá começa e quando termina.
const avisados = new Map(); // id do pedido -> etapas já avisadas
function avisarWhatsapp(pedido) {
  if (pedido.origem !== 'whatsapp') return;
  const feitos = avisados.get(pedido.id) ?? new Set();
  avisados.set(pedido.id, feitos);
  const projeto = pedido.projeto ? lerProjetos().find((p) => p.id === pedido.projeto)?.nome : null;
  const quem = `*${pedido.agente || 'Brain'}*${projeto ? ` · ${projeto}` : ''}`;

  if (pedido.status === 'executando' && pedido.agente && !feitos.has('inicio')) {
    feitos.add('inicio');
    enviarWhatsapp(`${quem}\n_pegou o pedido e está trabalhando_`);
  }
  if (['concluido', 'erro', 'interrompido'].includes(pedido.status) && !feitos.has('fim')) {
    feitos.add('fim');
    const site = [...HOSTS].find((h) => h.includes('.') && !/^[\d.]+$/.test(h) && !h.endsWith('.localhost'));
    const entregas = pedido.entregas ?? [];
    // Sem endereço público não dá para a Stevo buscar os arquivos: só lista os nomes.
    const lista = !site && entregas.length ? `${entregas.map((e) => `📎 ${e.nome}`).join('\n')}\nArquivos disponíveis no site.` : '';
    const corpo = [paraWhatsapp(pedido.resultado), pedido.erro ? `⚠️ ${pedido.erro}` : '', lista].filter(Boolean).join('\n\n');
    enviarWhatsapp(`${quem}\n\n${corpo || '(sem resposta)'}`).then(async () => {
      if (!site) return;
      // Imagens e documentos entregues vão para o grupo; a Stevo baixa cada um pelo endereço com o token.
      for (const e of entregas) {
        const tipo = /\.(png|jpe?g|webp|gif)$/i.test(e.nome) ? 'image' : /\.(mp4|mov)$/i.test(e.nome) ? 'video' : /\.(mp3|ogg|m4a|wav)$/i.test(e.nome) ? 'audio' : 'document';
        const url = `https://${site}/wa/${cfg('BRAIN_WEBHOOK_TOKEN')}/arquivo/${pedido.id}/${encodeURIComponent(e.nome)}`;
        try {
          await stevo('/send/media', { number: cfg('BRAIN_WHATSAPP_GRUPO'), type: tipo, url, caption: tipo === 'document' ? e.nome : '', filename: e.nome });
        } catch (x) {
          estadoWhatsapp.ultimoErro = `envio de arquivo: ${x.message}`;
          await enviarWhatsapp(`📎 ${e.nome}: não consegui enviar por aqui; está no site.`);
        }
      }
    });
    avisados.delete(pedido.id);
  }
}

async function baixarMidia(mensagem) {
  // A Stevo já manda o arquivo dentro da própria mensagem, no campo "base64".
  const embutido = Object.entries(mensagem).find(([chave, valor]) => chave.toLowerCase() === 'base64' && typeof valor === 'string' && valor.length > 0)?.[1];
  if (embutido) return Buffer.from(embutido.replace(/^data:[^,]+,/, ''), 'base64');
  // Sem o campo, pede o arquivo pela API (o conteúdo vai sem campos extras).
  const r = await stevo('/message/downloadimage', { message: mensagem });
  const base64 = buscar(r, (chave, valor) => typeof valor === 'string' && valor.length > 200 && /^(data:[^,]+,)?[A-Za-z0-9+/=\s]+$/.test(valor.slice(0, 400)));
  if (!base64) throw new Error('a Stevo não devolveu o arquivo');
  return Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64');
}

const EXTENSOES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4' };

// Transforma uma mensagem do grupo em pedido.
async function receberDoWhatsapp(payload) {
  const info = buscar(payload, (chave, valor) => chave === 'info' && valor && typeof valor === 'object');
  const mensagem = buscar(payload, (chave, valor) => chave === 'message' && valor && typeof valor === 'object');
  if (!info || !mensagem) return;

  const conversa = String(campo(info, 'chat') ?? '');
  const id = String(campo(info, 'id') ?? '');
  // Só o grupo de comandos; dentro dele, vale a mensagem de qualquer participante.
  if (!conversa.startsWith(cfg('BRAIN_WHATSAPP_GRUPO').split('@')[0])) return;
  if (id && idsVistos.has(id)) return;
  if (id) idsVistos.add(id);

  let texto = String(campo(mensagem, 'conversation') ?? campo(campo(mensagem, 'extendedtextmessage'), 'text') ?? '');
  if (texto.startsWith(MARCA)) return; // é uma resposta do próprio Brain

  const audio = campo(mensagem, 'audiomessage');
  const documento = campo(mensagem, 'documentmessage');
  const imagem = campo(mensagem, 'imagemessage');
  const midia = documento || imagem || campo(mensagem, 'videomessage');
  if (!texto && midia) texto = String(campo(midia, 'caption') ?? '');
  if (texto.startsWith(MARCA)) return;
  if (!texto && !audio && !midia) return;

  const idPedido = novoId();
  const dirAnexos = path.join(PEDIDOS, idPedido, 'anexos');
  fs.mkdirSync(dirAnexos, { recursive: true });
  const anexos = [];
  const arquivos = [];
  let textoOriginal;

  try {
    if (audio) {
      if (!cfg('OPENAI_API_KEY')) return enviarWhatsapp('*Brain*\n\n⚠️ Recebi um áudio, mas a transcrição está desligada (falta a OPENAI_API_KEY).');
      const som = await baixarMidia(mensagem);
      texto = await transcrever(som.toString('base64'), String(campo(audio, 'mimetype') ?? 'audio/ogg'));
      if (!texto) return enviarWhatsapp('*Brain*\n\n⚠️ Não consegui entender o áudio.');
    }
    if (midia) {
      const conteudo = await baixarMidia(mensagem);
      const tipo = String(campo(midia, 'mimetype') ?? '').split(';')[0];
      const nome = path.basename(String(campo(midia, 'filename') ?? campo(midia, 'title') ?? `anexo-${idPedido}.${EXTENSOES[tipo] || 'bin'}`)).replace(/[<>:"/\\|?*]/g, '_');
      fs.writeFileSync(path.join(dirAnexos, nome), conteudo);
      anexos.push(path.join(dirAnexos, nome));
      arquivos.push({ nome, tamanho: conteudo.length });
    }
  } catch (e) {
    estadoWhatsapp.ultimoErro = `recebimento: ${e.message}`;
    return enviarWhatsapp(`*Brain*\n\n⚠️ Não consegui abrir o que você mandou: ${e.message}`);
  }

  const pedido = {
    id: idPedido,
    texto: texto.trim() || 'Veja o anexo.',
    textoOriginal,
    origem: 'whatsapp',
    motor: null,
    projeto: null,
    para: null,
    anexos,
    arquivos,
    status: 'recebido',
    criadoEm: new Date().toISOString(),
  };
  salvar(pedido);
  processar(pedido);
}

async function webhookWhatsapp(req, res, caminho) {
  const fim = (status) => {
    res.writeHead(status);
    res.end();
  };
  try {
    const token = cfg('BRAIN_WEBHOOK_TOKEN');
    const grupo = cfg('BRAIN_WHATSAPP_GRUPO');
    if (!token || !grupo) return fim(503);
    // Diagnóstico para quem tem o token: quantas chamadas chegaram e a forma delas, sem conteúdo.
    // Arquivo entregue por um agente, para a Stevo buscar e mandar ao grupo.
    const entregue = caminho.match(/^\/wa\/([^/]+)\/arquivo\/([\w-]+)\/([^/]+)$/);
    if (req.method === 'GET' && entregue && entregue[1] === token) {
      return enviarArquivo(res, path.join(PEDIDOS, entregue[2], 'entrega', path.basename(decodeURIComponent(entregue[3]))));
    }
    if (req.method === 'GET' && caminho === `/wa/${token}/diagnostico`) {
      return responder(res, 200, { ...estadoWhatsapp, configurado: whatsappConfigurado(), transcricao: !!cfg('OPENAI_API_KEY') });
    }
    // Registra toda batida em /wa/ (método e o que veio depois do token), para achar chamadas em endereço diferente.
    const comToken = caminho === `/wa/${token}` || caminho.startsWith(`/wa/${token}/`);
    estadoWhatsapp.tentativas = [...estadoWhatsapp.tentativas, { quando: new Date().toISOString(), metodo: req.method, token: comToken, resto: comToken ? caminho.slice(`/wa/${token}`.length) : '(token diferente)', agente: String(req.headers['user-agent'] || '').slice(0, 40) }].slice(-12);
    // Aceita também subcaminhos (alguns provedores acrescentam o nome do evento ao endereço).
    if (req.method !== 'POST' || !comToken) return fim(404);
    const corpo = await lerCorpo(req);
    fim(200); // responde logo; o trabalho segue em seguida
    estadoWhatsapp.chamadas++;
    estadoWhatsapp.ultimaChamada = new Date().toISOString();
    try {
      estadoWhatsapp.estruturas = [...estadoWhatsapp.estruturas, estrutura(JSON.parse(corpo))].slice(-6);
    } catch {
      estadoWhatsapp.estruturas = [...estadoWhatsapp.estruturas, `não é JSON (${corpo.length} caracteres)`].slice(-6);
    }
    // Tudo que não for do grupo de comandos é descartado sem guardar nada.
    if (!corpo.includes(grupo.split('@')[0])) return;
    estadoWhatsapp.ultimoEvento = new Date().toISOString();
    // Guarda as 20 últimas mensagens do grupo, para conferir o formato quando algo não funcionar.
    fs.mkdirSync(CAPTURAS, { recursive: true });
    fs.writeFileSync(path.join(CAPTURAS, `${novoId()}.json`), corpo);
    for (const velho of fs.readdirSync(CAPTURAS).sort().slice(0, -20)) fs.rmSync(path.join(CAPTURAS, velho), { force: true });
    receberDoWhatsapp(JSON.parse(corpo)).catch((e) => (estadoWhatsapp.ultimoErro = `leitura: ${e.message}`));
  } catch {
    if (!res.headersSent) fim(400);
  }
}

// O que a tela de configurações mostra. Textos longos (arquivos em base64) são encurtados.
function resumoWhatsapp(req) {
  const encurtar = (v) => (typeof v === 'string' && v.length > 160 ? `${v.slice(0, 160)}… (${v.length} caracteres)` : v);
  const capturas = fs.existsSync(CAPTURAS)
    ? fs.readdirSync(CAPTURAS).sort().slice(-4).map((nome) => {
        try {
          return JSON.stringify(JSON.parse(fs.readFileSync(path.join(CAPTURAS, nome), 'utf8')), (_, v) => encurtar(v), 1);
        } catch {
          return '(captura ilegível)';
        }
      })
    : [];
  const host = (req.headers.host || '').split(':')[0];
  return {
    configurado: whatsappConfigurado(),
    faltando: ['STEVO_API_URL', 'STEVO_API_KEY', 'BRAIN_WHATSAPP_GRUPO', 'BRAIN_WEBHOOK_TOKEN'].filter((v) => !cfg(v)),
    transcricao: !!cfg('OPENAI_API_KEY'),
    webhook: cfg('BRAIN_WEBHOOK_TOKEN') ? `https://${host}/wa/${cfg('BRAIN_WEBHOOK_TOKEN')}` : null,
    ...estadoWhatsapp,
    capturas,
  };
}

// ---------- perfil e fotos ----------

const ARQ_PERFIL = path.join(DADOS, 'perfil.json');
function lerPerfil() {
  try {
    return { nome: 'Phedro', ...JSON.parse(fs.readFileSync(ARQ_PERFIL, 'utf8')) };
  } catch {
    return { nome: 'Phedro' };
  }
}

// Fotos: as enviadas pela página ficam em <dados>/avatares; as do repositório, em avatares/.
const DIR_FOTOS = path.join(DADOS, 'avatares');
const QUEM_TEM_FOTO = new Set(['eu', ...NOMES.map(semAcento)]);
const cacheFotos = new Map(); // quem -> { caminho, versao } | null
// As fotos oficiais dos agentes entraram no repositório nesta data. Foto enviada
// pela página ANTES disso era provisória e perde para a oficial; enviada depois, vence.
const FOTOS_OFICIAIS_DESDE = Date.parse('2026-10-10T20:15:00Z');
function fotoDe(quem) {
  if (!cacheFotos.has(quem)) {
    const achar = (dir) => ['jpg', 'jpeg', 'png', 'webp'].map((e) => path.join(dir, `${quem}.${e}`)).find((c) => fs.existsSync(c));
    const enviada = achar(DIR_FOTOS);
    const oficial = achar(path.join(RAIZ, 'avatares'));
    const caminho = enviada && (!oficial || fs.statSync(enviada).mtimeMs > FOTOS_OFICIAIS_DESDE) ? enviada : oficial;
    cacheFotos.set(quem, caminho ? { caminho, versao: Math.round(fs.statSync(caminho).mtimeMs) } : null);
  }
  return cacheFotos.get(quem);
}

// ---------- conversa (o que a página mostra) ----------

function verPedido(p, projetos) {
  return {
    id: p.id,
    texto: p.texto,
    textoOriginal: p.textoOriginal,
    arquivos: p.arquivos ?? [],
    criadoEm: p.criadoEm,
    iniciadoEm: p.iniciadoEm,
    atualizadoEm: p.atualizadoEm,
    status: p.status,
    tipo: p.tipo,
    agente: p.agente,
    motor: p.motor,
    para: p.para,
    origem: p.origem,
    projeto: p.projeto,
    projetoNome: projetos.find((x) => x.id === p.projeto)?.nome ?? null,
    resultado: p.resultado,
    erro: p.erro,
    entregas: p.entregas ?? [],
    passos: atividade.get(p.id)?.slice(-6) ?? [],
    uso: p.uso ?? null,
  };
}

const TIPOS_DE_ARQUIVO = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };
const extensao = (nome) => path.extname(nome).slice(1).toLowerCase();

// Imagens e PDF abrem no navegador; o resto sempre baixa (nunca roda como página).
function enviarArquivo(res, caminho) {
  if (!fs.existsSync(caminho) || !fs.statSync(caminho).isFile()) return responder(res, 404, { erro: 'arquivo não encontrado' });
  const tipo = TIPOS_DE_ARQUIVO[extensao(caminho)];
  res.writeHead(200, {
    'content-type': tipo || 'application/octet-stream',
    'content-disposition': `${tipo ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(caminho))}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=3600',
  });
  fs.createReadStream(caminho).pipe(res);
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
    if (rota === 'GET /api/config') {
      return responder(res, 200, { transcricao: !!cfg('OPENAI_API_KEY'), temSenha: !!SENHA, perfil: { ...lerPerfil(), foto: fotoDe('eu')?.versao ?? null } });
    }
    if (rota === 'POST /api/transcrever') {
      const corpo = JSON.parse(await lerCorpo(req));
      return responder(res, 200, { texto: await transcrever(String(corpo.audio || ''), String(corpo.tipo || '')) });
    }
    if (rota === 'GET /api/projetos') {
      return responder(
        res,
        200,
        lerProjetos().map(({ id, nome, ativo, motivo, descricao }) => ({ id, nome, ativo, motivo, descricao })),
      );
    }

    if (rota === 'GET /api/conversa') {
      const projetos = lerProjetos();
      const todos = listar();
      // Resumo de hoje (no fuso do servidor): total e por agente.
      const hoje = new Date().toDateString();
      const resumo = { pedidos: 0, tokens: 0, custo: 0, porAgente: {} };
      for (const p of todos) {
        if (new Date(p.criadoEm).toDateString() !== hoje) break; // a lista vem do mais novo para o mais antigo
        const tokens = (p.uso?.entrada ?? 0) + (p.uso?.saida ?? 0);
        resumo.pedidos++;
        resumo.tokens += tokens;
        resumo.custo += p.uso?.custo ?? 0;
        const quem = p.agente || 'Brain';
        const a = (resumo.porAgente[quem] ??= { pedidos: 0, tokens: 0 });
        a.pedidos++;
        a.tokens += tokens;
      }
      return responder(res, 200, {
        resumo: { ...resumo, fila: fila.length },
        pedidos: todos.slice(0, 120).reverse().map((p) => verPedido(p, projetos)),
        agentes: [...agentes.values()].map((a) => ({
          nome: a.nome,
          ocupado: a.ocupado,
          temSessao: !!a.sessao,
          projeto: a.projeto,
          projetoNome: projetos.find((x) => x.id === a.projeto)?.nome ?? null,
          resumo: a.resumo,
          foto: fotoDe(semAcento(a.nome))?.versao ?? null,
        })),
      });
    }

    const foto = url.pathname.match(/^\/avatares\/([a-z]+)$/);
    if (foto && req.method === 'GET') {
      const achada = QUEM_TEM_FOTO.has(foto[1]) && fotoDe(foto[1]);
      return achada ? enviarArquivo(res, achada.caminho) : responder(res, 404, { erro: 'sem foto' });
    }
    // Enviar ou remover a foto (a página já manda um JPEG pequeno e quadrado).
    const trocarFoto = url.pathname.match(/^\/api\/avatares\/([a-z]+)$/);
    if (trocarFoto && req.method === 'POST') {
      const quem = trocarFoto[1];
      if (!QUEM_TEM_FOTO.has(quem)) return responder(res, 404, { erro: 'agente desconhecido' });
      const { base64 } = JSON.parse(await lerCorpo(req));
      fs.mkdirSync(DIR_FOTOS, { recursive: true });
      for (const e of ['jpg', 'jpeg', 'png', 'webp']) fs.rmSync(path.join(DIR_FOTOS, `${quem}.${e}`), { force: true });
      if (base64) {
        const imagem = Buffer.from(String(base64), 'base64');
        if (imagem.length > 2 * 1024 * 1024) return responder(res, 400, { erro: 'foto grande demais' });
        if (imagem[0] !== 0xff || imagem[1] !== 0xd8) return responder(res, 400, { erro: 'a foto precisa ser JPEG' });
        fs.writeFileSync(path.join(DIR_FOTOS, `${quem}.jpg`), imagem);
      }
      cacheFotos.delete(quem);
      return responder(res, 200, { foto: fotoDe(quem)?.versao ?? null });
    }

    if (rota === 'GET /api/whatsapp') return responder(res, 200, resumoWhatsapp(req));
    if (rota === 'POST /api/whatsapp/teste') {
      await lerCorpo(req);
      if (!whatsappConfigurado()) return responder(res, 400, { erro: 'faltam variáveis do WhatsApp' });
      estadoWhatsapp.ultimoErro = null;
      await enviarWhatsapp('*Brain*\n\nTeste de envio: se você está lendo isto no grupo, a saída funciona.');
      return estadoWhatsapp.ultimoErro ? responder(res, 502, { erro: estadoWhatsapp.ultimoErro }) : responder(res, 200, { ok: true });
    }
    if (rota === 'POST /api/perfil') {
      const nome = String(JSON.parse(await lerCorpo(req)).nome || '').trim().slice(0, 40);
      if (!nome) return responder(res, 400, { erro: 'escreva o nome' });
      fs.writeFileSync(ARQ_PERFIL, JSON.stringify({ nome }));
      return responder(res, 200, { nome });
    }
    if (rota === 'POST /api/senha') {
      if (!SENHA) return responder(res, 400, { erro: 'neste computador o Brain não usa senha' });
      const { atual, nova } = JSON.parse(await lerCorpo(req));
      if (!senhaConfere(atual)) return responder(res, 400, { erro: 'a senha atual não confere' });
      if (String(nova || '').length < 8) return responder(res, 400, { erro: 'a senha nova precisa de pelo menos 8 caracteres' });
      gravarSenha(String(nova));
      // Sai de todos os outros aparelhos; este continua logado.
      const esta = tokenDaSessao(req) && hashDe(tokenDaSessao(req));
      for (const h of [...sessoes.keys()]) if (h !== esta) sessoes.delete(h);
      salvarSessoes();
      return responder(res, 200, { ok: true });
    }

    const arquivo = url.pathname.match(/^\/api\/arquivo\/([\w-]+)\/(anexos|entrega)\/([^/]+)$/);
    if (arquivo && req.method === 'GET') {
      const nome = path.basename(decodeURIComponent(arquivo[3]));
      return enviarArquivo(res, path.join(PEDIDOS, arquivo[1], arquivo[2], nome));
    }

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
      if (!['roteando', 'na_fila', 'executando'].includes(pedido.status)) return responder(res, 409, { erro: 'este pedido não está em andamento' });
      pedido.status = 'cancelado';
      salvar(pedido);
      const filho = emExecucao.get(pedido.id);
      if (filho) matar(filho);
      return responder(res, 200, { ok: true });
    }

    if (rota === 'POST /api/pedidos') {
      const corpo = JSON.parse(await lerCorpo(req));
      const listaAnexos = Array.isArray(corpo.anexos) ? corpo.anexos : [];
      const texto = String(corpo.texto || '').trim() || (listaAnexos.length ? 'Veja o anexo.' : '');
      if (!texto) return responder(res, 400, { erro: 'escreva ou dite a mensagem' });
      const id = novoId();
      const dirAnexos = path.join(PEDIDOS, id, 'anexos');
      fs.mkdirSync(dirAnexos, { recursive: true });
      const anexos = [];
      const arquivos = [];
      for (const a of listaAnexos) {
        const nome = path.basename(String(a.nome || 'anexo')).replace(/[<>:"/\\|?*]/g, '_');
        const destino = path.join(dirAnexos, nome);
        const conteudo = Buffer.from(String(a.base64 || ''), 'base64');
        fs.writeFileSync(destino, conteudo);
        anexos.push(destino);
        arquivos.push({ nome, tamanho: conteudo.length });
      }
      const pedido = {
        id,
        texto,
        // motor: a ferramenta (claude ou codex); agente: quem da equipe pegou o pedido.
        motor: corpo.motor === 'codex' ? 'codex' : corpo.motor === 'claude' ? 'claude' : null,
        projeto: corpo.projeto && corpo.projeto !== 'auto' ? String(corpo.projeto) : null,
        para: acharAgente(corpo.para)?.nome ?? null,
        anexos,
        arquivos,
        status: 'recebido',
        criadoEm: new Date().toISOString(),
      };
      salvar(pedido);
      processar(pedido);
      return responder(res, 201, { id });
    }

    responder(res, 404, { erro: 'rota não encontrada' });
  } catch (e) {
    responder(res, 500, { erro: String(e.message || e) });
  }
});

servidor.listen(PORTA, HOST, () => {
  console.log(`[brain] no ar em http://${LOCAL ? 'localhost' : HOST}:${PORTA} · login ${SENHA ? 'ligado' : 'desligado (só local)'} · ${lerProjetos().length} projetos · dados em ${DADOS}`);
});
