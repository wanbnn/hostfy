# Template React + shadcn/ui (Hostfy AI Builder)

Boilerplate base usado pelo AI Builder. O modelo de IA **não** gera estes arquivos:
ele apenas cria/edita arquivos de aplicação (normalmente `src/App.tsx`,
`src/components/*`, `src/pages/*`, `src/hooks/*`) via operações `create`, `update`
ou `patch` (unified diff). O backend mescla o template com essas operações antes
de publicar.

## Stack

- Vite + React 18 + TypeScript
- Tailwind CSS + shadcn/ui (Radix)
- lucide-react (ícones)
- recharts (gráficos)

## Estrutura

```
index.html
package.json          # vite está em dependencies (o runner instala com --omit=dev)
vite.config.ts        # alias "@" -> ./src
tailwind.config.js
postcss.config.js
components.json       # config do shadcn CLI
server.js             # serve dist/ em produção (script "start")
src/
  main.tsx
  App.tsx             # placeholder — o modelo sobrescreve
  index.css           # tokens shadcn (light/dark)
  lib/utils.ts        # cn()
  components/ui/*     # componentes shadcn prontos
```

## Importante

- O runner roda `npm ci --omit=dev` **antes** do `npm run build`. Por isso tudo que
  é necessário no build (`vite`, `@vitejs/plugin-react`, `tailwindcss`, `postcss`,
  `autoprefixer`) fica em `dependencies`, não em `devDependencies`. Se mover, o
  build quebra em produção.
- O script `start` (`node server.js`) é o que o runner executa para servir o app.
- Use sempre o alias `@/...` para imports internos.
- `package-lock.json` é versionado para que o `npm ci` seja determinístico.