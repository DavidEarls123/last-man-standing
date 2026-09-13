import LeagueCrest from './LeagueCrest.jsx';

/** The league's own colours, crest and title at the top of each tab. */
export default function LeagueHeader({ league, children }) {
  return (
    <header className="league-head">
      <LeagueCrest league={league} />
      <div className="grow">
        <h1>{league.name}</h1>
        <div className="small">
          {league.tagline || `Starts gameweek ${league.startGameweek} · ${league.teamCount} teams`}
        </div>
      </div>
      {children}
    </header>
  );
}
