#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# HAProxy em modo TCP (Layer 4) publicando o PostgreSQL do Hostfy.
#
#   sudo ./scripts/setup-haproxy.sh [porta]
#
# O que ele faz:
#   1. instala o haproxy (apt);
#   2. instala o arquivo deploy/haproxy.cfg em /etc/haproxy/haproxy.cfg;
#   3. habilita e reinicia o servico.
#
# O frontend escuta em :5432 (IPv4 e IPv6) e encaminha os bytes para o
# container "db" (via a porta publicada DB_HOST_PORT no 127.0.0.1).
# Nao ha terminacao TLS aqui: o proprio PostgreSQL negocia o SSL, entao o
# trafego chega cifrado no banco.
# ---------------------------------------------------------------------------
set -euo pipefail

PORT="${1:-5432}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG_SRC="$ROOT/deploy/haproxy.cfg"

if [ ! -f "$CFG_SRC" ]; then
  echo "configuracao nao encontrada: $CFG_SRC" >&2
  exit 1
fi

if ! command -v haproxy >/dev/null 2>&1; then
  echo "==> instalando haproxy"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq haproxy
fi

echo "==> instalando $CFG_SRC"
install -m 0644 -o root -g root "$CFG_SRC" /etc/haproxy/haproxy.cfg

echo "==> validando a configuracao"
haproxy -c -f /etc/haproxy/haproxy.cfg

echo "==> habilitando o servico"
systemctl enable haproxy >/dev/null 2>&1 || true
systemctl restart haproxy

sleep 2
systemctl is-active haproxy
ss -tlnp | grep ":$PORT" || true

echo
echo "HAProxy ativo escutando em :$PORT (IPv4 e IPv6)."
echo "Para expor na internet, aponte o hostname publico para o IP do servidor"
echo "e libere a porta $PORT no firewall/roteador."