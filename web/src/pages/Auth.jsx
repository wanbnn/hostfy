import React, {useState} from 'react'
import {Button, Heading, Link, Stack, Text, TextInput, FormControl} from '@primer/react'
import {InlineMessage} from '@primer/react/experimental'
import {ArrowRightIcon} from '@primer/octicons-react'
import {api} from '../api.js'
import {Wordmark} from '../components/Layout.jsx'

export default function AuthPage({onAuthed}) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const isLogin = mode === 'login'

  async function submit(event) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await api(`/api/${mode}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({email, password}),
      })
      await onAuthed()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function switchMode(next) {
    setMode(next)
    setError('')
    setPassword('')
  }

  return (
    <div className="auth-wrap">
      <Wordmark className="auth-wordmark" />
      <Heading as="h1" className="auth-title">
        {isLogin ? 'Bem-vindo!' : 'Criar sua conta'}
      </Heading>

      <div className="auth-panel panel">
        <form onSubmit={submit}>
          <Stack gap="normal">
            {error ? <InlineMessage variant="critical">{error}</InlineMessage> : null}

            <FormControl required>
              <FormControl.Label>E-mail</FormControl.Label>
              <TextInput
                block
                type="email"
                autoComplete="email"
                placeholder="voce@exemplo.com"
                value={email}
                onChange={event => setEmail(event.target.value)}
              />
            </FormControl>

            <FormControl required>
              <FormControl.Label>Senha</FormControl.Label>
              <TextInput
                block
                type="password"
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                placeholder={isLogin ? 'Sua senha' : 'Mínimo de 10 caracteres'}
                value={password}
                onChange={event => setPassword(event.target.value)}
              />
              {!isLogin ? <FormControl.Caption>Use pelo menos 10 caracteres.</FormControl.Caption> : null}
            </FormControl>

            <Button variant="primary" type="submit" block loading={busy} leadingVisual={ArrowRightIcon}>
              {isLogin ? 'Entrar na plataforma' : 'Criar minha conta'}
            </Button>
          </Stack>
        </form>
      </div>

      <div className="switch-box">
        {isLogin ? (
          <Text>
            Novo por aqui?{' '}
            <Link as="button" type="button" onClick={() => switchMode('register')}>
              Criar uma conta
            </Link>
          </Text>
        ) : (
          <Text>
            Já tem uma conta?{' '}
            <Link as="button" type="button" onClick={() => switchMode('login')}>
              Entrar
            </Link>
          </Text>
        )}
      </div>
    </div>
  )
}