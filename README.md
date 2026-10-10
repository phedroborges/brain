# Brain

Meu assistente pessoal: uma conversa única, no estilo do WhatsApp, em que eu
pergunto qualquer coisa ou peço trabalho nos meus projetos, por texto, áudio ou
anexo. Uma equipe de oito agentes executa os pedidos em paralelo.

O repositório também guarda o vault de anotações (`Reels/`, `Carrosséis/`,
`Pessoal/`), que continua sendo aberto pelo Obsidian.

> Estado: em construção. O WhatsApp está em modo captura (só grava o que chega
> do grupo).

## Como funciona

1. **Entrada:** texto, ditado (gravado e transcrito no servidor) e anexos.
2. **Brain (roteador):** um Claude rápido lê a mensagem com o histórico e o estado
   da equipe, corrige nomes que a transcrição errou e decide o tipo:
   - `resposta`: ele mesmo responde (conversa, contas, dúvidas simples);
   - `geral`: um agente responde, pesquisando na internet se precisar;
   - `projeto`: um agente trabalha na pasta do projeto (clonado na primeira vez);
   - `continuar`: a mensagem vai para o agente citado, na mesma sessão dele.
3. **Agentes:** Junior, Trixie, Flocos, Ágato, Guará, Marsha, Dino e Paçoca. Até
   oito trabalham ao mesmo tempo; com todos ocupados, o pedido espera na fila.
   Cada um roda `claude -p --permission-mode auto` ou `codex exec --approve-for-me`.

Arquivos que o agente salvar na pasta `entrega` do pedido aparecem na conversa
como anexos. A foto de cada agente fica em `avatares/<nome sem acento>.jpg` (ou
`.png`/`.webp`); sem foto, aparece a inicial.

## Arquivos

| Arquivo | O que é |
|---|---|
| `server.mjs` | Servidor (Node puro, sem dependências). |
| `index.html` | A página. |
| `projetos.json` | Cadastro dos projetos. |
| `vocabulario.json` | Nomes próprios que a transcrição costuma errar. |
| `avatares/` | Fotos dos agentes. |
| `Dockerfile`, `docker-entrypoint.sh` | Imagem para a VPS. |
| `.env.example` | Todas as variáveis de configuração. |

## Cadastro de projetos (`projetos.json`)

| Campo | Para quê |
|---|---|
| `id` | Nome da pasta em `~/projetos/<id>`. |
| `nome`, `apelidos`, `descricao` | O que o roteador usa para reconhecer o projeto. |
| `repo` | Repositório no GitHub, clonado na primeira vez. |
| `motor` | `claude` ou `codex` quando a mensagem não escolhe. |
| `publicar` | `main` (padrão: commit e push direto), `branch` (branch + pull request) ou `nao`. |
| `ativo`, `motivo` | `false` tira o projeto de uso e explica por quê. |
| `base` | `true` marca a base de processos: todo agente consulta os passo a passos e contextos de clientes dela antes de qualquer entrega, mesmo em pedidos de outros projetos ou sem projeto. |
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
