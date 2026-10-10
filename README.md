# Brain

Meu agente pessoal. Recebe um pedido por texto, áudio ou anexo, descobre de qual
projeto estou falando, abre uma sessão do Claude Code ou do Codex na pasta dele e
executa em modo automático.

O repositório também guarda o vault de anotações (`Reels/`, `Carrosséis/`,
`Pessoal/`), que continua sendo aberto pelo Obsidian.

> Estado: primeira versão. O fluxo de pedido ainda não foi validado de ponta a
> ponta e o WhatsApp está em modo captura (só grava o que chega do grupo).

## Como funciona

1. **Entrada:** site (texto, ditado, anexos) ou webhook do WhatsApp.
2. **Roteador:** um Claude rápido lê o pedido e o `projetos.json` e escolhe o projeto.
3. **Executor:** `claude -p --permission-mode auto` ou `codex exec --approve-for-me`
   na pasta do projeto. Se a pasta não existir, o projeto é clonado do GitHub.
4. **Acompanhamento:** lista de pedidos com status, log ao vivo, resultado e cancelar.

## Arquivos

| Arquivo | O que é |
|---|---|
| `server.mjs` | Servidor (Node puro, sem dependências). |
| `index.html` | A página. |
| `projetos.json` | Cadastro dos projetos. |
| `Dockerfile`, `docker-entrypoint.sh` | Imagem para a VPS. |
| `.env.example` | Todas as variáveis de configuração. |

## Cadastro de projetos (`projetos.json`)

| Campo | Para quê |
|---|---|
| `id` | Nome da pasta em `~/projetos/<id>`. |
| `nome`, `apelidos`, `descricao` | O que o roteador usa para reconhecer o projeto. |
| `repo` | Repositório no GitHub, clonado na primeira vez. |
| `agente` | `claude` ou `codex` quando o pedido não escolhe. |
| `publicar` | `main` (padrão: commit e push direto), `branch` (branch + pull request) ou `nao`. |
| `ativo`, `motivo` | `false` tira o projeto de uso e explica por quê. |
| `pasta` | Só se o projeto não estiver em `~/projetos/<id>`. |

## Rodar no PC

```
node server.mjs
```

Abre em http://localhost:4848, sem senha, e só responde no próprio computador.
A configuração fica em `~/.brain/.env` e os pedidos em `~/.brain/pedidos/`.

## Subir na VPS (EasyPanel)

1. Crie um serviço do tipo **App** apontando para este repositório (branch `main`);
   o build usa o `Dockerfile` da raiz.
2. Monte um **volume** em `/dados`.
3. Exponha a porta **4848** em um domínio com HTTPS.
4. Defina as variáveis de ambiente do `.env.example`. As obrigatórias são
   `BRAIN_SENHA` e `BRAIN_HOSTS`.
5. Abra o site, entre com a senha e, em **Conexões**, conecte o Claude, o Codex e
   o GitHub. Cada botão inicia o login oficial da ferramenta na VPS e mostra o
   link de autorização; a credencial fica guardada no volume `/dados`.
6. WhatsApp: no painel da Stevo, em Webhook, cole
   `https://<domínio>/wa/<BRAIN_WEBHOOK_TOKEN>` com o evento `MESSAGE`.

## Segurança

- Fora de `127.0.0.1` o servidor exige `BRAIN_SENHA` ou não sobe.
- O site só aceita os domínios de `BRAIN_HOSTS` e pedidos vindos da própria página.
- O webhook só responde no caminho com o token e descarta tudo que não for do
  grupo de comandos.
- Os agentes rodam sem root, mas com push direto na branch principal por padrão:
  use `"publicar": "branch"` nos projetos em que isso for arriscado.
