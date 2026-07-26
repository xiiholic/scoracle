import fs from 'fs';

// ═══════════════════════════════════════════════════════════════
// compute-historical-rsra.mjs (v9.3)
// Schedule.asmx에서 시즌 모든 경기 결과 fetch → 일자별 누적 rs/ra 계산
// → team-stats-snapshots/*.json 의 rs/ra/runDiff 필드 채움
// ═══════════════════════════════════════════════════════════════

const BASE = process.env.KBO_BASE || 'http://localhost:5173/kbo-api';

const KBO_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': 'https://www.koreabaseball.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};
const SNAP_DIR = 'team-stats-snapshots';

const NM = {
  '삼성':'samsung','KIA':'kia','LG':'lg','두산':'doosan','KT':'kt',
  'SSG':'ssg','한화':'hanwha','롯데':'lotte','NC':'nc','키움':'kiwoom'
};

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
    const scoreMatch = play.match(/<em><span[^>]*>(\d+)<\/span><span>vs<\/span><span[^>]*>(\d+)<\/span><\/em>/);
    const awayScore = scoreMatch ? parseInt(scoreMatch[1]) : null;
    const homeScore = scoreMatch ? parseInt(scoreMatch[2]) : null;
    if (m && awayScore != null && homeScore != null) {
      // curDate "04.06(일)" → "MM.DD"만 추출
      const dm = curDate.match(/^(\d{2})\.(\d{2})/);
      if (!dm) continue;
      games.push({
        date: `${year}-${dm[1]}-${dm[2]}`,
        awayId: NM[m[1]], homeId: NM[m[2]],
        awayScore, homeScore,
      });
    }
  }
  return games;
}

async function main() {
  // CLI: 처리할 시즌 연도 필터 (선택). 없으면 모든 스냅샷 파일 처리
  const yearFilter = process.argv[2] ? parseInt(process.argv[2]) : null;

  // 모든 스냅샷 파일 순회 (yearFilter 적용)
  const allFiles = fs.readdirSync(SNAP_DIR).filter(f => /^team-stats-\d{8}\.json$/.test(f));
  const files = yearFilter
    ? allFiles.filter(f => f.startsWith(`team-stats-${yearFilter}`))
    : allFiles;

  // 처리할 파일들의 연도 집합 → 필요한 시즌만 fetch
  const years = new Set(files.map(f => parseInt(f.match(/\d{4}/)[0])));
  console.log(`📊 시즌 경기 결과 fetch: ${[...years].join(', ')}년 3~4월...`);

  const games = [];
  for (const y of years) {
    games.push(...(await fetchMonthSchedule(y, 3)));
    games.push(...(await fetchMonthSchedule(y, 4)));
  }
  const validGames = games.filter(g => g.awayId && g.homeId);
  console.log(`  완료된 경기 ${validGames.length}건\n`);

  console.log(`📁 스냅샷 파일 ${files.length}개 처리...\n`);

  for (const file of files.sort()) {
    const dateStr = file.match(/(\d{4})(\d{2})(\d{2})/);
    const targetDate = `${dateStr[1]}-${dateStr[2]}-${dateStr[3]}`;

    // 해당 날짜까지(포함)의 경기만 누적 (같은 연도만)
    const targetYear = parseInt(targetDate.slice(0, 4));
    const upTo = validGames.filter(g => g.date <= targetDate && g.date.startsWith(`${targetYear}-`));
    const rs = {}, ra = {};
    for (const g of upTo) {
      rs[g.awayId] = (rs[g.awayId] || 0) + g.awayScore;
      ra[g.awayId] = (ra[g.awayId] || 0) + g.homeScore;
      rs[g.homeId] = (rs[g.homeId] || 0) + g.homeScore;
      ra[g.homeId] = (ra[g.homeId] || 0) + g.awayScore;
    }

    const snap = JSON.parse(fs.readFileSync(`${SNAP_DIR}/${file}`, 'utf8'));
    let updated = 0;
    for (const [id, t] of Object.entries(snap.teams)) {
      const r = rs[id] || 0, a = ra[id] || 0;
      t.rs = r;
      t.ra = a;
      t.runDiff = r - a;
      t.runDiffPerGame = t.g > 0 ? +((r - a) / t.g).toFixed(2) : 0;
      updated++;
    }
    snap.rsraComputed = new Date().toISOString();
    fs.writeFileSync(`${SNAP_DIR}/${file}`, JSON.stringify(snap, null, 2));
    console.log(`  ${file}: ${updated}팀 rs/ra 보강 (누적 ${upTo.length}경기)`);
  }

  console.log(`\n✅ 완료`);
}

main().catch(e => { console.error(e); process.exit(1); });
