import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function App() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Seu app está pronto</CardTitle>
          <CardDescription>Descreva o que você quer construir no chat para gerar a interface.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button>Começar</Button>
        </CardContent>
      </Card>
    </main>
  )
}