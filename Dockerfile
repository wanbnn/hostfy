# --- Build do frontend (React + Primer) ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install && npm cache clean --force
COPY . .
RUN npm run build && npm ci --prefix templates/react-shadcn --omit=dev --no-audit --no-fund

# --- Imagem de produção ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/public ./public
COPY src ./src
# Boilerplate usado pelo AI Builder (React + shadcn/ui + lucide + recharts).
COPY --chown=node:node templates ./templates
COPY --from=build /app/templates/react-shadcn/node_modules ./templates/react-shadcn/node_modules
RUN mkdir -p /app/data /data/projects && chown node:node /app/data /data/projects
USER node
EXPOSE 1591 1592
CMD ["node", "src/server.js"]
