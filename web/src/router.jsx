import React, {createContext, useCallback, useContext, useEffect, useState} from 'react'

const RouterContext = createContext({path: '/', navigate: () => {}})

export function RouterProvider({children}) {
  const [path, setPath] = useState(() => window.location.pathname || '/')

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname || '/')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback(to => {
    if (to === window.location.pathname) return
    window.history.pushState({}, '', to)
    setPath(to)
    window.scrollTo(0, 0)
  }, [])

  return <RouterContext.Provider value={{path, navigate}}>{children}</RouterContext.Provider>
}

export function useRouter() {
  return useContext(RouterContext)
}

export function Link({to, children, onClick, ...rest}) {
  const {navigate} = useRouter()
  return (
    <a
      href={to}
      onClick={event => {
        event.preventDefault()
        if (onClick) onClick(event)
        navigate(to)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}