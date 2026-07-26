import fs from 'fs';

// ═══════════════════════════════════════════════════════════════
// verify-yesterday.mjs (v9.2)
// 어제 prediction-log.json 항목 vs KBO 실제 결과 자동 매칭
// 사용법: node verify-yesterday.mjs [YYYY-MM-DD]
// ═══════════════════════════════════════════════════════════════

const BASE = process.env.KBO_BASE || 'http://localhost:5173/kbo-api';

const KBO_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': 'https://www.koreabaseball.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};
const LOG_FILE = 'prediction-log.json';

// crawl-schedule.mjs의 fetchMonthSchedule 패턴 재사용 (점수 포함)
async function fetchMonthSchedule(year, month) {
  const mm = String(month).padStart(2, '0');
  const r = await fetch(`${BASE}/ws/Schedule.asmx/GetScheduleList`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...KBO_HEADERS },
    body: `leId=1&srIdList=0%2C9%2C6&seasonId=${year}&gameMonth=${mm}&teamId=`,
  });
  if (!r.ok) throw new Error(`Schedule API ${r.status}`);
  const d = await r.json();

  let curDate = '';
  const games = [];
  for (const row of d.rows) {
    const cells = row.row;
    let offset = 0;
    if (cells[0].Class === 'day') { curDate = cells[0].Text; offset = 1; }
    const play = cells[offset + 1].Text;
    const m = play.match(/<span>([^<]+)<\/span><em>.*?<\/em><span>([^<]+)<\/span>/);
    // 점수 파싱: <em><span class="win/lose">N</span><span>vs</span><span>N</span></em>
    const scoreMatch = play.match(/<em><span[^>]*>(\d+)<\/span><span>vs<\/span><span[^>]*>(\d+)<\/span><\/em>/);
    const awayScore = scoreMatch ? parseInt(scoreMatch[1]) : null;
    const homeScore = scoreMatch ? parseInt(scoreMatch[2]) : null;
    if (m && awayScore != null && homeScore != null) {
      games.push({
        date: curDate,                  // "04.06(일)" 형태
        awayName: m[1], homeName: m[2],
        awayScore, homeScore,
      });
    }
  }
  return games;
}

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const target = process.argv[2] || getYesterday();
  const [y, mo, da] = target.split('-');
  console.log(`🔍 ${target} 결과 검증 시작...\n`);

  if (!fs.existsSync(LOG_FILE)) {
    console.error(`❌ ${LOG_FILE} 없음. 먼저 'node sim-today.mjs --log' 실행 필요`);
    process.exit(1);
  }

  const logData = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  const entries = logData.predictions.filter(p => p.date === target);
  if (entries.length === 0) {
    console.error(`❌ prediction-log.json에 ${target} 예측 없음`);
    process.exit(1);
  }
  if (entries.length > 1) {
    console.log(`📋 ${entries.length}개 버전 예측 발견: ${entries.map(e => e.version).join(', ')}\n`);
  }

  // KBO에서 결과 fetch
  let allResults;
  try {
    allResults = await fetchMonthSchedule(parseInt(y), parseInt(mo));
  } catch (e) {
    console.error('❌ KBO 결과 fetch 실패:', e.message);
    process.exit(1);
  }

  // 해당 날짜만 필터
  const dayMatch = `${mo}.${da}`;
  const dayResults = allResults.filter(g => g.date.startsWith(dayMatch));

  if (dayResults.length === 0) {
    console.log(`📭 ${target}: KBO에 결과 없음 (경기 미진행 또는 우천)`);
    return;
  }

  // 매칭 (모든 버전 entries에 대해)
  let hits = 0, misses = 0, unmatched = 0;
  for (const entry of entries) {
    if (entries.length > 1) console.log(`【${entry.version}】`);
    let eHits = 0;
    for (const pg of entry.games) {
      const result = dayResults.find(r =>
        (r.awayName.includes(pg.away) || pg.away.includes(r.awayName)) &&
        (r.homeName.includes(pg.home) || pg.home.includes(r.homeName))
      );
      if (!result) {
        unmatched++;
        console.log(`  ❓ ${pg.away} @ ${pg.home}: 결과 매칭 실패`);
        continue;
      }
      pg.actualAway = result.awayScore;
      pg.actualHome = result.homeScore;
      const actualWinner = result.homeScore > result.awayScore ? pg.home
        : result.awayScore > result.homeScore ? pg.away : 'draw';
      pg.hit = actualWinner === pg.predWinner;
      if (pg.hit) { hits++; eHits++; } else misses++;

      const mark = pg.hit ? '✅' : '❌';
      const conf = pg.confidence;
      console.log(`  ${mark} ${pg.away} @ ${pg.home}: 예측 ${pg.predWinner} ${conf} → 실제 ${result.awayScore}-${result.homeScore} (${actualWinner === 'draw' ? '무' : actualWinner})`);
    }
    if (entries.length > 1) console.log(`  → ${entry.version}: ${eHits}/${entry.games.length}\n`);
  }

  // 저장
  fs.writeFileSync(LOG_FILE, JSON.stringify(logData, null, 2));

  // 요약
  const total = hits + misses;
  const pct = total > 0 ? (hits / total * 100).toFixed(1) : '0.0';
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 ${target} 적중: ${hits}/${total} (${pct}%)`);
  if (unmatched > 0) console.log(`   매칭 실패: ${unmatched}경기`);

  // 누적 적중률 (확정 결과 있는 것만)
  const confirmed = logData.predictions.flatMap(p =>
    p.games.filter(g => g.hit !== null)
  );
  const cumHits = confirmed.filter(g => g.hit).length;
  const cumPct = confirmed.length > 0 ? (cumHits / confirmed.length * 100).toFixed(1) : '0.0';
  console.log(`📈 누적 적중: ${cumHits}/${confirmed.length} (${cumPct}%)`);
  console.log('='.repeat(50));
}

main().catch(e => { console.error(e); process.exit(1); });
