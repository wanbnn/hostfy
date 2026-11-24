// Servidor de produção do app gerado: entrega o build do Vite (dist/) e faz
// fallback para index.html em rotas do SPA.
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(__dirname, 'dist')
const port = Number(process.env.PORT || 3000)

const app = express()
app.use(express.static(dist))
app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))

app.listen(port, '0.0.0.0', () => {
  console.log(`App ouvindo em http://0.0.0.0:${port}`)
})