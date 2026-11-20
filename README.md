# Hostfy

Plataforma de hospedagem com cadastro, login, múltiplos projetos por usuário, URL pública por slug e
painel com páginas separadas para projetos, aplicações Docker Compose, GitHub e manutenção do host.

Cada conta pode publicar:

- **Sites estáticos** (HTML, CSS, JS, imagens) — servidos em `http://SEU_HOST:1592/SEU-SLUG/`.
- **Aplicações PHP** — executadas por um runner interno e publicadas em subdomínio (`SEU-SLUG.SEU_DOMINIO`).
- **Aplicações Node.js** — o runner roda `npm ci`/`npm install`, o build (se houver) e inicia a aplicação.
- **Projetos Docker Compose** — a partir de um ZIP ou de um repositório do GitHub (público ou privado);
  o Hostfy roda `docker compose up -d --build --remove-orphans` e publica o serviço web em subdomínio.

## Páginas do painel

| Rota | O que faz |
|---|---|
| `/` | **Visão geral** — resumo dos projetos, consumo total de CPU/memória e avisos de limpeza. |
| `/projects` | **Projetos** — gerenciamento com métricas por projeto, edição, logs, reiniciar/parar/redeploy. |
| `/deploy` | **Publicar** — envio de ZIP (estático/PHP/Node) ou de um projeto Docker Compose. |
| `/docker` | **Docker** — gerenciamento das stacks Compose, métricas e ciclo de vida. |
| `/github` | **GitHub** — vincular conta (PAT), listar repositórios e publicar direto do repositório. |
| `/system` | **Sistema** — (administrador) métricas do Docker do host, candidatos à limpeza e prune completo. |

## Requisitos

- Docker Engine e Docker Compose v2.
- Porta 1591 (painel/API), 1592 (sites estáticos), 1593 (proxy das aplicações PHP/Node/Docker) e 1594 (controle interno) disponíveis.
- Para aplicações PHP/Node/Docker: um domínio (ou subdomínio) com DNS wildcard, normalmente via Cloudflare Tunnel (veja abaixo).

## Subir

```bash
cp .env.example .env
# Edite .env e defina POSTGRES_PASSWORD, JWT_SECRET, RUNNER_TOKEN, ENCRYPTION_SECRET, ADMIN_EMAILS e PROJECTS_DOMAIN.
docker compose up -d --build
```

- Painel: http://localhost:1591
- Sites estáticos: http://localhost:1592/SEU-SLUG/
- Aplicações PHP/Node/Docker: https://SEU-SLUG.SEU_DOMINIO/

> O frontend (React + [Primer](https://primer.style), o design system do GitHub) é
> compilado com Vite durante o build da imagem (`npm run build` → `public/`).

Cada conta pode publicar vários projetos. O slug é único globalmente.

## Publicar um projeto

1. Comprima os arquivos do projeto em ZIP (o conteúdo na raiz do ZIP).
2. Entre no painel, informe nome, slug e o tipo de projeto (ou deixe **Detectar automaticamente**).
3. Envie o ZIP e abra o endereço gerado.

O tipo é detectado pelo conteúdo do ZIP:

- **Estático** — precisa de `index.html` na raiz. Publicado em `/SLUG/`.
- **PHP** — detectado por `index.php`, `composer.json` ou qualquer `.php`. Se existir `public/index.php` (Laravel/Symfony), o docroot é `public/`.
- **Node.js** — detectado por `package.json`. O runner roda `npm ci` (ou `npm install`), o `npm run build` quando existir e inicia com `npm start` (ou o `main`/`server.js`/`app.js`/`index.js`).

Estrutura estática:
```
meu-site.zip
├── index.html
├── styles.css
└── app.js
```

Estrutura Node:
```
minha-api.zip
├── package.json     # scripts.start ou main
├── server.js
└── ...
```

## Projetos Docker Compose

Os projetos do tipo **Docker** rodam em contêineres gerenciados pelo próprio Docker do host.

- Cada projeto usa um projeto Compose próprio (`hostfy-<slug>`), isolando nomes de contêineres,
  redes e volumes entre projetos.
- O Hostfy executa `docker compose up -d --build --remove-orphans`. Parar/reiniciar usa
  `docker compose stop`/`restart`; excluir usa `docker compose down -v` e remove contêineres,
  redes e volumes do projeto.
- O executor fica no serviço `runner`, que precisa do socket do Docker montado
  (`/var/run/docker.sock`) e roda como **root** dentro do contêiner. Isso equivale a acesso root no
  host — veja "Segurança e produção".
- **Não publique portas no host.** Use `expose` no serviço web. O Hostfy conecta-se à rede criada
  pelo Compose e faz o proxy do subdomínio diretamente para o contêiner do serviço web, detectando
  automaticamente o serviço (o primeiro com `ports`/`expose`) e a porta. Se a detecção não acertar,
  informe o **serviço web** e a **porta interna** na publicação/edição.
- Variáveis de ambiente (JSON) são passadas ao `docker compose` para interpolação (`${VAR}`).

Exemplo de `docker-compose.yml` compatível:

```yaml
services:
  web:
    build: .
    expose:
      - "80"        # não use "80:80" — o acesso é pelo subdomínio
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: exemplo
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  dbdata:
```

## GitHub

Cada usuário pode vincular a própria conta do GitHub informando um **Personal Access Token**
(PAT fine-grained, com leitura de *Contents* e *Metadata*). O token é validado na hora e guardado
**criptografado** (AES-256-GCM) no banco. Com a conta conectada, o painel lista repositórios
públicos e privados e permite publicar um deles como projeto Docker (branch/ref, arquivo do
compose, serviço web, porta e variáveis). O botão **Refazer deploy** baixa novamente o código e
reconstrói a stack.

## Limpeza automática e manutenção do Docker

O serviço `runner` otimiza o Docker do host automaticamente, com avisos aos usuários:

- **Contêineres parados** há mais de `CLEANUP_GRACE_HOURS` (padrão 24h) são removidos. Ao detectar
  um contêiner parado de um projeto, o dono recebe um aviso no painel com a data prevista.
- **Imagens não utilizadas** por nenhum contêiner e **volumes órfãos** seguem a mesma regra.
- A varredura roda a cada `CLEANUP_INTERVAL_MINUTES` (padrão 60 min) e os recursos vencidos são
  removidos automaticamente.
- Em `/system` (administrador), o **prune completo** (`docker system prune -a -f`) calcula o
  impacto, notifica cada usuário afetado com o motivo e só então executa (opcionalmente incluindo
  volumes).

> A limpeza de imagens é feita no Docker **do host** (não apenas em recursos do Hostfy). Use os
> avisos e o preview do prune para entender o que será removido.

## Cloudflare Tunnel (subdomínios)

As aplicações PHP/Node são servidas por subdomínio (`SEU-SLUG.PROJECTS_DOMAIN`)
e o runner escuta na porta **1593**. Com Cloudflare Tunnel, crie um registro DNS
wildcard e aponte o hostname curinga para o runner.

Exemplo de `config.yml` do `cloudflared`:

```yaml
tunnel: SEU-TUNNEL-ID
credentials-file: /etc/cloudflared/creds.json
ingress:
  - hostname: "*.sites.seudominio.com"   # DNS wildcard CNAME -> <id>.cfargotunnel.com
    service: http://localhost:1593        # ou http://runner:1593, se o cloudflared estiver na mesma rede
  - hostname: painel.seudominio.com
    service: http://localhost:1591
  - service: http_status:404
```

No `.env`, defina:

```
PROJECTS_DOMAIN=sites.seudominio.com
PROJECTS_SCHEME=https
```

Com o wildcard configurado, cada projeto PHP/Node de `slug` `minha-api` responde em
`https://minha-api.sites.seudominio.com`. O runner lê o `Host` e encaminha para o
processo correto.

## Desenvolvimento do frontend

O frontend fica em `web/` e usa React + Primer (`@primer/react`), com Vite.

```bash
npm install
npm run build      # gera o site em public/
npm run dev:web    # servidor de desenvolvimento do Vite
```

O backend (`npm start`) serve os arquivos já compilados de `public/`.

## Configurações

| Variável | Padrão | Descrição |
|---|---:|---|
| `POSTGRES_DB` | hostly | Banco de dados |
| `POSTGRES_USER` | hostly | Usuário do PostgreSQL |
| `POSTGRES_PASSWORD` | change-me-now | Senha do banco — altere antes de expor |
| `JWT_SECRET` | inseguro | Segredo JWT — use valor aleatório forte |
| `APP_PORT` | 1591 | Porta do painel/API |
| `STATIC_PORT` | 1592 | Porta dos sites estáticos |
| `PROJECTS_ORIGIN` | http://localhost:1592 | Origem dos sites estáticos |
| `RUNNER_PORT` | 1593 | Porta pública do proxy de aplicações PHP/Node |
| `RUNNER_CONTROL_PORT` | 1594 | Porta interna da API do runner |
| `RUNNER_TOKEN` | inseguro | Segredo compartilhado entre app e runner — use valor aleatório |
| `PROJECTS_DOMAIN` | (vazio) | Domínio base dos subdomínios das aplicações (ex.: `sites.seudominio.com`) |
| `PROJECTS_SCHEME` | https | Esquema usado para montar a URL das aplicações |
| `PORT_BASE` | 21000 | Primeira porta interna atribuída aos processos |
| `RUNNER_NODE_MEM_MB` | 256 | Limite de heap (`--max-old-space-size`) por app Node |
| `RUNNER_PHP_MEMORY` | 256M | `memory_limit` por app PHP |
| `RUNNER_MAX_RESTARTS` | 5 | Reinícios automáticos antes de marcar erro |
| `MAX_UPLOAD_MB` | 100 | Limite do ZIP recebido |
| `ADMIN_EMAILS` | (vazio) | E-mails (separados por vírgula) com acesso à página `/system` |
| `ENCRYPTION_SECRET` | JWT_SECRET | Chave usada para criptografar os tokens do GitHub |
| `CLEANUP_ENABLED` | true | Liga a limpeza automática do Docker |
| `CLEANUP_GRACE_HOURS` | 24 | Carência antes de remover contêineres parados/imagens/volumes sem uso |
| `CLEANUP_INTERVAL_MINUTES` | 60 | Intervalo entre varreduras de limpeza |
| `DOCKER_TIMEOUT_MS` | 1200000 | Tempo máximo para operações do Docker (inclui builds de Compose) |

## Comandos úteis

```bash
docker compose logs -f
docker compose down
docker compose down -v # APAGA banco e projetos; use com cuidado
docker compose up -d --build
```

Os dados ficam nos volumes Docker `postgres_data` e `projects`.

## Segurança e produção

- Senhas armazenadas com bcrypt; sessão JWT em cookie HttpOnly, SameSite=Lax.
- Consultas SQL parametrizadas, limitação de requisições e validação de slug.
- Extração ZIP rejeita traversal, links simbólicos, mais de 5.000 entradas e conteúdo descompactado acima de 300 MB.
- O servidor de arquivos estáticos é separado do painel/API, reduzindo o risco de conteúdo HTML enviado por usuários acessar a sessão do painel. **Mantenha origens/domínios separados em produção.**
- **Execução de código não confiável:** PHP/Node enviados pelos usuários são executados pelo serviço `runner`. O isolamento é de nível médio — cada projeto roda em um processo separado, com limite de memória e reinício automático, mas **compartilhando o mesmo contêiner**. Isto não é um sandbox forte.
  - Rode o `runner` com limites de CPU/memória/disco do Docker e, de preferência em um host isolado.
  - O código pode acessar a rede. Restrinja a saída (egress) se for expor para usuários públicos.
  - Considere usuário do SO por projeto e/ou um contêiner por projeto antes de escalar.
- **Socket do Docker:** para gerenciar os projetos Compose, o `runner` monta `/var/run/docker.sock` e roda como **root** dentro do contêiner — isso equivale a acesso root no host. Não execute projetos de usuários desconhecidos; prefira um host dedicado e com limites de recursos. Considere usar um proxy de socket (ex.: `docker-socket-proxy`) restringindo a API no futuro.
- **Limpeza do Docker:** a manutenção automática (e o prune em `/system`) age sobre o Docker do host, não apenas sobre recursos do Hostfy. Revise os avisos, a carência (`CLEANUP_GRACE_HOURS`) e o preview do prune antes de habilitar em produção.
- A API interna do runner (`RUNNER_CONTROL_PORT`) **não deve ser exposta** publicamente; defina um `RUNNER_TOKEN` forte.
- Para produção, use HTTPS, proxy reverso e configure `APP_ORIGIN`, `PROJECTS_ORIGIN`, `PROJECTS_DOMAIN` e `PROJECTS_SCHEME` com valores reais.
- Esta versão é um MVP funcional, não uma plataforma multi-tenant endurecida para executar conteúdo não confiável em escala. Não aceite projetos desconhecidos sem moderação e limites de recursos.
- A remoção de projeto encerra os processos ativos e exclui seus arquivos e registro do banco.

## Limitações

- Sites estáticos são servidos por caminho (`/SLUG/`); PHP e Node por subdomínio (`SLUG.PROJECTS_DOMAIN`).
- PHP usa o servidor embutido (`php -S`) com um roteador que encaminha para `index.php` quando o arquivo não existe — bom para apps de front controller, mas não é um `php-fpm` de alta concorrência.
- Node usa o `start` do `package.json` ou o arquivo de entrada detectado; não há detecção de framework (Next, Nest etc. rodam pelo script `start`).
- Sem bancos de dados gerenciados por projeto, sem variáveis de ambiente customizadas pela UI e sem domínios personalizados por projeto (ainda).
- Sem build/instalação isolados por projeto: o `node_modules` fica no diretório do projeto, no volume compartilhado.
