import fs from 'fs';

// ═══════════════════════════════════════════════════════════════
// KBO 최근 10경기 데이터 크롤러
// 각 선수의 개인 상세 페이지에서 "최근 10경기" 합계를 추출
// ═══════════════════════════════════════════════════════════════

const BASE = process.env.KBO_BASE || 'http://localhost:5173/kbo-api';

const KBO_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': 'https://www.koreabaseball.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};
const CACHE_FILE = 'recent-stats.json';

// ── 캐시 확인 ──
function checkCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  if (data.crawlDate === today) return data;
  return null;
}

// ── KBO_TEAMS에서 선수명 추출 ──
function getTeamPlayers() {
  const jsx = fs.readFileSync('kbo-simulation.jsx', 'utf8');
  const teamsMatch = jsx.match(/const KBO_TEAMS\s*=\s*\{([\s\S]*?)\n\};/);
  const hitters = new Set();
  const pitchers = new Set();

  // lineup 선수 (타자)
  const lineupRe = /lineup:\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = lineupRe.exec(teamsMatch[0]))) {
    const nameRe = /name:\s*"([^"]+)"/g;
    let n;
    while ((n = nameRe.exec(m[1]))) hitters.add(n[1]);
  }

  // starters 선수 (투수)
  const startersRe = /starters:\s*\[([\s\S]*?)\]/g;
  while ((m = startersRe.exec(teamsMatch[0]))) {
    const nameRe = /name:\s*"([^"]+)"/g;
    let n;
    while ((n = nameRe.exec(m[1]))) pitchers.add(n[1]);
  }

  return { hitters: [...hitters], pitchers: [...pitchers] };
}

// ── HTML 테이블 파싱 ──
function parseTable(html) {
  const rows = [];
  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(html))) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;
    while ((td = tdRe.exec(tr[0]))) {
      cells.push(td[1].replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, '').trim());
    }
    if (cells.length > 3) rows.push(cells);
  }
  return rows;
}

// ── 선수 ID 매핑 (이름 → playerId) ──
async function fetchPlayerIds(type) {
  const path = type === 'hitter'
    ? '/Record/Player/HitterBasic/Basic1.aspx'
    : '/Record/Player/PitcherBasic/Basic1.aspx';
  const detailPath = type === 'hitter' ? 'HitterDetail' : 'PitcherDetail';

  const map = {};
  // 최대 3페이지까지 (30명/페이지)
  for (let page = 1; page <= 3; page++) {
    const url = page === 1
      ? `${BASE}${path}`
      : `${BASE}${path}?hfPage=${page}`;
    try {
      const r = await fetch(url, { headers: KBO_HEADERS });
      const html = await r.text();
      const re = new RegExp(`${detailPath}/Basic\\.aspx\\?playerId=(\\d+)[^>]*>([^<]+)`, 'g');
      let m;
      let count = 0;
      while ((m = re.exec(html))) {
        map[m[2].trim()] = m[1];
        count++;
      }
      if (count === 0) break; // 더 이상 데이터 없으면 중단
    } catch (e) {
      break;
    }
  }
  return map;
}

// ── 개별 선수 최근 10경기 크롤링 ──
async function fetchRecent10(playerId, type) {
  const path = type === 'hitter'
    ? `/Record/Player/HitterDetail/Basic.aspx?playerId=${playerId}`
    : `/Record/Player/PitcherDetail/Basic.aspx?playerId=${playerId}`;

  const r = await fetch(`${BASE}${path}`, { headers: KBO_HEADERS });
  const html = await r.text();

  const idx = html.indexOf('최근 10경기');
  if (idx === -1) return null;

  const after = html.substring(idx);
  const tableM = after.match(/<table[\s\S]*?<\/table>/);
  if (!tableM) return null;

  const rows = parseTable(tableM[0]);
  if (rows.length < 2) return null; // 헤더만 있으면 데이터 없음

  // 합계 행 찾기
  const totalsRow = rows.find(r => r[0] === '합계');
  if (!totalsRow) return null;

  // 경기 수 = 전체 행 - 헤더 - 합계
  const games = rows.length - 2;

  if (type === 'hitter') {
    // 합계: AVG, PA, AB, R, H, 2B, 3B, HR, RBI, SB, CS, BB, HBP, SO, GDP
    const pa = +totalsRow[2] || 0;
    const ab = +totalsRow[3] || 0;
    const h = +totalsRow[5] || 0;
    const d2 = +totalsRow[6] || 0;
    const t3 = +totalsRow[7] || 0;
    const hr = +totalsRow[8] || 0;
    const bb = +totalsRow[12] || 0;
    const hbp = +totalsRow[13] || 0;
    const sf = 0; // 합계에 SF 없음, 근사치 사용

    const avg = ab > 0 ? +(h / ab).toFixed(3) : 0;
    const obp = pa > 0 ? +((h + bb + hbp) / pa).toFixed(3) : 0;
    const tb = (h - d2 - t3 - hr) + d2 * 2 + t3 * 3 + hr * 4;
    const slg = ab > 0 ? +(tb / ab).toFixed(3) : 0;

    return { games, pa, ab, avg, obp, slg, hr, h, bb, hbp };
  } else {
    // 투수 합계: ERA, TBF, IP, H, HR, BB, HBP, SO, R, ER, AVG
    const era = +totalsRow[1] || 0;
    const tbf = +totalsRow[2] || 0;
    const ipStr = totalsRow[3] || '0';
    const ip = parseFloat(ipStr) || 0;
    const h = +totalsRow[4] || 0;
    const hr = +totalsRow[5] || 0;
    const bb = +totalsRow[6] || 0;
    const so = +totalsRow[8] || 0;
    const er = +totalsRow[10] || 0;

    const whip = ip > 0 ? +((h + bb) / ip).toFixed(3) : 0;
    const k9 = ip > 0 ? +(so / ip * 9).toFixed(1) : 0;
    const bb9 = ip > 0 ? +(bb / ip * 9).toFixed(1) : 0;

    return { games, ip, era, whip, k9, bb9, so, bb, hr };
  }
}

// ── 메인 ──
async function main() {
  // 캐시 확인
  const cached = checkCache();
  if (cached) {
    console.log(`오늘(${cached.crawlDate}) 이미 크롤링됨. 캐시 사용.`);
    console.log(`  타자: ${Object.keys(cached.hitters).length}명, 투수: ${Object.keys(cached.pitchers).length}명`);
    return;
  }

  console.log('🔍 KBO_TEAMS 선수 목록 추출...');
  const { hitters: hitterNames, pitchers: pitcherNames } = getTeamPlayers();
  console.log(`  타자: ${hitterNames.length}명, 투수: ${pitcherNames.length}명`);

  console.log('\n📋 선수 ID 매핑 크롤링...');
  const [hitterIds, pitcherIds] = await Promise.all([
    fetchPlayerIds('hitter'),
    fetchPlayerIds('pitcher'),
  ]);
  console.log(`  타자 ID: ${Object.keys(hitterIds).length}명, 투수 ID: ${Object.keys(pitcherIds).length}명`);

  // ── 타자 최근 10경기 ──
  console.log('\n🏏 타자 최근 10경기 크롤링...');
  const hitters = {};
  let hFound = 0, hMissing = 0;
  for (const name of hitterNames) {
    const pid = hitterIds[name];
    if (!pid) {
      // 이름 부분 매칭 시도
      const match = Object.entries(hitterIds).find(([k]) => k.includes(name) || name.includes(k));
      if (!match) { hMissing++; continue; }
      const data = await fetchRecent10(match[1], 'hitter');
      if (data) { hitters[name] = data; hFound++; console.log(`  ${name} (${match[0]}): ${data.games}경기 AVG:${data.avg} OBP:${data.obp} SLG:${data.slg}`); }
      continue;
    }
    const data = await fetchRecent10(pid, 'hitter');
    if (data && data.games > 0) {
      hitters[name] = data;
      hFound++;
      console.log(`  ${name}: ${data.games}경기 AVG:${data.avg} OBP:${data.obp} SLG:${data.slg} HR:${data.hr}`);
    } else {
      hMissing++;
    }
  }

  // ── 투수 최근 10경기 ──
  console.log('\n⚾ 투수 최근 10경기 크롤링...');
  const pitchers = {};
  let pFound = 0, pMissing = 0;
  for (const name of pitcherNames) {
    const pid = pitcherIds[name];
    if (!pid) {
      const match = Object.entries(pitcherIds).find(([k]) => k.includes(name) || name.includes(k));
      if (!match) { pMissing++; continue; }
      const data = await fetchRecent10(match[1], 'pitcher');
      if (data) { pitchers[name] = data; pFound++; console.log(`  ${name} (${match[0]}): ${data.games}경기 ERA:${data.era} WHIP:${data.whip}`); }
      continue;
    }
    const data = await fetchRecent10(pid, 'pitcher');
    if (data && data.games > 0) {
      pitchers[name] = data;
      pFound++;
      console.log(`  ${name}: ${data.games}경기 ERA:${data.era} WHIP:${data.whip} K/9:${data.k9}`);
    } else {
      pMissing++;
    }
  }

  // ── 저장 ──
  const result = {
    crawlDate: new Date().toISOString().slice(0, 10),
    hitters,
    pitchers,
  };

  fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('📊 최근 10경기 크롤링 완료');
  console.log('='.repeat(60));
  console.log(`타자: ${hFound}명 성공, ${hMissing}명 ID없음/데이터없음`);
  console.log(`투수: ${pFound}명 성공, ${pMissing}명 ID없음/데이터없음`);
  console.log(`저장: ${CACHE_FILE}`);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
