export default async function handler(req, res) {
  try {
    const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
    const LEAGUE_ID = process.env.LEAGUE_ID;   // lo buscas tú en tu dashboard, ver instrucciones
    const SEASON = process.env.SEASON || "2026";

    const headers = {
      "x-rapidapi-key": RAPIDAPI_KEY,
      "x-rapidapi-host": "api-football-v1.p.rapidapi.com"
    };

    // 1. Tabla de posiciones actual (para medir la fuerza de cada equipo)
    const standingsRes = await fetch(
      `https://api-football-v1.p.rapidapi.com/v3/standings?league=${LEAGUE_ID}&season=${SEASON}`,
      { headers }
    );
    const standingsData = await standingsRes.json();
    const table = standingsData.response?.[0]?.league?.standings?.[0] || [];

    const teamStats = {};
    table.forEach(row => {
      const played = row.all.played || 1;
      teamStats[row.team.name] = {
        ppg: row.points / played,
        gdpg: (row.all.goals.for - row.all.goals.against) / played
      };
    });

    // 2. Próximos partidos
    const fixturesRes = await fetch(
      `https://api-football-v1.p.rapidapi.com/v3/fixtures?league=${LEAGUE_ID}&season=${SEASON}&next=9`,
      { headers }
    );
    const fixturesData = await fixturesRes.json();

    // ---- Mismo modelo estadístico que ya usa el sitio ----
    const LEAGUE_BASE_GOALS = 1.3;
    const HOME_ADV = 0.18;

    function poissonPMF(k, lambda) {
      let fact = 1;
      for (let i = 2; i <= k; i++) fact *= i;
      return Math.pow(lambda, k) * Math.exp(-lambda) / fact;
    }

    function runModel(homeStats, awayStats) {
      let lambdaHome = LEAGUE_BASE_GOALS + (homeStats.gdpg - awayStats.gdpg) / 2 + HOME_ADV;
      let lambdaAway = LEAGUE_BASE_GOALS + (awayStats.gdpg - homeStats.gdpg) / 2 - HOME_ADV * 0.5;
      lambdaHome = Math.max(0.35, lambdaHome);
      lambdaAway = Math.max(0.35, lambdaAway);

      let pHome = 0, pDraw = 0, pAway = 0, pOver25 = 0, pBTTS = 0, best = { p: 0, hg: 0, ag: 0 };
      for (let hg = 0; hg < 7; hg++) {
        for (let ag = 0; ag < 7; ag++) {
          const p = poissonPMF(hg, lambdaHome) * poissonPMF(ag, lambdaAway);
          if (hg > ag) pHome += p; else if (hg === ag) pDraw += p; else pAway += p;
          if (hg + ag > 2.5) pOver25 += p;
          if (hg > 0 && ag > 0) pBTTS += p;
          if (p > best.p) best = { p, hg, ag };
        }
      }
      const sorted = [pHome, pDraw, pAway].sort((a, b) => b - a);
      const confidence = (sorted[0] - sorted[1]) > 0.30 ? 'alta' : ((sorted[0] - sorted[1]) > 0.14 ? 'media' : 'baja');
      return {
        pHome, pDraw, pAway, scoreH: best.hg, scoreA: best.ag,
        pOver25, pBTTS, confidence,
        cornersEst: Math.round(((lambdaHome + lambdaAway) * 3.6) * 2) / 2 // heurística, no dato real
      };
    }

    const results = (fixturesData.response || []).map(f => {
      const home = f.teams.home.name, away = f.teams.away.name;
      const hs = teamStats[home], as_ = teamStats[away];
      if (!hs || !as_) {
        return { home, away, date: f.fixture.date, noData: true };
      }
      return { home, away, date: f.fixture.date, ...runModel(hs, as_) };
    });

    res.status(200).json({ updated: new Date().toISOString(), fixtures: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
