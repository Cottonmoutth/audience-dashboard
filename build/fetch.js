#!/usr/bin/env node
/* KOBIS 일별 박스오피스 수집 -> data.json
   오픈API가 아니라 조회 화면을 읽는다. 오픈API는 하루 10위까지만 주는데
   시장 전체 합계를 내려면 그날 순위에 오른 영화 전부가 필요하기 때문이다.
   매번 1/1부터 전부 다시 받는다. 쉬어간 날이 저절로 메워지고 보정값도 반영된다.
   사용: node build/fetch.js [종료일 YYYY-MM-DD]   (기본: 어제 KST) */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 'https://www.kobis.or.kr';
const PAGE = '/kobis/business/stat/boxs/findDailyBoxOfficeList.do';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const YEAR_START = '2026-01-01';
const MIN_ROWS = 30;      // 이보다 적으면 그날은 미집계로 본다
const MIN_AUDIENCE = 100000;
const WORKERS = 4;

const day = ms => new Date(ms).toISOString().slice(0, 10);
const parse = s => Date.parse(s + 'T00:00:00Z');
const range = (a, b) => { const o = []; for (let t = parse(a); t <= parse(b); t += 864e5) o.push(day(t)); return o; };
const kstYesterday = () => day(Date.now() + 9 * 3600e3 - 864e5);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const text = h => h
  .replace(/<[^>]*>/g, '')
  .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, e) => ENT[e])
  .replace(/\s+/g, ' ')
  .trim();

/** 응답 HTML -> [[제목, 개봉일, 관객수, 누적관객, 스크린], ...] (12칸짜리 행만) */
function parseRows(html) {
  const rows = [];
  for (const tr of html.split(/<tr[\s>]/i).slice(1)) {
    const body = tr.split(/<\/tr>/i)[0];
    const cells = [];
    for (const m of body.matchAll(/<t([dh])(?:\s[^>]*)?>([\s\S]*?)<\/t\1>/gi)) cells.push(text(m[2]));
    if (cells.length !== 12) continue;
    const title = cells[1].replace(/\s*(동일|New|신규|\d+\s*(상승|하락))$/, '').trim();
    const open = cells[2].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(open)) continue;
    const num = i => Number(String(cells[i]).replace(/[^0-9-]/g, '')) || 0;
    rows.push([title, open, num(7), num(10), num(11)]);
  }
  return rows;
}

async function openSession() {
  const res = await fetch(BASE + PAGE, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`조회 화면을 열 수 없습니다 (HTTP ${res.status})`);
  const html = await res.text();
  const cookie = (res.headers.getSetCookie?.() || [])
    .map(c => c.split(';')[0]).join('; ');
  const m = html.match(/name=["']CSRFToken["'][^>]*value=["']([^"']+)["']/i)
    || html.match(/value=["']([^"']+)["'][^>]*name=["']CSRFToken["']/i);
  if (!m) throw new Error('CSRFToken을 찾지 못했습니다. 화면 구조가 바뀐 것 같습니다.');
  return { cookie, token: m[1] };
}

async function fetchDay(s, d) {
  const body = new URLSearchParams({
    CSRFToken: s.token, loadEnd: '0', searchType: 'search',
    sSearchFrom: d, sSearchTo: d, sMultiMovieYn: '', sRepNationCd: '', sWideAreaCd: ''
  });
  const res = await fetch(BASE + PAGE, {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': BASE + PAGE, ...(s.cookie ? { Cookie: s.cookie } : {})
    },
    body
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseRows(await res.text());
}

async function collect(s, days, label) {
  const out = {};
  const failed = [];
  let i = 0, done = 0;
  const worker = async () => {
    while (i < days.length) {
      const d = days[i++];
      let ok = false;
      for (let t = 0; t < 3 && !ok; t++) {
        try { out[d] = await fetchDay(s, d); ok = true; }
        catch (e) { await sleep(400 * (t + 1)); }
      }
      if (!ok) failed.push(d);
      if (++done % 50 === 0) console.log(`  ${label} ${done}/${days.length}`);
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  if (failed.length) throw new Error(`${label}: ${failed.length}일 수집 실패 (${failed.slice(0, 5).join(', ')}…)`);
  return out;
}

(async () => {
  let end = process.argv[2] || kstYesterday();
  console.log(`수집 ${YEAR_START} ~ ${end}`);

  const s = await openSession();
  const Y = await collect(s, range(YEAR_START, end), '올해');

  // 마지막 날이 아직 집계 전이면 하루 뒤로 물린다
  while (end > YEAR_START && (Y[end] || []).length < MIN_ROWS) {
    console.log(`  ${end} 행 ${(Y[end] || []).length}개 — 미집계로 보고 하루 앞당깁니다`);
    delete Y[end];
    end = day(parse(end) - 864e5);
  }
  const thin = Object.entries(Y).filter(([, r]) => r.length < MIN_ROWS).map(([d]) => d);
  if (thin.length) throw new Error(`중간에 행이 모자란 날이 있습니다: ${thin.slice(0, 5).join(', ')}`);

  // 지난해 개봉작: 올해 관객 10만 이상이고 2025-01-01 이후 개봉인 작품의 지난해 구간
  const tally = {};
  for (const rows of Object.values(Y)) {
    for (const [n, op, a] of rows) {
      const k = n + '|' + op;
      (tally[k] ??= { open: op, t: 0 }).t += a;
    }
  }
  const carry = Object.values(tally).filter(f =>
    f.open < YEAR_START && f.open >= '2025-01-01' && f.t >= MIN_AUDIENCE);
  let Z = {};
  if (carry.length) {
    const start = carry.map(f => f.open).sort()[0];
    console.log(`지난해 개봉작 ${carry.length}편 — ${start} ~ 2025-12-31 추가 수집`);
    Z = await collect(s, range(start, '2025-12-31'), '지난해');
  }

  // 집계
  const films = {}, mkt = [];
  for (const d of Object.keys(Y).sort()) {
    let t = 0;
    for (const [n, op, a] of Y[d]) {
      t += a;
      const k = n + '|' + op;
      (films[k] ??= { n, open: op, rows: {}, y26: 0 });
      films[k].rows[d] = a;
      films[k].y26 += a;
    }
    mkt.push(t);
  }
  for (const d of Object.keys(Z)) {
    for (const [n, op, a] of Z[d]) {
      const k = n + '|' + op;
      if (films[k] && films[k].open < YEAR_START) films[k].rows[d] = a;
    }
  }

  const out = [];
  for (const k of Object.keys(films)) {
    const f = films[k];
    if (f.y26 < MIN_AUDIENCE || f.open < '2025-01-01') continue;
    let pre = 0; const a = [];
    for (const [d, v] of Object.entries(f.rows)) {
      const i = (parse(d) - parse(f.open)) / 864e5;
      if (i < 0) pre += v; else a[i] = v;
    }
    for (let i = 0; i < a.length; i++) if (a[i] == null) a[i] = 0;
    const o = { n: f.n, open: f.open, pre, a };
    if (f.open < YEAR_START) o.y26 = f.y26;
    out.push(o);
  }
  out.sort((x, y) => x.open < y.open ? -1 : x.open > y.open ? 1 : 0);

  // 검증 — 하나라도 어긋나면 쓰지 않는다
  const expect = range(YEAR_START, end).length;
  if (mkt.length !== expect) throw new Error(`mkt 길이 ${mkt.length}, 기대 ${expect}`);
  if (out.length < 60) throw new Error(`영화 ${out.length}편 — 너무 적습니다`);
  if (!out.some(f => f.open < YEAR_START)) throw new Error('지난해 개봉작이 하나도 없습니다');
  if (mkt.some(v => v <= 0)) throw new Error('관객수가 0인 날이 있습니다');
  const dirty = out.find(f => /[<>"]|class=/.test(f.n));
  if (dirty) throw new Error(`영화 이름에 HTML이 섞였습니다 (${dirty.n.slice(0, 40)}) — 파서를 확인하세요`);
  const ranky = out.find(f => / (동일|New|신규|\d+\s*(상승|하락))$/.test(f.n));
  if (ranky) throw new Error(`영화 이름에 순위 변동이 붙었습니다 (${ranky.n.slice(0, 40)}) — 파서를 확인하세요`);

  const prevPath = path.join(ROOT, 'data.json');
  if (fs.existsSync(prevPath)) {
    const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
    if (mkt.length < prev.mkt.length) throw new Error(`날짜가 줄었습니다 (${prev.mkt.length} -> ${mkt.length})`);
    // 지난 수집과 과거 날짜가 크게 달라지면 파싱이 잘못된 것이다 (마지막 3일은 보정될 수 있어 제외)
    let drift = 0;
    for (let i = 0; i < Math.min(prev.mkt.length, mkt.length) - 3; i++) {
      if (prev.mkt[i] > 0 && Math.abs(mkt[i] - prev.mkt[i]) / prev.mkt[i] > 0.05) drift++;
    }
    if (drift > 3) throw new Error(`과거 ${drift}일의 값이 5% 넘게 달라졌습니다 — 수집이 잘못된 것 같습니다`);
    if (out.length > prev.films.length + 15) throw new Error(`영화가 갑자기 ${prev.films.length} -> ${out.length}편으로 늘었습니다`);
  }

  fs.writeFileSync(prevPath, JSON.stringify({ films: out, mktStart: YEAR_START, mkt }));
  const total = mkt.reduce((a, b) => a + b, 0);
  console.log(`data.json 저장 — ${end}까지 ${mkt.length}일, 영화 ${out.length}편, 누적 ${(total / 1e4).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}만`);
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
