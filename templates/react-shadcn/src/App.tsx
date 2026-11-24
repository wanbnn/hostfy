import { Button } from '@/components/ui/button'
import {
  AppShell,
  ContentGrid,
  DataTable,
  MetricCard,
  PageHeader,
  Panel,
  StatusBadge,
} from '@/components/hostfy'
import { Activity, Bell, Calendar, DollarSign, Home, Plus, Users } from 'lucide-react'

const navItems = [
  { label: 'Visão geral', href: '#inicio', icon: Home },
  { label: 'Reservas', href: '#reservas', icon: Calendar },
  { label: 'Hóspedes', href: '#hospedes', icon: Users },
  { label: 'Financeiro', href: '#financeiro', icon: DollarSign },
]

const reservations = [
  { id: '1', property: 'Apartamento Centro', guest: 'Ana Souza', date: '15 ago', status: <StatusBadge tone="positive">Confirmada</StatusBadge> },
  { id: '2', property: 'Casa na Praia', guest: 'Lucas Lima', date: '18 ago', status: <StatusBadge tone="warning">Pendente</StatusBadge> },
  { id: '3', property: 'Flat Sul', guest: 'Marina Costa', date: '22 ago', status: <StatusBadge tone="positive">Confirmada</StatusBadge> },
]

export default function App() {
  return (
    <AppShell
      brand="Workspace"
      navItems={navItems}
      activeHref="#inicio"
      header={(
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-muted-foreground sm:inline">Painel de demonstração</span>
          <Button variant="outline" size="icon" aria-label="Notificações"><Bell className="size-4" /></Button>
        </div>
      )}
      sidebarFooter={<span className="text-xs text-muted-foreground">Área de trabalho</span>}
    >
      <PageHeader
        title="Visão geral"
        description="Acompanhe as principais atividades e resultados."
        actions={<Button><Plus className="size-4" /> Nova reserva</Button>}
      />

      <ContentGrid columns={3}>
        <MetricCard label="Reservas ativas" value="128" change="+12%" hint="em relação ao mês passado" icon={Calendar} changeTone="positive" />
        <MetricCard label="Hóspedes" value="86" change="+8%" hint="nos últimos 30 dias" icon={Users} changeTone="positive" />
        <MetricCard label="Receita do mês" value="R$ 45.800" change="+5,4%" hint="receita líquida" icon={Activity} changeTone="positive" />
      </ContentGrid>

      <div className="mt-6" id="reservas">
        <Panel title="Reservas recentes" description="Atividade mais recente da sua conta.">
          <DataTable
            columns={[
              { key: 'property', label: 'Propriedade' },
              { key: 'guest', label: 'Hóspede' },
              { key: 'date', label: 'Check-in' },
              { key: 'status', label: 'Status' },
            ]}
            rows={reservations}
          />
        </Panel>
      </div>
    </AppShell>
  )
}
