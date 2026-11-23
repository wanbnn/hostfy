#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Gera os certificados TLS do PostgreSQL do Hostfy.
#
#   sudo ./scripts/setup-postgres-tls.sh <hostname-publico>
#
# Exemplo:
#   sudo ./scripts/setup-postgres-tls.sh db.seudominio.com
#
# Produz em ./certs:
#   ca.crt     - autoridade certificadora (distribua aos clientes)
#   ca.key     - chave da CA (mantida apenas no servidor)
#   server.crt - certificado do servidor
#   server.key - chave privada do servidor
#
# O certificado do servidor e usado pelo proprio PostgreSQL (ssl=on), de modo
# que o trafego chega cifrado no banco. O HAProxy continua em modo TCP puro:
# ele apenas encaminha os bytes, sem decifrar nada.
# ---------------------------------------------------------------------------
set -euo pipefail

HOSTNAME_PUB="${1:-}"
if [ -z "$HOSTNAME_PUB" ]; then
  echo "uso: sudo $0 <hostname-publico>" >&2
  echo "ex.: sudo $0 db.seudominio.com" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERTDIR="$ROOT/certs"
mkdir -p "$CERTDIR"
cd "$CERTDIR"

if [ ! -f ca.key ]; then
  echo "==> gerando a CA"
  openssl genrsa -out ca.key 2048
  openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
    -subj "/CN=Hostfy DB CA" -out ca.crt
  chmod 600 ca.key
  chmod 644 ca.crt
else
  echo "==> CA ja existe, mantida"
fi

if [ ! -f server.key ]; then
  echo "==> gerando o certificado do servidor para $HOSTNAME_PUB"
  openssl genrsa -out server.key 2048
  openssl req -new -key server.key -subj "/CN=$HOSTNAME_PUB" -out server.csr
  cat > san.cnf <<EOF
[req]
distinguished_name = dn
[dn]
[ext]
subjectAltName = DNS:$HOSTNAME_PUB, DNS:localhost, IP:127.0.0.1, IP:::1
extendedKeyUsage = serverAuth
EOF
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out server.crt -days 3650 -sha256 -extfile san.cnf -extensions ext
  rm -f server.csr san.cnf
  chmod 600 server.key
  chmod 644 server.crt
  # O postgres roda como uid 70 (alpine) e exige a chave legivel por ele.
  chown 70:70 server.key server.crt 2>/dev/null || true
else
  echo "==> certificado do servidor ja existe, mantido"
fi

echo
echo "==> resumo"
openssl x509 -in server.crt -noout -subject -ext subjectAltName -dates
echo
echo "Certificados em: $CERTDIR"
echo "Para os clientes: use sslmode=verify-full com o ca.crt, ou sslmode=require."