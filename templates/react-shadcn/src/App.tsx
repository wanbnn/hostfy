import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Activity, ArrowRight, Sparkles } from 'lucide-react'

export default function App() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-50">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <a className="flex items-center gap-2 font-semibold tracking-tight" href="#inicio">
          <span className="grid size-9 place-items-center rounded-xl bg-indigo-500"><Sparkles className="size-5" /></span>
          <span>Seu projeto</span>
        </a>
        <nav className="hidden items-center gap-7 text-sm text-slate-300 sm:flex">
          <a className="hover:text-white" href="#recursos">Recursos</a>
          <a className="hover:text-white" href="#sobre">Sobre</a>
          <Button size="sm" className="bg-white text-slate-950 hover:bg-slate-200">Começar agora</Button>
        </nav>
      </header>
      <section id="inicio" className="mx-auto grid min-h-[78vh] max-w-6xl items-center gap-14 px-6 py-16 lg:grid-cols-[1.05fr_.95fr]">
        <div>
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-indigo-400/30 bg-indigo-400/10 px-3 py-1.5 text-sm text-indigo-200">
            <Activity className="size-4" /> Uma nova ideia começa aqui
          </div>
          <h1 className="max-w-2xl text-5xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">Uma experiência feita para <span className="text-indigo-300">ir mais longe.</span></h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-slate-300">Apresente sua ideia com clareza, conecte-se com as pessoas certas e transforme planos em resultados.</p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Button size="lg" className="bg-indigo-500 text-white hover:bg-indigo-400">Explore possibilidades <ArrowRight className="ml-2 size-4" /></Button>
            <Button size="lg" variant="outline" className="border-slate-700 bg-transparent text-white hover:bg-slate-800">Conheça a proposta</Button>
          </div>
          <p className="mt-8 text-sm text-slate-400">Simples para começar. Pronto para crescer.</p>
        </div>
        <Card className="overflow-hidden border-slate-800 bg-slate-900/80 text-white shadow-2xl shadow-indigo-950/40">
          <CardHeader className="border-b border-slate-800">
            <div className="mb-3 flex gap-1.5"><span className="size-2.5 rounded-full bg-rose-400" /><span className="size-2.5 rounded-full bg-amber-300" /><span className="size-2.5 rounded-full bg-emerald-400" /></div>
            <CardTitle className="text-xl">Tudo em movimento</CardTitle>
            <CardDescription className="text-slate-400">Uma visão clara do que vem pela frente.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 p-6">
            <div className="flex items-center justify-between rounded-xl bg-slate-800/80 p-4"><div><p className="text-sm text-slate-400">Progresso do projeto</p><p className="mt-1 text-2xl font-semibold">82%</p></div><div className="grid size-12 place-items-center rounded-full bg-indigo-500/20 text-indigo-300"><Activity className="size-6" /></div></div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-800"><div className="h-full w-[82%] rounded-full bg-gradient-to-r from-indigo-500 to-cyan-300" /></div>
            <div className="grid grid-cols-2 gap-3"><div className="rounded-xl border border-slate-800 p-4"><p className="text-sm text-slate-400">Próxima etapa</p><p className="mt-2 font-medium">Lançamento</p></div><div className="rounded-xl border border-slate-800 p-4"><p className="text-sm text-slate-400">Status</p><p className="mt-2 font-medium text-emerald-300">No caminho certo</p></div></div>
          </CardContent>
        </Card>
      </section>
      <section id="recursos" className="border-t border-slate-800 bg-slate-900/50 px-6 py-16"><div className="mx-auto grid max-w-6xl gap-8 sm:grid-cols-3"><div><p className="font-medium">Feito para você</p><p className="mt-2 text-sm leading-6 text-slate-400">Uma experiência simples, desenhada em torno das suas necessidades.</p></div><div><p className="font-medium">Clareza em cada passo</p><p className="mt-2 text-sm leading-6 text-slate-400">Informações e ferramentas para avançar com confiança.</p></div><div id="sobre"><p className="font-medium">Pronto para crescer</p><p className="mt-2 text-sm leading-6 text-slate-400">Uma base flexível que acompanha novas ideias e oportunidades.</p></div></div></section>
    </main>
  )
}
