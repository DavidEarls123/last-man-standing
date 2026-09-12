import { Navigate, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { Spinner } from './components/ui.jsx';
import AuthPage from './pages/AuthPage.jsx';
import LeagueListPage from './pages/LeagueListPage.jsx';
import LeagueHomePage from './pages/LeagueHomePage.jsx';
import GameweekPage from './pages/GameweekPage.jsx';
import PickPage from './pages/PickPage.jsx';
import LeagueAdminPage from './pages/LeagueAdminPage.jsx';
import AccountPage from './pages/AccountPage.jsx';
import SuperAdminPage from './pages/SuperAdminPage.jsx';
import JoinPage from './pages/JoinPage.jsx';
import { LeagueProvider, useLeague } from './league.jsx';

function TopBar() {
  const { user, signOut } = useAuth();
  return (
    <header className="topbar">
      <NavLink to="/" className="brand">
        <span className="brand-mark" aria-hidden="true">⚽</span>
        <span>Last Man Standing</span>
      </NavLink>
      <div className="topbar-spacer" />
      {user && (
        <>
          {user.isSuperAdmin && (
            <NavLink to="/admin" className="btn btn-sm btn-ghost">Platform</NavLink>
          )}
          <button type="button" className="btn-sm btn-ghost" onClick={signOut}>Sign out</button>
        </>
      )}
    </header>
  );
}

function LeagueTabs() {
  const { league } = useLeague();
  if (!league) return null;
  const base = `/leagues/${league.id}`;
  const canPick = league.entry?.status === 'active' && !(league.status === 'completed');
  const isAdmin = league.role === 'admin' || league.role === 'super_admin';

  return (
    <nav className="tabbar">
      <NavLink to={base} end>
        <span className="tab-icon" aria-hidden="true">🏠</span>
        Home
      </NavLink>
      <NavLink to={`${base}/gameweek`}>
        <span className="tab-icon" aria-hidden="true">📊</span>
        Gameweek
      </NavLink>
      {canPick && (
        <NavLink to={`${base}/pick`}>
          <span className="tab-icon" aria-hidden="true">✅</span>
          Pick
        </NavLink>
      )}
      {isAdmin && (
        <NavLink to={`${base}/admin`}>
          <span className="tab-icon" aria-hidden="true">🛠</span>
          Manage
        </NavLink>
      )}
      <NavLink to="/account">
        <span className="tab-icon" aria-hidden="true">👤</span>
        Account
      </NavLink>
    </nav>
  );
}

function LeagueShell() {
  const { leagueId } = useParams();
  return (
    <LeagueProvider leagueId={Number(leagueId)}>
      <div className="content">
        <Routes>
          <Route index element={<LeagueHomePage />} />
          <Route path="gameweek" element={<GameweekPage />} />
          <Route path="pick" element={<PickPage />} />
          <Route path="admin" element={<LeagueAdminPage />} />
          <Route path="*" element={<Navigate to="." replace />} />
        </Routes>
      </div>
      <LeagueTabs />
    </LeagueProvider>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <div className="app"><TopBar /><Spinner /></div>;

  if (!user) {
    return (
      <div className="app">
        <TopBar />
        <Routes>
          <Route path="/join/:code" element={<AuthPage />} />
          <Route path="/reset" element={<AuthPage initialMode="reset" />} />
          <Route path="*" element={<AuthPage />} />
        </Routes>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar />
      <Routes>
        <Route path="/" element={<div className="content"><LeagueListPage /></div>} />
        <Route path="/join/:code" element={<div className="content"><JoinPage /></div>} />
        <Route path="/account" element={<div className="content"><AccountPage /></div>} />
        <Route path="/admin/*" element={<div className="content"><SuperAdminPage /></div>} />
        <Route path="/leagues/:leagueId/*" element={<LeagueShell />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
