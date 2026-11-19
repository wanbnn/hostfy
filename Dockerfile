# --- Build do frontend (React + Primer) ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install && npm cache clean --force
COPY . .
RUN npm run build

# --- Imagem de produção ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/public ./public
COPY src ./src
RUN mkdir -p /data/projects && chown -R node:node /app /data/projects
USER node
EXPOSE 1591 1592
CMD ["node", "src/server.js"]