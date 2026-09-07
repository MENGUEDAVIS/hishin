import { useEffect, useState, type ReactNode } from 'react';

export function Session({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ user?: { email?: string }; local?: boolean; error?: string } | null>(null);
  useEffect(() => {
    fetch('/api/me').then(async response => {
      if (!response.ok) throw new Error('Votre session a expiré.');
      return response.json();
    }).then(setState).catch(() => setState({ error: 'Session indisponible. Reconnectez-vous pour accéder à vos projets.' }));
  }, []);
  if (!state) return <p style={{ padding: 32 }}>Ouverture de votre espace…</p>;
  if (state.error) return <main style={{ padding: 32 }}><h1>HI—SHIN</h1><p>{state.error}</p><a href="/">Se connecter ou créer un compte</a></main>;
  return <><div className="session-bar"><span>{state.local ? 'Espace local' : state.user?.email || 'Mon compte'}</span>{!state.local && <a href="/logout">Se déconnecter</a>}</div>{children}</>;
}
