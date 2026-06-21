// 新氧高频数据 —— 浏览器内数据处理管线(JS版, 与Python口径逐行对齐)
// 口径: 业务发生日(次日累计-当日累计) / 当天最早快照 / 4×MA异常剔除 / price>0 / 自然周一~周日 / 同id改名归并
(function (global) {
  'use strict';
  const THRESH = 4.0, WINDOW = 30, MINP = 5;

  function parseCSV(text) {
    text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rows = []; let i = 0, field = '', row = [], inQ = false;
    while (i < text.length) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    const header = rows.shift().map(h => h.trim().replace(/^﻿/, ''));
    return rows.filter(r => r.length > 1).map(r => {
      const o = {}; header.forEach((h, j) => o[h] = (r[j] === undefined ? '' : r[j])); return o;
    });
  }

  const day = ts => ts.slice(0, 10);
  function weekStart(d) { // d='YYYY-MM-DD' -> 周一
    const dt = new Date(d + 'T00:00:00');
    const wd = (dt.getDay() + 6) % 7;
    dt.setDate(dt.getDate() - wd);
    return dt.toISOString().slice(0, 10);
  }

  function process(receptText, prodText) {
    // ---------------- 接诊 ----------------
    const rec = parseCSV(receptText);
    const latestName = new Map(), latestCity = new Map(), latestTs = new Map();
    for (const r of rec) {
      const id = r.shop_id, t = r.date;
      if (!latestTs.has(id) || t > latestTs.get(id)) { latestTs.set(id, t); latestName.set(id, r.shop_name); latestCity.set(id, r.city); }
    }
    // 当天最早快照 per (shop_id, day)
    const earliest = new Map(); // key id|day -> {ts, cum}
    for (const r of rec) {
      const d = day(r.date), k = r.shop_id + '|' + d, cum = +r.service_times;
      if (!Number.isFinite(cum)) continue;
      const cur = earliest.get(k);
      if (!cur || r.date < cur.ts) earliest.set(k, { id: r.shop_id, d, ts: r.date, cum });
    }
    // 按 shop_id 收集 (day,cum) 排序，求 delta 归属业务日
    const byShop = new Map();
    for (const v of earliest.values()) { if (!byShop.has(v.id)) byShop.set(v.id, []); byShop.get(v.id).push(v); }
    const recvRec = []; // {id, name, city, day, recv}
    for (const [id, arr] of byShop) {
      arr.sort((a, b) => a.d < b.d ? -1 : 1);
      // 剔除老店中途的脏0：接诊累计单调不减，已出现正值后再出现0=详情接口抖动返回脏值
      // (如 2026-06-19 广州ICC),会造成 delta=次日-0 的巨型假尖峰。保留新店开业前的合法0。
      let seenPos = false; const clean = [];
      for (const x of arr) { if (x.cum === 0 && seenPos) continue; if (x.cum > 0) seenPos = true; clean.push(x); }
      for (let j = 0; j < clean.length - 1; j++) {
        const delta = clean[j + 1].cum - clean[j].cum;
        if (delta < 0) continue;
        recvRec.push({ id, name: latestName.get(id), city: latestCity.get(id), day: clean[j].d, recv: delta });
      }
    }
    // 全国按业务日加总, 去开头退化0日
    const natRecvMap = new Map();
    for (const r of recvRec) natRecvMap.set(r.day, (natRecvMap.get(r.day) || 0) + r.recv);
    const recvDaysAll = [...natRecvMap.keys()].sort();
    let fv = null; for (const d of recvDaysAll) { if (natRecvMap.get(d) > 0) { fv = d; break; } }
    const recvRecF = recvRec.filter(r => r.day >= fv);

    // ---------------- 产品 ----------------
    const prd = parseCSV(prodText).filter(r => /^\d+$/.test(String(r.spu_id).trim()));
    const pName = new Map(), pTs = new Map();
    for (const r of prd) { const id = r.spu_id, t = r.date; if (!pTs.has(id) || t > pTs.get(id)) { pTs.set(id, t); pName.set(id, r.product_name); } }
    const pEarliest = new Map();
    for (const r of prd) {
      const d = day(r.date), k = r.spu_id + '|' + d, cum = +r.total_sold, price = +r.price;
      if (!Number.isFinite(cum)) continue;
      const cur = pEarliest.get(k);
      if (!cur || r.date < cur.ts) pEarliest.set(k, { id: r.spu_id, d, ts: r.date, cum, price });
    }
    const bySpu = new Map();
    for (const v of pEarliest.values()) { if (!bySpu.has(v.id)) bySpu.set(v.id, []); bySpu.get(v.id).push(v); }
    const valRec = []; // {spu, day, vol, price, rev}
    for (const [id, arr] of bySpu) {
      arr.sort((a, b) => a.d < b.d ? -1 : 1);
      for (let j = 0; j < arr.length - 1; j++) {
        let vol = arr[j + 1].cum - arr[j].cum;
        if (vol < 0) continue;
        const price = arr[j].price;
        if (!(price > 0)) continue;
        valRec.push({ spu: id, day: arr[j].d, vol, price, rev: vol * price });
      }
    }
    // 每日全国GMV/销量 (含开头, 供MA), 排序
    const dRev = new Map(), dVol = new Map();
    for (const r of valRec) { dRev.set(r.day, (dRev.get(r.day) || 0) + r.rev); dVol.set(r.day, (dVol.get(r.day) || 0) + r.vol); }
    const prodDaysAll = [...dRev.keys()].sort();
    const revArr = prodDaysAll.map(d => dRev.get(d)), volArr = prodDaysAll.map(d => dVol.get(d));
    // MA: shift(1).rolling(30,min5)
    const MArev = [], MAvol = [], out = [], revC = [], volC = [], asp = [];
    for (let k = 0; k < prodDaysAll.length; k++) {
      const lo = Math.max(0, k - WINDOW), seg = revArr.slice(lo, k), segv = volArr.slice(lo, k);
      let mr = NaN, mv = NaN;
      if (seg.length >= MINP) { mr = seg.reduce((a, b) => a + b, 0) / seg.length; mv = segv.reduce((a, b) => a + b, 0) / segv.length; }
      MArev.push(mr); MAvol.push(mv);
      const isout = Number.isFinite(mr) && revArr[k] > THRESH * mr;
      out.push(isout);
      revC.push(isout ? mr : revArr[k]); volC.push(isout ? mv : volArr[k]);
      asp.push(volC[k] ? revC[k] / volC[k] : NaN);
    }
    const aspMap = new Map(); prodDaysAll.forEach((d, k) => aspMap.set(d, asp[k]));
    // 展示口径: 去开头退化日(<fv), 重映射异常索引
    const keepIdx = prodDaysAll.map((d, k) => d >= fv ? k : -1).filter(k => k >= 0);
    const prodDates = keepIdx.map(k => prodDaysAll[k]);
    const gmv = keepIdx.map(k => Math.round(revC[k]));
    const gmvRaw = keepIdx.map(k => Math.round(revArr[k]));
    const aspOut = keepIdx.map(k => Math.round(asp[k] * 10) / 10);
    const volOut = keepIdx.map(k => Math.round(volC[k]));
    const outlierIdx = []; keepIdx.forEach((k, pos) => { if (out[k]) outlierIdx.push(pos); });

    // 门店日销售额估算 = recv × 当日ASP
    for (const r of recvRecF) { r.asp = aspMap.get(r.day); r.shopRev = (r.asp != null && Number.isFinite(r.asp)) ? r.recv * r.asp : null; }

    // ---------- 概览 ----------
    const recvDates = recvDaysAll.filter(d => d >= fv);
    const recvByDay = new Map(); for (const r of recvRecF) recvByDay.set(r.day, (recvByDay.get(r.day) || 0) + r.recv);
    const recv = recvDates.map(d => Math.round(recvByDay.get(d) || 0));

    // ---------- 产品汇总 + 每日 ----------
    const psum = new Map();
    for (const r of valRec) { const s = psum.get(r.spu) || { vol: 0, rev: 0 }; s.vol += r.vol; s.rev += r.rev; psum.set(r.spu, s); }
    const products = [...psum.entries()].filter(([, s]) => s.vol > 0)
      .map(([id, s]) => ({ id: +id, name: pName.get(id), vol: Math.round(s.vol), rev: Math.round(s.rev), price: Math.round(s.rev / s.vol) }))
      .sort((a, b) => b.rev - a.rev);
    const didx = new Map(); prodDates.forEach((d, k) => didx.set(d, k));
    const prodDaily = {};
    for (const r of valRec) {
      if (!didx.has(r.day)) continue;
      const id = +r.spu; if (!prodDaily[id]) prodDaily[id] = { v: new Array(prodDates.length).fill(0), r: new Array(prodDates.length).fill(0) };
      const k = didx.get(r.day); prodDaily[id].v[k] = Math.round(r.vol); prodDaily[id].r[k] = Math.round(r.rev);
    }

    // ---------- 城市 ----------
    const cidx = new Map(); recvDates.forEach((d, k) => cidx.set(d, k));
    const cityAgg = new Map(); // city -> {recv,rev,shops:Set, dRecv:[], dRev:[]}
    for (const r of recvRecF) {
      let a = cityAgg.get(r.city); if (!a) { a = { recv: 0, rev: 0, shops: new Set(), dRecv: new Array(recvDates.length).fill(0), dRev: new Array(recvDates.length).fill(0) }; cityAgg.set(r.city, a); }
      a.recv += r.recv; a.shops.add(r.name);
      const k = cidx.get(r.day); if (k != null) { a.dRecv[k] += r.recv; if (r.shopRev) { a.dRev[k] += r.shopRev; a.rev += r.shopRev; } }
    }
    const cities = [...cityAgg.entries()].map(([c, a]) => ({ city: c, recv: Math.round(a.recv), rev: Math.round(a.rev), n_shop: a.shops.size })).sort((x, y) => y.rev - x.rev);
    const cityDaily = {}; for (const [c, a] of cityAgg) cityDaily[c] = { recv: a.dRecv.map(Math.round), rev: a.dRev.map(Math.round) };

    // ---------- 门店 ----------
    const shopAgg = new Map();
    for (const r of recvRecF) {
      let a = shopAgg.get(r.name); if (!a) { a = { city: r.city, recv: 0, rev: 0, dRecv: new Array(recvDates.length).fill(0), dRev: new Array(recvDates.length).fill(0) }; shopAgg.set(r.name, a); }
      a.recv += r.recv;
      const k = cidx.get(r.day); if (k != null) { a.dRecv[k] += r.recv; if (r.shopRev) { a.dRev[k] += r.shopRev; a.rev += r.shopRev; } }
    }
    const shops = [...shopAgg.entries()].map(([s, a]) => ({ shop: s, city: a.city, recv: Math.round(a.recv), rev: Math.round(a.rev) })).sort((x, y) => y.rev - x.rev);
    const shopDaily = {}; for (const [s, a] of shopAgg) shopDaily[s] = { recv: a.dRecv.map(Math.round), rev: a.dRev.map(Math.round) };

    // ---------- KPI ----------
    const sum = a => a.reduce((x, y) => x + y, 0);
    const totGmv = Math.round(sum(keepIdx.map(k => revC[k])));
    const totRecv = Math.round(sum(recvRecF.map(r => r.recv)));
    const aspVals = keepIdx.map(k => asp[k]).filter(x => Number.isFinite(x));
    let pkG = -1, pkGd = '', pkR = -1, pkRd = '';
    gmv.forEach((v, k) => { if (v > pkG) { pkG = v; pkGd = prodDates[k]; } });
    recv.forEach((v, k) => { if (v > pkR) { pkR = v; pkRd = recvDates[k]; } });
    const kpi = {
      total_gmv: totGmv, total_recv: totRecv, avg_asp: Math.round(sum(aspVals) / aspVals.length),
      n_city: cities.length, n_shop: shops.length, n_spu: products.length,
      date_min: prodDates[0], date_max: prodDates[prodDates.length - 1],
      peak_gmv: pkG, peak_gmv_day: pkGd, peak_recv: pkR, peak_recv_day: pkRd
    };

    return {
      kpi,
      overview: { prod_dates: prodDates, gmv, gmv_raw: gmvRaw, asp: aspOut, vol: volOut, outlier_idx: outlierIdx, recept_dates: recvDates, recv },
      products, prod_daily: prodDaily, cities, city_daily: cityDaily, shops, shop_daily: shopDaily,
      _weekStart: weekStart
    };
  }

  const api = { parseCSV, process, weekStart };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SoYoungPipeline = api;
})(typeof window !== 'undefined' ? window : globalThis);
