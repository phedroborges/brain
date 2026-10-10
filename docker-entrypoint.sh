#!/bin/sh
# Um volume recém-montado em /dados pertence ao root; os agentes rodam como "brain".
set -e
if [ "$(id -u)" = "0" ]; then
  [ "$(stat -c %U /dados)" = "brain" ] || chown brain:brain /dados
  exec runuser -u brain -- "$@"
fi
exec "$@"
