#!/usr/bin/env node
/* template.html + data.json + insight.md -> index.html
   사용: node build/build.js [저장소 루트]  (기본: 스크립트의 상위 폴더) */
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// **굵게** 와 빈 줄 단락만 지원하는 최소 변환기
const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

/** insight.md 를 [{d,t,h}] 로. 형식:
 *   ## 2026-11-23
 *   ### 제목 한 줄
 *   본문 단락
 *
 *   또 한 단락
 */
function parseInsights(md) {
  const out = [];
  for (const chunk of md.split(/^## /m).slice(1)) {
    const lines = chunk.split('\n');
    const d = lines.shift().trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`insight.md: 날짜 형식이 아닙니다 -> "${d}"`);
    let t = '';
    const body = [];
    for (const ln of lines) {
      if (!t && ln.startsWith('### ')) { t = ln.slice(4).trim(); continue; }
      body.push(ln);
    }
    if (!t) throw new Error(`insight.md: ${d} 항목에 "### 제목" 줄이 없습니다`);
    const h = body.join('\n').trim().split(/\n\s*\n/)
      .map(p => p.trim()).filter(Boolean)
      .map(p => `<p>${inline(p.replace(/\n/g, ' '))}</p>`).join('');
    out.push({ d, t, h });
  }
  out.sort((a, b) => a.d < b.d ? 1 : a.d > b.d ? -1 : 0); // 최신이 먼저
  return out;
}

const tpl = read('build/template.html');
const data = read('data.json').trim();
const insights = fs.existsSync(path.join(root, 'insight.md'))
  ? parseInsights(read('insight.md')) : [];

JSON.parse(data); // 깨진 JSON이면 여기서 멈춘다

if ((tpl.match(/\/\*DATA\*\/null/g) || []).length !== 1) throw new Error('template.html: /*DATA*/null 자리가 정확히 하나여야 합니다');
if ((tpl.match(/\/\*INSIGHT\*\/\[\]/g) || []).length !== 1) throw new Error('template.html: /*INSIGHT*/[] 자리가 정확히 하나여야 합니다');

const html = tpl
  .replace('/*DATA*/null', data)
  .replace('/*INSIGHT*/[]', JSON.stringify(insights));

// 문법 검사
const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
new (require('vm').Script)(js, { filename: 'page.js' });

fs.writeFileSync(path.join(root, 'index.html'), html);

const d = JSON.parse(data);
const last = new Date(Date.UTC(2026, 0, 1) + (d.mkt.length - 1) * 864e5).toISOString().slice(0, 10);
console.log(`index.html 생성 — 마지막 날짜 ${last}, 영화 ${d.films.length}편, 읽기 ${insights.length}개, ${html.length.toLocaleString()}바이트`);
