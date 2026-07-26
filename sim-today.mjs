import fs from 'fs';
import _ from 'lodash';

// ── JSX에서 데이터 추출 (eval) ──
const jsx = fs.readFileSync('kbo-simulation.jsx', 'utf8');
const STADIUMS = eval('(' + jsx.match(/const STADIUMS\s*=\s*(\{[\s\S]*?\n\};)/)[1].replace(/};$/, '}') + ')');
const WEATHER_EFFECTS = eval('(' + jsx.match(/const WEATHER_EFFECTS\s*=\s*(\{[\s\S]*?\n\};)/)[1].replace(/};$/, '}') + ')');
const DAY_OF_WEEK_MOD = eval('(' + jsx.match(/const DAY_OF_WEEK_MOD\s*=\s*(\{[\s\S]*?\};)/)[1].replace(/};$/, '}') + ')');
const TIME_SLOT_MOD = eval('(' + jsx.match(/const TIME_SLOT_MOD\s*=\s*(\{[\s\S]*?\};)/)[1].replace(/};$/, '}') + ')');
const H2H_RECORDS = eval('(' + jsx.match(/const H2H_RECORDS\s*=\s*(\{[\s\S]*?\n\};)/)[1].replace(/};$/, '}') + ')');
const MATCHUPS = eval('(' + jsx.match(/const MATCHUPS\s*=\s*(\{[\s\S]*?\n\};)/)[1].replace(/};$/, '}') + ')');
const KBO_TEAMS = eval('(' + jsx.match(/const KBO_TEAMS\s*=\s*(\{[\s\S]*?\n\};)/)[1].replace(/};$/, '}') + ')');

// ── Helper functions ──
function getTimeSlot(t) { if(!t) return "night"; const h=parseInt(t.split(":")[0]); return h<16?"day":h<18?"evening":"night"; }
function getOddsMod(hr,ar) { const d=hr-ar,a=Math.abs(d),u=_.clamp(a*.003,0,.05),f=_.clamp(a*.002,0,.03); if(d>0) return {home:1-f,away:1+u}; if(d<0) return {home:1+u,away:1-f}; return {home:1,away:1}; }
function getH2HMod(h,a) { const w=H2H_RECORDS[h]?.[a]; if(w==null) return {home:1,away:1}; const d=(w-.5)*.15; return {home:1+d,away:1-d}; }
function getMatchupMod(pn,bn) { const m=MATCHUPS[pn]?.[bn]; if(!m||m.pa<20) return 1; return 1+_.clamp((m.avg-.26)*.3,-.08,.08); }
const LA = { avg:.265, obp:.340, slg:.410, era:3.80, whip:1.22, k9:8.0, bb9:2.8 };
function regB(b) { const p=b.hr>30?600:b.hr>15?500:b.hr>5?400:300,r=Math.min(1,p/500); return {...b,avg:b.avg*r+LA.avg*(1-r),obp:b.obp*r+LA.obp*(1-r),slg:b.slg*r+LA.slg*(1-r)}; }
function regP(p) { const i=p.ip||150,r=Math.min(1,i/160); return {...p,era:p.era*r+LA.era*(1-r),whip:p.whip*r+LA.whip*(1-r),k9:p.k9*r+LA.k9*(1-r),bb9:p.bb9*r+LA.bb9*(1-r)}; }
function wOBA(b) { return (b.obp*.7+b.slg*.3)*(1+(b.spd||5)*.005); }
function FIP(p) { return ((13*(p.era>6?1.5:p.hr?p.hr/((p.ip||150)/9):1))+3*(p.bb9||3)-2*(p.k9||7))/13+3.10; }
function pyth(rs,ra) { if(rs+ra===0) return .5; return Math.pow(rs,1.83)/(Math.pow(rs,1.83)+Math.pow(ra,1.83)); }
function elo(r) { if(!r) return 1500; return 1500+(r.w/(r.w+r.l)-.5)*400; }
function fatigue(ip,ra,ha) { return _.clamp(Math.max(0,(ip-4)*.04)+ra*.03+Math.max(0,(ha-ip*1.2)*.02),0,.5); }
function shouldChange(p,ip,ra,ha,sd,isH) { const a=(p.war||0)>4?1:0,f=fatigue(ip,ra,ha); if(ip>=7+a) return true; if(ip>=1&&ra>=5) return true; if(ip>=2&&ra/ip>1.5) return true; if(f>=.20+a*.05) return true; if(ip>=6+a) return Math.random()<.3+f; if(ip>=5&&sd<=-4) return true; return false; }

class Sim {
  constructor(h,a,sid,w,hsi=0,asi=0,opts={}) {
    this.h=_.cloneDeep(h);this.a=_.cloneDeep(a);this.st=STADIUMS[sid]||STADIUMS.jamsil;this.w=WEATHER_EFFECTS[w]||WEATHER_EFFECTS.cloudy;
    this.h.lineup=this.h.lineup.map(regB);this.a.lineup=this.a.lineup.map(regB);
    this.hP=regP(this.h.starters[hsi]);this.aP=regP(this.a.starters[asi]);
    this.h.lineup.forEach(b=>{b.woba=wOBA(b)});this.a.lineup.forEach(b=>{b.woba=wOBA(b)});
    this.hP.fip=FIP(this.hP);this.aP.fip=FIP(this.aP);
    this.hElo=elo(h.record);this.aElo=elo(a.record);
    const ed=this.hElo-this.aElo;
    this.eloMod={home:1+_.clamp(ed*.0002,-.03,.03),away:1-_.clamp(ed*.0002,-.03,.03)};
    this.hDef=this.h.lineup.reduce((s,b)=>s+(b.defRAA||0),0);this.aDef=this.a.lineup.reduce((s,b)=>s+(b.defRAA||0),0);
    const di=opts.dayOfWeek??new Date().getDay(),m=[6,0,1,2,3,4,5];this.dayIdx=m[di]??0;
    this.timeMod=TIME_SLOT_MOD[getTimeSlot(opts.time)]||TIME_SLOT_MOD.night;
    this.oddsMod=getOddsMod(h.teamRating,a.teamRating);this.h2hMod=getH2HMod(h.id,a.id);
  }
  plt(b,p){const bt=b.bat||"R",pt=p.throws||"R";if(bt==="S")return 1.01;return bt!==pt?1.04:.96;}
  wB(b){const w=b.war||0;return w<=0?1:1+Math.min(.03,w*.004);}
  pW(p){const w=p.wpaLI||0;return w<=0?1:1+Math.min(.04,w*.008);}
  dF(isH){return 1-_.clamp((isH?this.hDef:this.aDef)*.001,-.03,.05);}
  prob(b,p,isH,ftg=0){
    const pf=this.st.parkFactor,wH=this.st.dome?1+(this.w.hitMod-1)*.2:this.w.hitMod,wR=this.st.dome?1+(this.w.hrMod-1)*.2:this.w.hrMod,hA=isH?HOME_ADV:1;
    const bF=_.clamp(b.recentForm||1,0.92,1.08),pl=this.plt(b,p),wb=this.wB(b),pw=this.pW(p);
    const dm=DAY_OF_WEEK_MOD[isH?"home":"away"][this.dayIdx],tH=this.timeMod.hitMod,tR=this.timeMod.hrMod;
    const oF=isH?this.oddsMod.home:this.oddsMod.away,h2=isH?this.h2hMod.home:this.h2hMod.away;
    const mu=getMatchupMod(p.name,b.name),eF=isH?this.eloMod.home:this.eloMod.away;
    const env=dm*oF*h2*mu*eF,fHB=1+ftg*.8,fKD=1-ftg*.5,fBB=1+ftg*.6;
    const fip=p.fip||FIP(p),pF=_.clamp(1+(3.80-fip)*0.12,.7,1.3)*_.clamp(p.recentForm||1,0.92,1.08)*pw*(2-this.timeMod.eraMod);
    const pK=p.k9/9*fKD,pB=p.bb9/9*fBB,dF=this.dF(!isH);
    const wb2=b.woba||wOBA(b),wf=wb2/.340;
    const so=Math.min(.35,pK*(1-b.obp/.5)*.70*(2-pl)),bb=Math.min(.18,pB*(b.obp/.34)*.23*pl),hbp=.008;
    const hit=Math.max(.05,(wf*.38*hA*wH*tH*bF*pl*wb*env*fHB/pF-bb-hbp)*.88*dF),iso=b.slg-b.avg;
    const hr=Math.min(.08,(b.hr/550)*pf*wR*tR*hA*bF*pl*wb*env*fHB/pF),t3=Math.min(.008,.003*(b.spd/5)),d2=Math.min(.08,iso*.25*pf*wH*tH*pl*dF),s1=Math.max(.05,hit-hr-t3-d2);
    const err=Math.max(.003,.015*this.w.errMod*this.dF(isH)),rem=Math.max(0,1-hit-bb-so-hbp-err);
    return{strikeout:so,walk:bb,hitByPitch:hbp,single:s1,double:d2,triple:t3,homerun:hr,groundOut:rem*.473,flyOut:rem*.368,lineOut:rem*.158,error:err};
  }
  ab(b,p,isH,ftg=0){const pr=this.prob(b,p,isH,ftg);let r=Math.random(),c=0;for(const[t,v]of Object.entries(pr)){c+=v;if(r<c)return t;}return"groundOut";}
  adv(bs,o,outs,b){let rs=0;const sp=b.spd||5;switch(o){case"homerun":rs=bs.filter(Boolean).length+1;bs[0]=bs[1]=bs[2]=null;break;case"triple":rs+=bs.filter(Boolean).length;bs[0]=bs[1]=null;bs[2]=b.name;break;case"double":if(bs[2]){rs++;bs[2]=null;}if(bs[1]){rs++;bs[1]=null;}if(bs[0]){bs[2]=bs[0];bs[0]=null;}bs[1]=b.name;break;case"single":if(bs[2]){rs++;bs[2]=null;}if(bs[1]){if(sp>=6||Math.random()>.5)bs[2]=bs[1];else rs++;bs[1]=null;}if(bs[0]){bs[1]=bs[0];bs[0]=null;}bs[0]=b.name;break;case"walk":case"hitByPitch":if(bs[0]&&bs[1]&&bs[2])rs++;if(bs[0]&&bs[1])bs[2]=bs[1];if(bs[0])bs[1]=bs[0];bs[0]=b.name;break;case"groundOut":if(bs[0]&&outs<2&&Math.random()<.4){bs[0]=null;if(bs[2]&&Math.random()<.3){rs++;bs[2]=null;}return{rs,o:2};}if(bs[2]&&outs<2&&Math.random()<.45){rs++;bs[2]=null;}if(bs[1]&&!bs[2]){bs[2]=bs[1];bs[1]=null;}return{rs,o:1};case"flyOut":if(bs[2]&&outs<2&&Math.random()<.55){rs++;bs[2]=null;}return{rs,o:1};case"error":if(bs[2]){rs++;bs[2]=null;}if(bs[1]){bs[2]=bs[1];bs[1]=null;}if(bs[0])bs[1]=bs[0];bs[0]=b.name;break;default:return{rs,o:1};}return{rs,o:0};}
  game(){const sc={home:0,away:0};let hi=0,ai=0,hP=this.hP,aP=this.aP;const ps={home:{ip:0,ra:0,ha:0,bp:false},away:{ip:0,ra:0,ha:0,bp:false}};
    for(let inn=1;inn<=12;inn++){
      if(!ps.home.bp&&inn>=2&&shouldChange(hP,ps.home.ip,ps.home.ra,ps.home.ha,sc.home-sc.away,true)){hP=this.h.bullpen;ps.home.bp=true;ps.home.ip=0;ps.home.ra=0;ps.home.ha=0;}
      if(!ps.away.bp&&inn>=2&&shouldChange(aP,ps.away.ip,ps.away.ra,ps.away.ha,sc.away-sc.home,false)){aP=this.a.bullpen;ps.away.bp=true;ps.away.ip=0;ps.away.ra=0;ps.away.ha=0;}
      const hF=ps.home.bp?0:fatigue(ps.home.ip,ps.home.ra,ps.home.ha),aF=ps.away.bp?0:fatigue(ps.away.ip,ps.away.ra,ps.away.ha);
      let outs=0,bs=[null,null,null],ir=0;while(outs<3){const b=this.a.lineup[ai%9],o=this.ab(b,hP,false,hF),r=this.adv(bs,o,outs,b);if(["single","double","triple","homerun"].includes(o))ps.home.ha++;ir+=r.rs;outs+=r.o;ai++;}sc.away+=ir;ps.home.ra+=ir;ps.home.ip++;if(!ps.home.bp&&ir>=3){hP=this.h.bullpen;ps.home.bp=true;ps.home.ip=0;ps.home.ra=0;ps.home.ha=0;}
      if(inn>=9&&sc.home>sc.away)break;
      outs=0;bs=[null,null,null];ir=0;while(outs<3){const b=this.h.lineup[hi%9],o=this.ab(b,aP,true,aF),r=this.adv(bs,o,outs,b);if(["single","double","triple","homerun"].includes(o))ps.away.ha++;ir+=r.rs;outs+=r.o;hi++;if(inn>=9&&sc.home+ir>sc.away)break;}sc.home+=ir;ps.away.ra+=ir;ps.away.ip++;if(!ps.away.bp&&ir>=3){aP=this.a.bullpen;ps.away.bp=true;ps.away.ip=0;ps.away.ra=0;ps.away.ha=0;}
      if(inn>=9&&sc.home!==sc.away)break;}
    return{home:sc.home,away:sc.away,winner:sc.home>sc.away?"home":sc.away>sc.home?"away":"draw"};}
  mc(n=1000){let hw=0,aw=0,dr=0;const hs=[],as=[];for(let i=0;i<n;i++){const r=this.game();if(r.winner==="home")hw++;else if(r.winner==="away")aw++;else dr++;hs.push(r.home);as.push(r.away);}
    return{homeWins:hw,awayWins:aw,draws:dr,homeWinPct:((hw/n)*100).toFixed(1),awayWinPct:((aw/n)*100).toFixed(1),avgHome:_.mean(hs).toFixed(1),avgAway:_.mean(as).toFixed(1)};}
  getFactors(){
    const h=this.h, a=this.a, hP=this.hP, aP=this.aP;
    const hn=h.short||h.name, an=a.short||a.name;
    // 선발투수 impact: ERA 차이 기반 (사용자 친화적)
    const eraDiff=aP.era-hP.era; // 양수=홈 투수가 더 좋음
    const spImpact=Math.min(0.15, Math.abs(eraDiff)*0.04);
    // 팀 전력 (rating + elo 통합)
    const rDiff=h.teamRating-a.teamRating;
    const ratingImpact=Math.min(0.10, Math.abs(rDiff)*0.002);
    // 모멘텀
    const hMom=h.momentum||0, aMom=a.momentum||0;
    const momDiff=hMom-aMom;
    const momImpact=Math.min(0.08, Math.abs(momDiff)*0.012);
    // H2H
    const h2hRate=H2H_RECORDS[h.id]?.[a.id]||0.5;
    const h2hImpact=Math.abs(h2hRate-0.5)*0.20;
    // 구장
    const pf=this.st.parkFactor;
    const parkImpact=Math.abs(pf-1.0)*0.10;

    // 승률 기반 전적 요약
    const hRec=h.record, aRec=a.record;
    const hPct=hRec?+(hRec.w/(hRec.w+hRec.l)).toFixed(3):0.5;
    const aPct=aRec?+(aRec.w/(aRec.w+aRec.l)).toFixed(3):0.5;

    const factors=[
      {key:"sp",label:"선발투수",edge:eraDiff>0?"home":"away",impact:spImpact,
       desc:`${eraDiff>0?hP.name:aP.name}(ERA ${+(eraDiff>0?hP.era:aP.era).toFixed(2)}) vs ${eraDiff>0?aP.name:hP.name}(${+(eraDiff>0?aP.era:hP.era).toFixed(2)})`},
      {key:"momentum",label:"최근 폼",edge:momDiff>=0?"home":"away",impact:momImpact,
       desc:`${hn} ${hRec?.last10raw||'?'} / ${an} ${aRec?.last10raw||'?'}`},
      {key:"rating",label:"팀 전력",edge:rDiff>=0?"home":"away",impact:ratingImpact,
       desc:`${hn} ${hRec?`${hRec.w}승${hRec.l}패`:'?'} vs ${an} ${aRec?`${aRec.w}승${aRec.l}패`:'?'}`},
      {key:"h2h",label:"상대전적",edge:h2hRate>=0.5?"home":"away",impact:h2hImpact,
       desc:`${hn} 홈 승률 ${(h2hRate*100).toFixed(0)}%`},
      {key:"park",label:"구장 효과",edge:pf>=1?"home":"away",impact:parkImpact,
       desc:pf>=1.05?`${this.st.name||''} 타자 유리(${pf})`:pf<=0.95?`${this.st.name||''} 투수 유리(${pf})`:`${this.st.name||''} 중립(${pf})`},
    ];
    factors.sort((a,b)=>b.impact-a.impact);
    return {
      homeRating:h.teamRating, awayRating:a.teamRating,
      homeSP:{name:hP.name,era:hP.era,fip:+hP.fip.toFixed(2),recentForm:+(hP.recentForm||1).toFixed(2)},
      awaySP:{name:aP.name,era:aP.era,fip:+aP.fip.toFixed(2),recentForm:+(aP.recentForm||1).toFixed(2)},
      homeRecord:`${hRec?.w||0}승${hRec?.l||0}패`, awayRecord:`${aRec?.w||0}승${aRec?.l||0}패`,
      h2hWinRate:+(h2hRate*100).toFixed(0),
      parkFactor:pf, parkName:this.st.name||'',
      homeMomentum:hMom, awayMomentum:aMom,
      topFactors:factors.slice(0,4).map(f=>({...f,impact:+f.impact.toFixed(3)})),
    };
  }
}

// ── 한 줄 해설 생성 (룰 기반 템플릿) ──
function generateNarrative(factors, predWinner, predLoser, conf, winnerSide) {
  // winnerSide: "home" or "away"
  const top = factors.topFactors;
  if (!top || top.length === 0) return `${predWinner} 소폭 우세 예측.`;

  const parts = [];
  const pros = top.filter(f => f.edge === winnerSide);   // predWinner에게 유리한 요인
  const cons = top.filter(f => f.edge !== winnerSide);    // 불리한 요인

  // 1차: 가장 큰 유리 요인
  const f1 = pros[0];
  if (f1) {
    if (f1.key === 'sp') {
      const sp = winnerSide === 'home' ? factors.homeSP : factors.awaySP;
      const opp = winnerSide === 'home' ? factors.awaySP : factors.homeSP;
      const se = +sp.era.toFixed(2), oe = +opp.era.toFixed(2);
      if (Math.abs(se - oe) >= 1.5)
        parts.push(`${sp.name}(ERA ${se})이 ${opp.name}(${oe}) 대비 압도적 우위`);
      else
        parts.push(`${sp.name}(ERA ${se}) vs ${opp.name}(${oe}), 선발 대결에서 ${predWinner} 우위`);
    } else if (f1.key === 'momentum') {
      parts.push(`${predWinner}의 최근 상승세가 핵심 (${f1.desc})`);
    } else if (f1.key === 'rating') {
      parts.push(`${predWinner}의 종합 전력 우세 (${f1.desc})`);
    } else if (f1.key === 'h2h') {
      parts.push(`${predWinner}의 상대전적 우위 (${f1.desc})`);
    } else if (f1.key === 'park') {
      parts.push(`${factors.parkName} 홈 구장 효과가 ${predWinner}에게 유리`);
    } else {
      parts.push(`${predWinner}의 종합 요인이 우세`);
    }
  }

  // 2차: 추가 유리 요인 (impact 2.5% 이상)
  if (pros.length >= 2 && pros[1].impact >= 0.025) {
    const f2 = pros[1];
    if (f2.key === 'momentum') parts.push(`최근 폼도 ${predWinner}이 우세`);
    else if (f2.key === 'sp') {
      const sp = winnerSide === 'home' ? factors.homeSP : factors.awaySP;
      parts.push(`선발 ${sp.name}(ERA ${+sp.era.toFixed(2)})도 유리`);
    }
    else if (f2.key === 'rating') parts.push(`팀 전력에서도 앞섬`);
    else if (f2.key === 'h2h') parts.push(`상대전적도 유리`);
    else parts.push(`${f2.label}도 유리`);
  }

  // 유리 요인 없이 MC에서 이긴 경우 (모든 factor가 상대에게 유리)
  if (!f1) {
    if (winnerSide === 'home')
      parts.push(`${predWinner}은 개별 지표에서 열세이나 홈 어드밴티지 + 구장 효과로 우세`);
    else
      parts.push(`${predWinner}의 종합 시뮬레이션에서 소폭 우세`);
  }

  // 불리 요인 (가장 큰 것 1개)
  if (cons.length > 0 && cons[0].impact >= 0.04) {
    const c = cons[0];
    if (c.key === 'momentum') parts.push(`다만 ${predLoser}의 최근 폼이 좋아 주의 필요`);
    else if (c.key === 'sp') parts.push(`다만 ${predLoser} 선발투수가 우위`);
    else if (c.key === 'rating') parts.push(`다만 ${predLoser}의 시즌 성적이 앞섬`);
  }

  // 신뢰도 수식어
  if (conf === '★★★') parts.push('높은 확률 예측');
  else if (conf === '★') parts.push('박빙으로 이변 가능');

  return parts.join('. ') + '.';
}

const NM={"삼성":"samsung","기아":"kia","KIA":"kia","LG":"lg","두산":"doosan","KT":"kt","SSG":"ssg","한화":"hanwha","롯데":"lotte","NC":"nc","키움":"kiwoom"};
const ST={잠실:"jamsil",문학:"incheon",수원:"suwon",대구:"daegu",광주:"gwangju",대전:"daejeon",사직:"sajik",창원:"changwon",고척:"gocheok",인천:"incheon",부산:"sajik"};
function findSP(team,name){if(!name)return 0;const i=team.starters.findIndex(s=>s.name===name||name.includes(s.name)||s.name.includes(name));return i>=0?i:0;}

// ── CLI 옵션 파싱 (v9.2~9.5) ──
// 사용법: node sim-today.mjs [scheduleFile] [--log] [--quiet] [--version vX.Y]
//         [--temp 0.6]              v9.5 출력 확률 압축 (0.5 쪽으로 모음)
//         [--threshold "55,60"]     v9.5 ★/★★/★★★ 경계 (기본 55,60)
const argv = process.argv.slice(2);
const LOG_MODE = argv.includes('--log');
const QUIET = argv.includes('--quiet');
let VERSION_TAG = 'v9.6';
const vIdx = argv.indexOf('--version');
if (vIdx >= 0 && argv[vIdx + 1]) VERSION_TAG = argv[vIdx + 1];

// v9.5: temperature 압축
let TEMPERATURE = 0.7;
const tIdx = argv.indexOf('--temp');
if (tIdx >= 0 && argv[tIdx + 1]) TEMPERATURE = parseFloat(argv[tIdx + 1]);

// v9.7: 홈 어드밴티지 배수 (타격 확률 보정. 2026 실측 홈승률 51.3% 대비
// 기존 1.025는 홈픽 73%/평균 홈승률 56.4%로 과대 → 축소 조정 가능)
let HOME_ADV = 1.025;
const haIdx = argv.indexOf('--home-adv');
if (haIdx >= 0 && argv[haIdx + 1]) HOME_ADV = parseFloat(argv[haIdx + 1]);

// v9.5: 신뢰도 임계값
let THRESH_2 = 55, THRESH_3 = 65;
const thIdx = argv.indexOf('--threshold');
if (thIdx >= 0 && argv[thIdx + 1]) {
  const parts = argv[thIdx + 1].split(',').map(Number);
  if (parts.length >= 2) { THRESH_2 = parts[0]; THRESH_3 = parts[1]; }
}

// 옵션 인자값(--version v9.2-mom 등)은 positional에서 제외
const flagsWithValue = new Set(['--version', '--temp', '--threshold', '--home-adv']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !flagsWithValue.has(argv[i-1]));

// ── 일정/선발 자동 로드 (schedule-today.json) ──
const schedFile = positional[0] || 'schedule-today.json';
if (!fs.existsSync(schedFile)) {
  console.error(`❌ ${schedFile} 없음. 'node crawl-schedule.mjs [YYYY-MM-DD]' 먼저 실행`);
  process.exit(1);
}
const schedData = JSON.parse(fs.readFileSync(schedFile, 'utf8'));
const TARGET_DATE = schedData.date;
const games = schedData.games.map(g => ({
  away: g.away, home: g.home,
  stadium: g.stadium,
  awaySP: g.awaySP || '',
  homeSP: g.homeSP || '',
  time: g.time || '18:30',
}));
if (games.length === 0) {
  console.log(`📭 ${TARGET_DATE}: 경기 없음`);
  process.exit(0);
}

const N = 1000;
const VERSION = VERSION_TAG;
const log = (...a) => { if (!QUIET) console.log(...a); };

log('='.repeat(70));
log(`  ${TARGET_DATE} 경기 예측 (${N}회 시뮬레이션, ${VERSION})`);
log(`  ⚙️  temp=${TEMPERATURE}, threshold=${THRESH_2}/${THRESH_3}`);
log('='.repeat(70));

const predictionEntries = [];
for (const g of games) {
  const awayId = NM[g.away], homeId = NM[g.home];
  const away = KBO_TEAMS[awayId], home = KBO_TEAMS[homeId];
  const asi = findSP(away, g.awaySP), hsi = findSP(home, g.homeSP);
  const awaySPData = away.starters[asi];
  const homeSPData = home.starters[hsi];

  // 요일 자동 계산 (TARGET_DATE 기준)
  const dow = new Date(TARGET_DATE + 'T00:00:00').getDay();
  const sim = new Sim(home, away, ST[g.stadium], 'cloudy', hsi, asi, { dayOfWeek: dow, time: g.time });
  const mc = sim.mc(N);

  let homePct = parseFloat(mc.homeWinPct);
  let awayPct = parseFloat(mc.awayWinPct);

  // v9.5: temperature 압축 — 출력 확률을 0.5 쪽으로 모음 (calibration 보정)
  if (TEMPERATURE !== 1.0) {
    const compress = (p) => 50 + (p - 50) * TEMPERATURE;
    const total = homePct + awayPct;
    homePct = +compress(homePct).toFixed(1);
    awayPct = +compress(awayPct).toFixed(1);
    // 정규화 (draw 등 합 ≠ 100인 경우 비율 유지)
    const newTotal = homePct + awayPct;
    if (newTotal > 0 && total > 0) {
      const scale = total / newTotal;
      homePct = +(homePct * scale).toFixed(1);
      awayPct = +(awayPct * scale).toFixed(1);
    }
  }

  const predWinner = homePct >= awayPct ? g.home : g.away;
  const predPct = (homePct >= awayPct ? homePct : awayPct).toFixed(1);
  const pf = parseFloat(predPct);
  const conf = pf >= THRESH_3 ? '★★★' : pf >= THRESH_2 ? '★★' : '★';

  // factor 수집 + 해설 생성
  const factors = sim.getFactors();
  const predLoser = predWinner === g.home ? g.away : g.home;
  const winnerSide = predWinner === g.home ? 'home' : 'away';
  factors.narrative = generateNarrative(factors, predWinner, predLoser, conf, winnerSide);

  log(`\n${g.away} @ ${g.home} (${g.stadium} ${g.time})`);
  log(`  선발: ${g.awaySP}(${awaySPData.name}, ERA:${awaySPData.era}) vs ${g.homeSP}(${homeSPData.name}, ERA:${homeSPData.era})`);
  log(`  시뮬: ${g.away} ${awayPct}% - ${homePct}% ${g.home} | 평균: ${mc.avgAway} - ${mc.avgHome}${TEMPERATURE !== 1.0 ? ` (temp=${TEMPERATURE})` : ''}`);
  log(`  ▶ 예측: ${predWinner} 승 (${predPct}%) ${conf}`);
  log(`  💬 ${factors.narrative}`);

  predictionEntries.push({
    away: g.away, home: g.home,
    stadium: g.stadium, time: g.time,
    awaySP: g.awaySP, homeSP: g.homeSP,
    predWinner,
    predHomePct: homePct,
    predAwayPct: awayPct,
    avgHome: parseFloat(mc.avgHome),
    avgAway: parseFloat(mc.avgAway),
    confidence: conf,
    factors,
    actualHome: null,
    actualAway: null,
    hit: null,
  });
}

// ── prediction-log.json append (--log 옵션) ──
if (LOG_MODE) {
  const LOG_FILE = 'prediction-log.json';
  let logData = { predictions: [] };
  if (fs.existsSync(LOG_FILE)) {
    logData = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  }
  // 같은 날짜 + 같은 버전이 이미 있으면 교체
  logData.predictions = logData.predictions.filter(
    p => !(p.date === TARGET_DATE && p.version === VERSION)
  );
  logData.predictions.push({
    date: TARGET_DATE,
    predictedAt: new Date().toISOString(),
    version: VERSION,
    games: predictionEntries,
  });
  // 날짜순 정렬
  logData.predictions.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(LOG_FILE, JSON.stringify(logData, null, 2));
  log(`\n📝 prediction-log.json append: ${TARGET_DATE} (${predictionEntries.length}경기)`);
}

console.log('\n' + '='.repeat(70));
console.log('  ★ 50~55% | ★★ 55~60% | ★★★ 60%+');
console.log('='.repeat(70));
