# Hostfy

Plataforma de hospedagem de projetos HTML estáticos com cadastro, login, múltiplos projetos por usuário e URL pública por slug.

## Requisitos

- Docker Engine e Docker Compose v2.
- Porta 1591 (painel/API) e 1592 (sites publicados) disponíveis.

## Subir

```bash
cp .env.example .env
# Edite .env e defina POSTGRES_PASSWORD e JWT_SECRET fortes.
docker compose up -d --build
```

- Painel: http://localhost:1591
- Projetos: http://localhost:1592/SEU-SLUG/

> O frontend (React + [Primer](https://primer.style), o design system do GitHub) é
> compilado com Vite durante o build da imagem (`npm run build` → `public/`).

Cada conta pode publicar vários projetos. O slug é único globalmente.

## Publicar um projeto

1. Comprima os arquivos do site em ZIP.
2. `index.html` deve estar na raiz do ZIP (não dentro de uma pasta adicional).
3. Entre no painel, informe nome e slug e envie o ZIP.
4. Abra o endereço gerado.

Exemplo de estrutura:
```
meu-site.zip
├── index.html
├── styles.css
├── app.js
└── assets/
    └── logo.png
```

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
| `STATIC_PORT` | 1592 | Porta dos projetos publicados |
| `MAX_UPLOAD_MB` | 100 | Limite do ZIP recebido |

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
- O servidor de arquivos é separado do painel/API, reduzindo o risco de conteúdo HTML enviado por usuários acessar a sessão do painel. **Mantenha origens/domínios separados em produção.**
- Para produção, use HTTPS, proxy reverso (Nginx/Traefik), configure `APP_ORIGIN` e `PROJECTS_ORIGIN` com domínios reais e aplique limites de CPU/memória/disco. Considere servir projetos em domínio dedicado (ex.: `sites.seudominio.com`) e o painel em outro domínio.
- Esta versão é um MVP funcional, não uma plataforma multi-tenant endurecida para executar conteúdo não confiável em escala. HTML/JS enviados são código ativo no navegador dos visitantes; não envie projetos desconhecidos sem isolamento e moderação.
- A remoção de projeto exclui seus arquivos e registro do banco.

## Limitações

Hospeda sites estáticos (HTML, CSS, JS, imagens, fontes e outros arquivos). Não executa PHP, Node.js, Python, bancos individuais ou processos de backend dentro dos projetos.
