import fs from 'fs';

// ═══════════════════════════════════════════════════════════════
// KBO 팀 순위/전적 크롤러 (v9.1)
// 팀 순위(승/패/무/승률) + 팀 타격(득점) + 팀 투수(실점) 통합
// 결과: team-stats.json
// ═══════════════════════════════════════════════════════════════

// 로컬: Vite proxy / CI(Actions): KBO 공식 URL 직접
const BASE = process.env.KBO_BASE || 'http://localhost:5173/kbo-api';

const KBO_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': 'https://www.koreabaseball.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};
const OUT_FILE = 'team-stats.json';
const SNAP_DIR = 'team-stats-snapshots';

const URL_RANK = `${BASE}/Record/TeamRank/TeamRank.aspx`;
const URL_HIT  = `${BASE}/Record/Team/Hitter/Basic1.aspx`;
const URL_PIT  = `${BASE}/Record/Team/Pitcher/Basic1.aspx`;

// 한글팀명 → 내부 ID
const NM = {
  '삼성':'samsung','KIA':'kia','LG':'lg','두산':'doosan','KT':'kt',
  'SSG':'ssg','한화':'hanwha','롯데':'lotte','NC':'nc','키움':'kiwoom'
};

async function fetchPage(url) {
  const r = await fetch(url, { headers: KBO_HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

// 단순 HTML 테이블 → 행 배열 파서
function parseTable(html) {
  const rows = [];
  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRe.exec(html))) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;
    while ((td = tdRe.exec(trMatch[0]))) {
      cells.push(td[1].replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, '').trim());
    }
    if (cells.length > 3) rows.push(cells);
  }
  return rows;
}

// ── 팀 순위 (TeamRank) ──
// 컬럼: 0순위 1팀명 2경기 3승 4패 5무 6승률 7게임차 8최근10경기 9연속 10홈 11방문
async function crawlRank() {
  const html = await fetchPage(URL_RANK);
  const rows = parseTable(html);
  const teams = {};
  for (const r of rows) {
    if (r.length < 7) continue;
    const teamKR = r[1];
    const id = NM[teamKR];
    if (!id) continue;
    teams[id] = {
      teamKR,
      g: parseInt(r[2]) || 0,
      w: parseInt(r[3]) || 0,
      l: parseInt(r[4]) || 0,
      t: parseInt(r[5]) || 0,
      pct: parseFloat(r[6]) || 0,
      last10: r[8] || '',   // "7승0무1패"
      streak: r[9] || '',   // "4승" / "2패"
    };
  }
  return teams;
}

// ── last10/streak → 모멘텀 점수 ──
// last10raw "7승1무2패" → 최근 10경기 승률
function parseLast10Pct(s) {
  if (!s) return null;
  const m = s.match(/(\d+)승(?:(\d+)무)?(\d+)패/);
  if (!m) return null;
  const w = +m[1], t = +(m[2] || 0), l = +m[3];
  const total = w + t + l;
  return total > 0 ? w / (w + l) : null; // 무는 제외
}
// streak "4승"=+4, "2패"=-2
function parseStreak(s) {
  if (!s) return 0;
  const m = s.match(/(\d+)(승|패)/);
  if (!m) return 0;
  return parseInt(m[1]) * (m[2] === '승' ? 1 : -1);
}

// ── 팀 타격 (득점) ──
// 컬럼: 순위 팀명 AVG G PA AB R ...
async function crawlHit() {
  const html = await fetchPage(URL_HIT);
  const rows = parseTable(html);
  const out = {};
  for (const r of rows) {
    if (r.length < 7) continue;
    const id = NM[r[1]];
    if (!id) continue;
    out[id] = parseInt(r[6]) || 0; // R = 득점
  }
  return out;
}

// ── 팀 투수 (실점) ──
// 컬럼: 순위 팀명 ERA G W L SV HLD WPCT IP H HR BB HBP SO R ER WHIP
async function crawlPit() {
  const html = await fetchPage(URL_PIT);
  const rows = parseTable(html);
  const out = {};
  for (const r of rows) {
    if (r.length < 16) continue;
    const id = NM[r[1]];
    if (!id) continue;
    // 컬럼 길이가 다를 수 있어서 끝에서 두 번째(R) 또는 정확한 인덱스 시도
    // 표준: r[14]=R, r[15]=ER
    out[id] = parseInt(r[14]) || 0;
  }
  return out;
}

// ── 메인 ──
async function main() {
  console.log('🏆 KBO 팀 순위/전적 크롤링 시작...\n');

  let rank, hit, pit;
  try {
    [rank, hit, pit] = await Promise.all([crawlRank(), crawlHit(), crawlPit()]);
  } catch (e) {
    console.error('❌ 크롤링 실패:', e.message);
    if (fs.existsSync(OUT_FILE)) {
      console.log(`⚠️  기존 캐시(${OUT_FILE}) 유지`);
      return;
    }
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const teams = {};
  for (const id of Object.values(NM)) {
    if (!rank[id]) continue;
    const r = rank[id];
    const rs = hit[id] ?? 0;
    const ra = pit[id] ?? 0;
    const last10pct = parseLast10Pct(r.last10);
    const streak = parseStreak(r.streak);
    teams[id] = {
      teamKR: r.teamKR,
      g: r.g, w: r.w, l: r.l, t: r.t,
      pct: r.pct,
      rs, ra,
      runDiff: rs - ra,
      runDiffPerGame: r.g > 0 ? +((rs - ra) / r.g).toFixed(2) : 0,
      last10raw: r.last10,
      last10pct: last10pct != null ? +last10pct.toFixed(3) : null,
      streakRaw: r.streak,
      streak,  // +n=연승, -n=연패
    };
  }

  // 출력
  console.log('팀\t경기\t승\t패\t무\t승률\t득점\t실점\t득실/G');
  console.log('─'.repeat(70));
  const sorted = Object.entries(teams).sort((a, b) => b[1].pct - a[1].pct);
  for (const [id, t] of sorted) {
    console.log(`${t.teamKR}\t${t.g}\t${t.w}\t${t.l}\t${t.t}\t${t.pct.toFixed(3)}\t${t.rs}\t${t.ra}\t${t.runDiffPerGame > 0 ? '+' : ''}${t.runDiffPerGame}`);
  }

  const payload = {
    crawlDate: today,
    crawlTime: new Date().toISOString(),
    teams,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log(`\n✅ 저장: ${OUT_FILE} (${Object.keys(teams).length}개 팀)`);

  // 일별 스냅샷 저장 (v9.2)
  if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR);
  const snapDate = today.replace(/-/g, '');
  const snapFile = `${SNAP_DIR}/team-stats-${snapDate}.json`;
  fs.writeFileSync(snapFile, JSON.stringify(payload, null, 2));
  console.log(`✅ 스냅샷: ${snapFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
