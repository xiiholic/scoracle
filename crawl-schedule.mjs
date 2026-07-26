import fs from 'fs';

// ═══════════════════════════════════════════════════════════════
// KBO 당일 일정 + 예고선발 크롤러 (v9.1)
// kbo-simulation.jsx의 fetchKBOSchedule + fetchStartingPitchers 패턴 재사용
// 결과: schedule-today.json
// ═══════════════════════════════════════════════════════════════

const BASE = process.env.KBO_BASE || 'http://localhost:5173/kbo-api';
const OUT_FILE = 'schedule-today.json';

// KBO 서버가 XHR 헤더 없는 요청에 JSON 대신 HTML을 반환함 (2026-05-20경부터)
export const KBO_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': 'https://www.koreabaseball.com/Schedule/Schedule.aspx',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

const NM = {
  '삼성':'samsung','삼성 라이온즈':'samsung','LIONS':'samsung',
  '기아':'kia','KIA':'kia','KIA 타이거즈':'kia','TIGERS':'kia',
  'LG':'lg','LG 트윈스':'lg','TWINS':'lg',
  '두산':'doosan','두산 베어스':'doosan','BEARS':'doosan',
  'KT':'kt','KT 위즈':'kt','WIZ':'kt',
  'SSG':'ssg','SSG 랜더스':'ssg','LANDERS':'ssg',
  '한화':'hanwha','한화 이글스':'hanwha','EAGLES':'hanwha',
  '롯데':'lotte','롯데 자이언츠':'lotte','GIANTS':'lotte',
  'NC':'nc','NC 다이노스':'nc','DINOS':'nc',
  '키움':'kiwoom','키움 히어로즈':'kiwoom','HEROES':'kiwoom',
};

const STADIUM_NM = {
  '잠실':'잠실','문학':'문학','수원':'수원','대구':'대구','광주':'광주',
  '대전':'대전','사직':'부산','부산':'부산','창원':'창원','고척':'고척',
  '인천':'문학',
};

function tid(name) {
  if (!name) return null;
  const t = name.trim();
  return NM[t] || NM[t.toUpperCase()] || null;
}

// ── 월별 일정 가져오기 (Schedule.asmx) ──
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
    const time = cells[offset].Text.replace(/<[^>]+>/g, '').trim();
    const play = cells[offset + 1].Text;
    const m = play.match(/<span>([^<]+)<\/span><em>.*?<\/em><span>([^<]+)<\/span>/);
    const stCell = cells.slice(offset + 2).find(c =>
      c.Text && !c.Text.includes('<') && c.Text.length >= 2 && c.Text.length <= 4 && /^[가-힣]+$/.test(c.Text)
    );
    if (m) {
      games.push({
        date: curDate, time,
        awayName: m[1], homeName: m[2],
        stadiumRaw: stCell ? stCell.Text : '',
      });
    }
  }
  return games;
}

// ── 당일 선발투수 가져오기 (Main.asmx/GetKboGameList) ──
async function fetchStartingPitchers(dateStr) {
  const dt = dateStr.replace(/-/g, '');
  try {
    const r = await fetch(`${BASE}/ws/Main.asmx/GetKboGameList`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...KBO_HEADERS },
      body: `leId=1&srId=0,1,3,4,5,6,7,8,9&date=${dt}`,
    });
    if (!r.ok) return {};
    const d = await r.json();
    const map = {};
    for (const g of (d.game || [])) {
      const key = `${g.AWAY_NM.trim()}_${g.HOME_NM.trim()}`;
      map[key] = {
        awaySP: (g.T_PIT_P_NM || '').trim(),
        homeSP: (g.B_PIT_P_NM || '').trim(),
      };
    }
    return map;
  } catch (e) {
    console.warn('  ⚠️  선발투수 API 실패:', e.message);
    return {};
  }
}

// ── 메인 ──
async function main() {
  const argDate = process.argv[2];
  const target = argDate || new Date().toISOString().slice(0, 10);
  const [y, mo, da] = target.split('-');

  console.log(`📅 ${target} KBO 일정/예고선발 크롤링 시작...\n`);

  let monthGames;
  try {
    monthGames = await fetchMonthSchedule(parseInt(y), parseInt(mo));
  } catch (e) {
    console.error('❌ 일정 크롤링 실패:', e.message);
    // 캐시가 오늘 날짜일 때만 fallback 허용. 과거 날짜 캐시로 조용히 넘어가면
    // 파이프라인이 매일 같은 날을 재예측하는 침묵 실패가 됨 (2026-05-19~07-25 장애 원인)
    if (fs.existsSync(OUT_FILE)) {
      const cached = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      if (cached.date === target) {
        console.log(`⚠️  기존 캐시(${OUT_FILE}, ${cached.date}) 유지`);
        return;
      }
      console.error(`❌ 캐시 날짜(${cached.date})가 대상(${target})과 다름 — 실패 처리`);
    }
    process.exit(1);
  }

  // 해당 날짜만 필터
  const dayMatch = `${mo}.${da}`;
  const todayGames = monthGames.filter(g => g.date.startsWith(dayMatch));

  if (todayGames.length === 0) {
    console.log(`📭 ${target}: 예정된 경기 없음`);
    fs.writeFileSync(OUT_FILE, JSON.stringify({ date: target, games: [] }, null, 2));
    return;
  }

  const spMap = await fetchStartingPitchers(target);

  const games = [];
  for (const g of todayGames) {
    const homeId = tid(g.homeName);
    const awayId = tid(g.awayName);
    if (!homeId || !awayId) {
      console.warn(`  [SKIP] 팀 매칭 실패: ${g.awayName} @ ${g.homeName}`);
      continue;
    }
    const sp = spMap[`${g.awayName}_${g.homeName}`] || {};
    games.push({
      home: g.homeName, away: g.awayName,
      homeId, awayId,
      stadium: STADIUM_NM[g.stadiumRaw] || g.stadiumRaw,
      time: g.time,
      homeSP: sp.homeSP || '',
      awaySP: sp.awaySP || '',
    });
  }

  // 출력
  console.log(`총 ${games.length}경기:\n`);
  for (const g of games) {
    const sp = g.homeSP && g.awaySP ? `${g.awaySP} vs ${g.homeSP}` : '(선발 미정)';
    console.log(`  ${g.away} @ ${g.home} (${g.stadium} ${g.time}) — ${sp}`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ date: target, games }, null, 2));
  console.log(`\n✅ 저장: ${OUT_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
