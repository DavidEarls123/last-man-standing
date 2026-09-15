import { Link, Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom';
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
import Logo from './components/Logo.jsx';
import GameMark from './components/GameMark.jsx';
import { BRAND, GAMES } from './lib/brand.js';

/**
 * Three levels, top to bottom: the company, then the game, then the league.
 *
 * The company bar carries nothing but the company and your account. The game
 * bar under it is a selector — one game today, and a second would simply be a
 * second chip. Everything below belongs to whichever league you are in.
 */
function TopBar() {
  const { user, signOut } = useAuth();
  const { pathname } = useLocation();
  // Every route belongs to a game. A second game would own its own path prefix;
  // until then everything is Last One Standing, league pages included.
  const activeGame = GAMES.find((game) => game.path !== '/' && pathname.startsWith(game.path))
    ?? GAMES[0];

  return (
    <div className="platformbars">
      <header className="companybar">
        <div className="companybar-inner">
          <NavLink to="/" className="brand">
            <span className="brand-mark"><Logo size={30} hole="var(--pitch-deep)" /></span>
            <span className="brand-company">{BRAND.company}</span>
          </NavLink>
          <div className="topbar-spacer" />
          {user && (
            <>
              {user.isSuperAdmin && (
                <NavLink to="/admin" className="btn btn-sm btn-ghost">Platform</NavLink>
              )}
              <NavLink to="/account" className="btn btn-sm btn-ghost desktop-only">Account</NavLink>
              <button type="button" className="btn-sm btn-ghost" onClick={signOut}>Sign out</button>
            </>
          )}
        </div>
      </header>

      <nav className="gamebar" aria-label="Games">
        <div className="gamebar-inner">
          {GAMES.map((game) => (
            <Link
              key={game.key}
              to={game.path}
              className={`gamechip${game.key === activeGame.key ? ' selected' : ''}`}
              aria-current={game.key === activeGame.key ? 'page' : undefined}
            >
              <GameMark
                game={game.key}
                size={19}
                hole={game.key === activeGame.key ? 'var(--floodlight)' : 'var(--pitch)'}
              />
              {game.name}
            </Link>
          ))}
          {GAMES.length === 1 && <span className="gamebar-soon">More games coming</span>}
        </div>
      </nav>
    </div>
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

function SiteFooter() {
  return (
    <footer className="sitefoot">
      <span><strong>{BRAND.product}</strong> — {BRAND.blurb}</span>
      <span>From {BRAND.company}</span>
    </footer>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <div className="app"><TopBar /><Spinner /></div>;

  // Signed out, the sign-in screen is the whole page — it carries its own
  // wordmark, so a second one in a header bar would only get in the way.
  if (!user) {
    return (
      <div className="app">
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
      <SiteFooter />
    </div>
  );
}
