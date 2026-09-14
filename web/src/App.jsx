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
      <div className="topbar-inner">
        <NavLink to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">⚽</span>
          <span>Last Man Standing</span>
        </NavLink>
        <div className="topbar-spacer" />
        {user && (
          <>
            <NavLink to="/" className="btn btn-sm btn-ghost desktop-only">My leagues</NavLink>
            {user.isSuperAdmin && (
              <NavLink to="/admin" className="btn btn-sm btn-ghost">Platform</NavLink>
            )}
            <button type="button" className="btn-sm btn-ghost" onClick={signOut}>Sign out</button>
          </>
        )}
      </div>
    </header>
  );
}

/**
 * One nav element, two shapes: a thumb-friendly bar pinned to the bottom on a
 * phone, and a row of pills under the header on a wider screen.
 */
function LeagueNav() {
  const { league } = useLeague();
  if (!league) return null;
  const base = `/leagues/${league.id}`;
  const canPick = league.entry?.status === 'active' && !(league.status === 'completed');
  const isAdmin = league.role === 'admin' || league.role === 'super_admin';

  return (
    <nav className="leaguenav" aria-label="League sections">
      <div className="leaguenav-inner">
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
      {/* Inside a league the account page keeps the league's tabs, so you can
          get back to Home or Pick without going out to the league list. */}
      <NavLink to={`${base}/account`}>
        <span className="tab-icon" aria-hidden="true">👤</span>
        Account
      </NavLink>
      </div>
    </nav>
  );
}

function LeagueShell() {
  const { leagueId } = useParams();
  return (
    <LeagueProvider leagueId={Number(leagueId)}>
      <LeagueNav />
      <div className="content">
        <Routes>
          <Route index element={<LeagueHomePage />} />
          <Route path="gameweek" element={<GameweekPage />} />
          <Route path="pick" element={<PickPage />} />
          <Route path="admin" element={<LeagueAdminPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="*" element={<Navigate to="." replace />} />
        </Routes>
      </div>
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
