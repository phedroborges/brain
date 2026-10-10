# Brain na VPS: Node + git + GitHub CLI + Claude Code + Codex.
# Tudo que precisa persistir (logins dos agentes, clones dos projetos e pedidos)
# fica em /dados: monte um volume ali.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client gh \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Os agentes não rodam como root (o entrypoint troca de usuário depois de
# acertar o dono do volume).
RUN useradd --create-home --home-dir /dados --shell /bin/bash brain
ENV HOME=/dados \
    BRAIN_HOST=0.0.0.0 \
    BRAIN_PORT=4848 \
    BRAIN_DATA_DIR=/dados/.brain

WORKDIR /app
COPY server.mjs index.html projetos.json vocabulario.json docker-entrypoint.sh ./
COPY avatares ./avatares
RUN chmod +x docker-entrypoint.sh

VOLUME /dados
EXPOSE 4848
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
