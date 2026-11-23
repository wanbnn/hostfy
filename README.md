# Hostfy

Plataforma de hospedagem com cadastro, login, múltiplos projetos por usuário, URL pública por slug e
painel com páginas separadas para projetos, aplicações Docker Compose, GitHub e manutenção do host.

Cada conta pode publicar:

- **Sites estáticos** (HTML, CSS, JS, imagens) — servidos por um servidor interno e publicados em subdomínio (`SEU-SLUG.SEU_DOMINIO`); sem domínio configurado, também respondem em `http://SEU_HOST:1592/SEU-SLUG/`.
- **Aplicações PHP** — executadas por um runner interno e publicadas em subdomínio (`SEU-SLUG.SEU_DOMINIO`).
- **Aplicações Node.js** — o runner roda `npm ci`/`npm install`, o build (se houver) e inicia a aplicação.
- **Projetos Docker Compose** — a partir de um ZIP ou de um repositório do GitHub (público ou privado);
  o Hostfy roda `docker compose up -d --build --remove-orphans` e publica o serviço web em subdomínio.

Além disso, cada projeto tem:

- **Um banco de dados PostgreSQL próprio** (na mesma instância do Postgres do servidor, sem contêiner
  ou imagem extra) — veja "Banco de dados por projeto".
- **Um gerenciador de arquivos** — liste, edite, envie, renomeie e exclua arquivos sem apagar e
  republicar o projeto — veja "Gerenciador de arquivos".

## Páginas do painel

| Rota | O que faz |
|---|---|
| `/` | **Visão geral** — resumo dos projetos, consumo total de CPU/memória e avisos de limpeza. |
| `/projects` | **Projetos** — gerenciamento com métricas por projeto, edição, logs, reiniciar/parar/redeploy, acesso a **Arquivos** e **Banco**. |
| `/files/:id` | **Arquivos** — gerenciador de arquivos do projeto (listar, editar, enviar, renomear, excluir). |
| `/database/:id` | **Banco** — banco de dados do projeto: conexão, uso de disco, tabelas e console SQL. |
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
- Sites estáticos (por caminho, sem domínio): http://localhost:1592/SEU-SLUG/
- Sites estáticos e aplicações PHP/Node/Docker (com domínio): https://SEU-SLUG.SEU_DOMINIO/

> O frontend (React + [Primer](https://primer.style), o design system do GitHub) é
> compilado com Vite durante o build da imagem (`npm run build` → `public/`).

Cada conta pode publicar vários projetos. O slug é único globalmente.

## Publicar um projeto

1. Comprima os arquivos do projeto em ZIP (o conteúdo na raiz do ZIP).
2. Entre no painel, informe nome, slug e o tipo de projeto (ou deixe **Detectar automaticamente**).
3. Envie o ZIP e abra o endereço gerado.

O tipo é detectado pelo conteúdo do ZIP:

- **Estático** — precisa de `index.html` na raiz. Publicado no subdomínio (`SLUG.PROJECTS_DOMAIN`) quando há domínio; caso contrário, em `/SLUG/`.
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

## Banco de dados por projeto

Cada projeto pode ter **um** banco de dados próprio, criado dentro da **mesma instância** do
PostgreSQL que já roda no serviço `db` (`postgres:17-alpine`). **Nenhum contêiner ou imagem extra é
criado** — o Hostfy apenas executa `CREATE DATABASE` e `CREATE ROLE` no Postgres que já existe.

- **Um banco por projeto.** A chave primária de `project_databases` é o `project_id`: o painel recusa
  um segundo banco para o mesmo projeto.
- **Usuário próprio e sem privilégios.** Cada banco tem um role dedicado (`NOSUPERUSER`,
  `NOCREATEDB`, `NOCREATEROLE`, limite de 20 conexões). Ele só enxerga o próprio banco — não pode
  tocar nos bancos dos outros usuários nem criar databases/roles.
- **Senha criptografada** (AES-256-GCM) em `project_databases.password_enc`; a senha em texto puro só
  é devolvida ao dono do projeto (no painel e no `DATABASE_URL`).
- **Variáveis de conexão automáticas.** Ao criar o banco, o Hostfy grava no projeto
  `DATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` e `DB_PASSWORD`, e reinicia a aplicação
  (quando o projeto é dinâmico).
- **Acesso de dentro do contêiner do projeto:** host `db`, porta `5432`. O runner conecta os
  contêineres do projeto à rede `hostfy_databases`, onde fica o Postgres — assim o projeto alcança o
  banco sem enxergar o painel nem o runner.
- **Acesso de fora do contêiner (local):** o serviço `db` publica a porta `DB_HOST_PORT`
  (padrão: `55432`) **presa ao `127.0.0.1`** — ou seja, apenas da própria máquina do servidor. O
  painel mostra essa URL em `/database/:id` ("acesso local ao servidor"). Para acessar o banco a
  partir de outro lugar, use um túnel, por exemplo
  `ssh -L 55432:127.0.0.1:55432 usuario@servidor` ou `cloudflared access tcp --hostname ...`.
- **Acesso de fora do contêiner (domínio público):** defina `PROJECT_DB_PUBLIC_HOST` (ex.:
  `db.seudominio.com`) e o painel passa a exibir a URL com esse domínio, em vez do `127.0.0.1`:
  `postgres://hostfy_u12:senha@db.seudominio.com:5432/hostfy_meuapp_12`. Para isso funcionar,
  o Cloudflare Tunnel precisa de uma rota `tcp://` para esse hostname — veja a seção
  [Acesso ao Postgres pelo domínio](#acesso-ao-postgres-pelo-domínio).
- **Console SQL** na página `/database/:id`: uma instrução por vez, até 500 linhas de resultado,
  timeout de 15 s e bloqueio de `DROP/CREATE/ALTER DATABASE`, `CREATE/ALTER/DROP ROLE` e
  `pg_terminate_backend`.
- **Tamanho:** o painel mostra quanto o banco ocupa (`pg_database_size`). Acima de
  `PROJECT_DB_ALERT_MB` (padrão: 200 MB) o usuário recebe um aviso — **nada é bloqueado**; o
  PostgreSQL compartilhado não tem cota rígida por database. O administrador pode acompanhar o
  consumo total em `/system`.
- **Exclusão:** apagar o projeto (ou o botão "Excluir banco") derruba o database e o role.

Exemplo de uso em `docker-compose.yml` do projeto:

```yaml
services:
  web:
    build: .
    environment:
      DATABASE_URL: ${DATABASE_URL}
    expose:
      - "80"
```

Em PHP/Node basta ler `process.env.DATABASE_URL` (ou `$_ENV['DATABASE_URL']`): o Hostfy já passa a
variável para o processo.

### Acesso ao Postgres pelo domínio (HAProxy em modo TCP)

Por padrão o Postgres fica inacessível pela internet: o `cloudflared` encaminha apenas
**HTTP** para o painel e para os projetos, e o banco escuta em `127.0.0.1` no host.

Para expor o banco como um PostgreSQL de verdade, com a URL
`postgresql://USER:SENHA@db.seudominio.com:5432/BANCO`, o Hostfy usa um **HAProxy em modo
TCP (Layer 4)** no host: ele escuta na porta `5432` e repassa os bytes para o container `db`.
O TLS é negociado pelo próprio Postgres, então o tráfego chega cifrado no banco.

```
servidor:5432  --TCP-->  haproxy (:5432)  --TCP-->  container db (:5432)
```

#### 1. Instalar o HAProxy

```bash
sudo ./scripts/setup-haproxy.sh
```

O script instala o pacote `haproxy`, copia `deploy/haproxy.cfg` para `/etc/haproxy/haproxy.cfg`
e habilita o serviço. O backend aponta para `127.0.0.1:${DB_HOST_PORT}`, a porta que o compose
já publica para o container `db`.

#### 2. Ligar o TLS no Postgres

```bash
sudo ./scripts/setup-postgres-tls.sh db.seudominio.com
```

Isso gera `./certs/{ca.crt,ca.key,server.crt,server.key}`. Depois, no `.env`:

```env
POSTGRES_SSL=true
```

e recrie o banco:

```bash
docker compose up -d db
```

> `./certs/` está no `.gitignore`: as chaves privadas nunca são versionadas.

#### 3. Apontar o domínio para o servidor

Crie o registro DNS `db.seudominio.com` apontando para o **IP do servidor** (A e/ou AAAA).
Não use o túnel HTTP do Cloudflare para isso: um hostname só roteia HTTP, e o Postgres fala TCP.

#### 4. Informar o hostname ao Hostfy

```env
PROJECT_DB_PUBLIC_HOST=db.seudominio.com
PROJECT_DB_PUBLIC_PORT=5432
```

Recorde o painel (`docker compose up -d app`). A página `/database/:id` passa a exibir a URL
pronta para colar no cliente SQL:

```
postgresql://hostfy_u12:senha@db.seudominio.com:5432/hostfy_meuapp_12
```

#### 5. Liberar a porta 5432 no firewall

```bash
sudo ufw allow 5432/tcp      # se usar ufw
sudo nft add rule inet filter input tcp dport 5432 accept   # se usar nftables
```

E faça o forward no roteador, se o servidor estiver atrás de NAT:

```
porta externa 5432  ->  IP-DO-SERVIDOR:5432
```

#### Conectando

No cliente SQL (DBeaver, pgAdmin, TablePlus) use **SSL** e a URL acima. Para validar o
certificado da CA do servidor, baixe o `certs/ca.crt` e use `sslmode=verify-full`;
com `sslmode=require` o certificado não é validado (ainda criptografado).

> O host `db` e a porta `5432` continuam sendo o endereço **dentro do contêiner do projeto** —
> não muda nada para a aplicação. O domínio é só a forma de chegar ao banco da sua máquina.

> **Segurança:** o `pg_hba.conf` do Postgres aceita `scram-sha-256` de qualquer origem. Cada projeto
> usa uma senha aleatória de 40 caracteres e um role sem superusuário, mas o acesso público
> ainda é amplo. Restrinja por IP no `pg_hba.conf` ou use uma allowlist no HAProxy se a exposição
> não for para a internet toda.

## Gerenciador de arquivos

A página `/files/:id` permite trabalhar nos arquivos de um projeto **sem apagá-lo e republicá-lo**:

- listar pastas e arquivos (com tamanho e data), navegar por trilha de pastas;
- abrir arquivos de texto no editor e salvar;
- enviar vários arquivos de uma vez;
- criar pastas, renomear e excluir (arquivo ou pasta inteira);
- baixar arquivos binários.

Segurança: todo caminho é resolvido dentro da pasta do projeto (travessia é bloqueada), links
simbólicos são ignorados na listagem e recusados na escrita, o upload é limitado por
`MAX_UPLOAD_MB` e a edição no painel por `MAX_EDIT_BYTES`.

> Alterações em arquivos só valem para o site depois de um **restart** do projeto (botão "Reiniciar"),
> pois o runner mantém o processo em memória.

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

Os sites estáticos e as aplicações PHP/Node são servidos por subdomínio
(`SEU-SLUG.PROJECTS_DOMAIN`) e o runner escuta na porta **1593** (ele repassa os
estáticos ao servidor de arquivos). Com Cloudflare Tunnel, crie um registro DNS
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

Para expor também o **Postgres** pelo domínio (rota `tcp://`), veja
[Acesso ao Postgres pelo domínio](#acesso-ao-postgres-pelo-domínio).

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
| `PROJECTS_DOMAIN` | (vazio) | Domínio base dos subdomínios dos projetos, inclusive estáticos (ex.: `sites.seudominio.com`) |
| `PROJECTS_SCHEME` | https | Esquema usado para montar a URL das aplicações |
| `PORT_BASE` | 21000 | Primeira porta interna atribuída aos processos |
| `RUNNER_NODE_MEM_MB` | 256 | Limite de heap (`--max-old-space-size`) por app Node |
| `RUNNER_PHP_MEMORY` | 256M | `memory_limit` por app PHP |
| `RUNNER_MAX_RESTARTS` | 5 | Reinícios automáticos antes de marcar erro |
| `MAX_UPLOAD_MB` | 100 | Limite do ZIP recebido |
| `PROJECT_DB_HOST` | db | Host do Postgres dos projetos (visto da rede do compose) |
| `PROJECT_DB_PORT` | 5432 | Porta do Postgres dos projetos |
| `PROJECT_DB_ALERT_MB` | 200 | Tamanho (MB) que dispara o aviso de banco grande (não bloqueia) |
| `DB_HOST_PORT` | 55432 | Porta do Postgres publicada no host, presa ao `127.0.0.1` (usada pelo HAProxy) |
| `POSTGRES_SSL` | false | Liga o TLS no Postgres (usa `./certs/`) |
| `PROJECT_DB_PUBLIC_HOST` | (vazio) | Hostname público do Postgres (ex.: `db.seudominio.com`) exibido na URL externa do painel |
| `PROJECT_DB_PUBLIC_PORT` | 5432 | Porta usada junto com `PROJECT_DB_PUBLIC_HOST` |
| `MAX_EDIT_BYTES` | 2 | Tamanho máximo (MB) de um arquivo editado no painel |
| `DATABASES_NETWORK` | hostfy_databases | Rede Docker onde o Postgres é publicado para os projetos |
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
- **Bancos por projeto:** os contêineres dos projetos são conectados à rede `hostfy_databases`, onde
  fica o Postgres. Eles **não** enxergam o painel nem a API do runner. Ainda assim, o usuário do
  projeto tem acesso ao próprio banco por completo (inclusive `DROP TABLE`) e o console SQL do painel
  roda com esse mesmo usuário — restrinja quem pode publicar projetos.
- **Limpeza do Docker:** a manutenção automática (e o prune em `/system`) age sobre o Docker do host, não apenas sobre recursos do Hostfy. Revise os avisos, a carência (`CLEANUP_GRACE_HOURS`) e o preview do prune antes de habilitar em produção.
- A API interna do runner (`RUNNER_CONTROL_PORT`) **não deve ser exposta** publicamente; defina um `RUNNER_TOKEN` forte.
- Para produção, use HTTPS, proxy reverso e configure `APP_ORIGIN`, `PROJECTS_ORIGIN`, `PROJECTS_DOMAIN` e `PROJECTS_SCHEME` com valores reais.
- Esta versão é um MVP funcional, não uma plataforma multi-tenant endurecida para executar conteúdo não confiável em escala. Não aceite projetos desconhecidos sem moderação e limites de recursos.
- A remoção de projeto encerra os processos ativos e exclui seus arquivos e registro do banco.

## Limitações

- Com `PROJECTS_DOMAIN` configurado, sites estáticos e PHP/Node usam subdomínio (`SLUG.PROJECTS_DOMAIN`); o runner recebe o subdomínio e repassa os estáticos ao servidor de arquivos. Sem domínio, os estáticos ficam no caminho (`/SLUG/`).
- PHP usa o servidor embutido (`php -S`) com um roteador que encaminha para `index.php` quando o arquivo não existe — bom para apps de front controller, mas não é um `php-fpm` de alta concorrência.
- Node usa o `start` do `package.json` ou o arquivo de entrada detectado; não há detecção de framework (Next, Nest etc. rodam pelo script `start`).
- Sem build/instalação isolados por projeto: o `node_modules` fica no diretório do projeto, no volume compartilhado.
- **Banco por projeto:** o Postgres é compartilhado entre todos os usuários. Não existe cota rígida de
  tamanho por database (o PostgreSQL não a oferece) — o painel apenas avisa a partir de
  `PROJECT_DB_ALERT_MB`. Para isolamento forte, use um host dedicado ou um serviço de banco
  dedicado.
- **Senha do banco:** a senha do projeto é gravada em texto puro nas variáveis de ambiente do
  projeto (`projects.env_json`), porque o processo precisa dela. Trate `DATABASE_URL` como segredo e
  não exponha o painel.
