/* 衡阳 · 建行 vs 农行 网点卫星图鉴 —— 可逐帧寻址的渲染脚本
 *
 * 页面加载后暴露 window.renderAt(t)，t 为秒。所有动画都由 t 决定，
 * 因此可以用无头浏览器逐帧截图，再合成视频。
 */
(async function () {
  const $ = (s) => document.querySelector(s);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const lerp = (a, b, p) => a + (b - a) * p;
  const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);
  const smooth = (p) => p * p * (3 - 2 * p);

  const timeline = await (await fetch('/src/timeline.json')).json();
  const geo = await (await fetch('/data/processed/branches.geojson')).json();
  const stats = await (await fetch('/data/processed/stats.json')).json();
  const bounds = await (await fetch('/data/processed/boundaries.geojson')).json();

  const CITY = stats.city_center;              // [lng, lat]
  const PREF = [112.42, 26.80];
  const PREF_PANEL = [112.80, 26.82];
  const CN = [108.6, 31.1];
  const HN = [111.62, 27.25];
  const HD = [112.9485, 27.0810];
  const HD_CCB = [112.948689, 27.081188];
  const HD_ABC = [112.948321, 27.080890];

  const R = 6371000;
  const distM = (a, b) => {
    const p1 = (a[1] * Math.PI) / 180, p2 = (b[1] * Math.PI) / 180;
    const dp = p2 - p1, dl = ((b[0] - a[0]) * Math.PI) / 180;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const toPts = (bank) => geo.features
    .filter((f) => f.properties.bank === bank)
    .map((f) => ({
      lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      name: f.properties.name,
      addr: f.properties.address,
      district: f.properties.district,
      d: distM([f.geometry.coordinates[0], f.geometry.coordinates[1]], CITY),
    }))
    .sort((a, b) => a.d - b.d);

  const CCB = toPts('CCB');
  const ABC = toPts('ABC');
  const farthest = {
    ccb: CCB.reduce((a, b) => (a.d > b.d ? a : b)),
    abc: ABC.reduce((a, b) => (a.d > b.d ? a : b)),
  };

  /* ---------------- 地图 ---------------- */
  const map = new maplibregl.Map({
    container: 'mapA',
    style: {
      version: 8,
      sources: {
        sat: {
          type: 'raster',
          tiles: ['/tiles/sat/{z}/{x}/{y}.jpg'],
          tileSize: 256, minzoom: 3, maxzoom: 18, attribution: '高德地图',
        },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#05070A' } },
        {
          id: 'sat', type: 'raster', source: 'sat',
          paint: {
            'raster-brightness-max': 0.95,
            'raster-brightness-min': 0.03,
            'raster-saturation': -0.45,
            'raster-contrast': 0.08,
          },
        },
      ],
    },
    center: PREF, zoom: 9.5, pitch: 0, bearing: 0,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    maxZoom: 18, minZoom: 3,
    refreshExpiredTiles: false,
  });
  window.__map = map;
  const fx = $('#fx');
  const ctx = fx.getContext('2d');

  /* 光点贴图 */
  function sprite(rgb) {
    const s = 128, c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0.00, `rgba(${rgb},1)`);
    grd.addColorStop(0.14, `rgba(${rgb},.85)`);
    grd.addColorStop(0.34, `rgba(${rgb},.32)`);
    grd.addColorStop(0.62, `rgba(${rgb},.10)`);
    grd.addColorStop(1.00, `rgba(${rgb},0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    return c;
  }
  const SPR = {
    CCB: sprite('84,150,255'),
    ABC: sprite('35,205,128'),
    WHITE: sprite('255,255,255'),
  };
  const RGB = { CCB: '84,150,255', ABC: '35,205,128' };

  /* 区县中心点（用于标注） */
  const districtLabel = bounds.features.map((f) => {
    const c = f.properties.centroid || f.properties.center;
    return { name: f.properties.name, code: String(f.properties.adcode), lng: c[0], lat: c[1] };
  });
  const URBAN = new Set(['430405', '430406', '430407', '430408']);

  /* ---------------- 摄像机 ---------------- */
  const cam = (center, zoom, pitch = 0, bearing = 0) => ({ center, zoom, pitch, bearing });
  const blend = (a, b, p) => ({
    center: [lerp(a.center[0], b.center[0], p), lerp(a.center[1], b.center[1], p)],
    zoom: lerp(a.zoom, b.zoom, p),
    pitch: lerp(a.pitch, b.pitch, p),
    bearing: lerp(a.bearing, b.bearing, p),
  });
  function camSeq(keys, p) {
    if (p <= keys[0].p) return keys[0].cam;
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      if (p <= b.p) {
        const q = clamp01((p - a.p) / (b.p - a.p || 1));
        return blend(a.cam, b.cam, easeInOut(q));
      }
    }
    return keys[keys.length - 1].cam;
  }

  /* ---------------- 场景 ---------------- */
  const sceneById = (id) => timeline.scenes.find((s) => s.id === id);

  // 用 MapLibre 自带的取景计算，保证整个市域在留白范围内完整可见
  const FIT = {};
  function computeFits() {
    const b = [[110.50, 26.02], [113.34, 27.36]];
    const mk = (padding) => {
      const c = map.cameraForBounds(b, { padding });
      return cam([c.center.lng, c.center.lat], c.zoom);
    };
    FIT.full = mk({ left: 90, right: 90, top: 120, bottom: 170 });
    FIT.panel = mk({ left: 60, right: 800, top: 90, bottom: 90 });
    FIT.rhythm = mk({ left: 60, right: 330, top: 150, bottom: 120 });
    FIT.end = mk({ left: 120, right: 120, top: 120, bottom: 150 });
  }

  function stateFor(id, p, t) {
    const st = {
      cam: cam(PREF, 9.5),
      dim: 0.06,
      boundAlpha: 0.5,
      ccbAlpha: 1, abcAlpha: 1,
      ccbCount: CCB.length, abcCount: ABC.length,
      ccbAppear: [0, 0], abcAppear: [0, 0],
      counter: null,
      panel: null,
      focusPair: 0,
      rings: 0,
      endCard: 0,
      fade: 0,
      labels: 'normal',
    };

    if (id === 's00_title') {
      st.cam = camSeq([
        { p: 0, cam: cam([111.9, 27.5], 4.35) },
        { p: 1, cam: cam([112.35, 27.05], 4.9) },
      ], p);
      st.dim = lerp(0.62, 0.42, smooth(p));
      st.boundAlpha = 0;
      st.ccbAlpha = 0; st.abcAlpha = 0;
      st.labels = 'none';
      return st;
    }

    if (id === 's01_intro') {
      st.cam = camSeq([
        { p: 0.00, cam: cam(CN, 3.85) },
        { p: 0.40, cam: cam(HN, 6.55) },
        { p: 0.55, cam: cam(HN, 6.85) },
        { p: 0.86, cam: FIT.full },
        { p: 1.00, cam: FIT.full },
      ], p);
      st.dim = lerp(0.45, 0.06, smooth(clamp01(p / 0.6)));
      st.boundAlpha = clamp01((p - 0.42) / 0.36) * 0.78;
      st.ccbAlpha = 0; st.abcAlpha = 0;
      st.labels = p < 0.55 ? 'province' : 'normal';
      return st;
    }

    if (id === 's02_ccb') {
      st.cam = camSeq([
        { p: 0.00, cam: FIT.full },
        { p: 0.16, cam: cam(CITY, 10.7, 8) },
        { p: 0.50, cam: cam([112.590, 26.894], 13.0, 44) },
        { p: 0.66, cam: cam([112.594, 26.893], 13.06, 46) },
        { p: 0.94, cam: FIT.full },
        { p: 1.00, cam: FIT.full },
      ], p);
      st.dim = 0.05;
      st.boundAlpha = 0.72;
      st.abcAlpha = 0;
      const cityN = 23;
      if (p < 0.10) { st.ccbCount = 0; }
      else if (p < 0.50) { st.ccbCount = Math.round(easeOut((p - 0.10) / 0.40) * cityN); st.ccbAppear = [0.10, 0.50]; }
      else if (p < 0.74) { st.ccbCount = cityN; }
      else {
        st.ccbCount = cityN + Math.round(easeOut((p - 0.74) / 0.20) * (CCB.length - cityN));
        st.ccbAppear = [0.74, 0.92];
      }
      st.counter = { bank: 'CCB', value: st.ccbCount };
      return st;
    }

    if (id === 's03_abc') {
      st.cam = camSeq([
        { p: 0.00, cam: FIT.full },
        { p: 0.30, cam: cam([FIT.full.center[0] + 0.10, FIT.full.center[1] + 0.02], FIT.full.zoom + 0.18) },
        { p: 0.62, cam: cam([FIT.full.center[0] + 0.32, FIT.full.center[1] + 0.03], FIT.full.zoom + 0.22) },
        { p: 0.86, cam: cam([FIT.full.center[0] + 0.04, FIT.full.center[1]], FIT.full.zoom + 0.04) },
        { p: 1.00, cam: FIT.full },
      ], p);
      st.dim = 0.05;
      st.boundAlpha = 0.72;
      st.ccbAlpha = 0.30;
      st.abcCount = p < 0.04 ? 0 : Math.round(easeOut(clamp01((p - 0.04) / 0.66)) * ABC.length);
      st.abcAppear = [0.04, 0.70];
      st.counter = { bank: 'ABC', value: st.abcCount };
      return st;
    }

    if (id === 's04_compare') {
      st.cam = camSeq([
        { p: 0, cam: FIT.panel },
        { p: 1, cam: cam([FIT.panel.center[0], FIT.panel.center[1]], FIT.panel.zoom + 0.08) },
      ], p);
      st.dim = 0.05;
      st.boundAlpha = 0.62;
      st.labels = 'none';
      st.panel = 'compare';
      return st;
    }

    if (id === 's05_pairs') {
      st.cam = camSeq([
        { p: 0.00, cam: cam([112.62, 26.92], 10.2, 0) },
        { p: 0.34, cam: cam(HD, 16.35, 55, -18) },
        { p: 1.00, cam: cam([112.9488, 27.0812], 16.62, 55, -18) },
      ], p);
      st.dim = 0.08;
      st.boundAlpha = 0.25;
      st.focusPair = clamp01((p - 0.3) / 0.2);
      st.panel = 'pair';
      return st;
    }

    if (id === 's06_rhythm') {
      st.cam = camSeq([
        { p: 0.00, cam: cam(HD, 16.4, 55, -18) },
        { p: 0.30, cam: FIT.rhythm },
        { p: 1.00, cam: cam(FIT.rhythm.center, FIT.rhythm.zoom + 0.05) },
      ], p);
      st.dim = 0.05;
      st.boundAlpha = 0.60;
      st.rings = clamp01((p - 0.22) / 0.30);
      st.panel = 'rhythm';
      return st;
    }

    if (id === 's07_ending') {
      st.cam = camSeq([
        { p: 0, cam: FIT.end },
        { p: 0.7, cam: cam(FIT.end.center, FIT.end.zoom - 0.06) },
        { p: 1, cam: cam(FIT.end.center, FIT.end.zoom - 0.12) },
      ], p);
      st.dim = 0.05;
      st.boundAlpha = 0.60;
      st.endCard = clamp01((p - 0.42) / 0.28);
      st.fade = clamp01((p - 0.90) / 0.10);
      return st;
    }
    return st;
  }

  /* ---------------- 绘制 ---------------- */
  function project(lng, lat) {
    return map.project([lng, lat]);
  }
  const onScreen = (p) => p.x > -260 && p.x < 2180 && p.y > -260 && p.y < 1340;

  function drawRegionFill(alpha, zoom) {
    if (alpha <= 0.001) return;
    ctx.save();
    ctx.fillStyle = `rgba(64,116,214,${0.16 * alpha})`;
    ctx.strokeStyle = `rgba(130,175,255,${Math.min(0.95, alpha * 1.0)})`;
    ctx.lineWidth = zoom < 8.6 ? 2.4 : 1.8;
    ctx.lineJoin = 'round';
    for (const f of bounds.features) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) {
        for (const ring of poly) {
          if (!ring || ring.length < 3) continue;
          ctx.beginPath();
          for (let i = 0; i < ring.length; i++) {
            const p = project(ring[i][0], ring[i][1]);
            if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function drawBoundaries(alpha, zoom = 9) {
    if (alpha <= 0.001) return;
    const fade = zoom > 11.4 ? Math.max(0.22, 1 - (zoom - 11.4) / 3.2) : 1;
    alpha *= fade;
    ctx.save();
    ctx.lineJoin = 'round';
    for (const f of bounds.features) {
      const urban = URBAN.has(String(f.properties.adcode));
      ctx.lineWidth = urban ? 1.4 : 1.0;
      ctx.strokeStyle = urban
        ? `rgba(150,190,255,${0.55 * alpha})`
        : `rgba(255,255,255,${0.30 * alpha})`;
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) {
        for (const ring of poly) {
          if (!ring || ring.length < 3) continue;
          ctx.beginPath();
          for (let i = 0; i < ring.length; i++) {
            const p = project(ring[i][0], ring[i][1]);
            if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
          }
          ctx.closePath();
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function drawDistrictLabels(alpha, mode, zoom) {
    if (alpha <= 0.001 || mode === 'none') return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.9)';
    ctx.shadowBlur = 16;

    const countyFade = zoom > 11.8 ? Math.max(0, 1 - (zoom - 11.8) / 0.9) : 1;
    const urbanShow = zoom >= 10.0 && zoom <= 12.4;

    if (mode !== 'province') {
      for (const d of districtLabel) {
        const urban = URBAN.has(d.code);
        if (urban && !urbanShow) continue;
        if (d.name === '南岳区' && zoom < 10) continue;
        const p = project(d.lng, d.lat);
        if (!onScreen(p)) continue;
        const base = urban ? 21 : (zoom < 9 ? 20 : 23);
        ctx.font = `${urban ? 600 : 500} ${base}px "Noto Sans SC","Microsoft YaHei",sans-serif`;
        ctx.fillStyle = `rgba(255,255,255,${(urban ? 0.70 : 0.62) * alpha * countyFade})`;
        ctx.fillText(d.name, p.x, p.y);
      }
    }

    // 城市名（宽视角）
    if (zoom < 10.0 && zoom > 8.4) {
      const cp = project(CITY[0], CITY[1]);
      if (onScreen(cp)) {
        const a = alpha * Math.min(1, (10.0 - zoom) / 0.6);
        ctx.beginPath();
        ctx.moveTo(cp.x, cp.y - 8);
        ctx.lineTo(cp.x, cp.y - 40);
        ctx.strokeStyle = `rgba(233,182,92,${0.55 * a})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cp.x, cp.y - 6, 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(233,182,92,${0.95 * a})`;
        ctx.fill();
        ctx.font = `700 30px "Noto Serif SC","Noto Sans SC",serif`;
        const lw = Math.max(ctx.measureText('衡阳市').width, 116) + 38;
        const ly0 = cp.y - 78;
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.fillStyle = `rgba(5,8,13,${0.84 * a})`;
        roundRect(ctx, cp.x - lw / 2, ly0 - 27, lw, 56, 10);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = `rgba(255,255,255,${0.96 * a})`;
        ctx.fillText('衡阳市', cp.x, ly0);
        ctx.font = `500 12px "Noto Sans SC",sans-serif`;
        ctx.fillStyle = `rgba(233,182,92,${0.88 * a})`;
        ctx.letterSpacing = '4px';
        ctx.fillText('HENGYANG', cp.x, ly0 + 21);
        ctx.letterSpacing = '0px';
      }
    }

    if (mode === 'province') {
      const hp = project(HN[0], HN[1]);
      ctx.font = `700 40px "Noto Serif SC",serif`;
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.shadowBlur = 22;
      ctx.fillText('湖南省', hp.x, hp.y - 30);
    }
    ctx.restore();
  }

  function drawPoints(pts, bank, count, alpha, tAbs, appearAbs, zoom, hlFn) {
    if (alpha <= 0.002 || count <= 0) return;
    const sp = SPR[bank];
    const scale = Math.max(0.62, Math.min(1.22, 0.56 + (zoom - 8) * 0.075));
    const baseSize = (bank === 'CCB' ? 60 : 54) * scale;
    for (let i = 0; i < count && i < pts.length; i++) {
      const pt = pts[i];
      const p = project(pt.lng, pt.lat);
      if (!onScreen(p)) continue;
      const hl = hlFn ? hlFn(pt, i) : 1;
      const a = alpha * hl;
      if (a <= 0.01) continue;

      let grow = 1, ring = -1;
      const at = appearAbs ? lerp(appearAbs[0], appearAbs[1], pts.length > 1 ? i / (pts.length - 1) : 0) : -99;
      const age = tAbs - at;
      if (age >= 0 && age < 0.9) {
        const q = age / 0.9;
        grow = 0.4 + 0.6 * easeOut(q) + 0.18 * Math.sin(q * Math.PI);
        ring = q;
      }

      const size = baseSize * grow;
      ctx.globalAlpha = a;
      ctx.drawImage(sp, p.x - size / 2, p.y - size / 2, size, size);

      if (ring >= 0) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 + ring * 52 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${RGB[bank]},${(1 - ring) * 0.55 * a})`;
        ctx.lineWidth = 2.0;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.9 * scale * grow, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${0.96 * a})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.4 * scale * grow, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${RGB[bank]},${0.92 * a})`;
      ctx.lineWidth = 1.3 * scale;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawPair(alpha, zoom) {
    if (alpha <= 0.001) return;
    const a = project(HD_CCB[0], HD_CCB[1]);
    const b = project(HD_ABC[0], HD_ABC[1]);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    ctx.save();
    ctx.globalAlpha = alpha;

    // 虚线连接
    ctx.beginPath();
    ctx.setLineDash([7, 7]);
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 2;
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 两端小圈
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 22, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // 标签
    const ly = my - 92;
    ctx.font = '700 34px "Noto Sans SC",sans-serif';
    const txt = '49 m';
    const w = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(8,12,18,.78)';
    ctx.strokeStyle = 'rgba(233,182,92,.75)';
    ctx.lineWidth = 1.4;
    roundRect(ctx, mx - w / 2 - 16, ly - 26, w + 32, 46, 10);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#E9B65C';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, mx, ly - 2);

    // 名称
    ctx.font = '600 17px "Noto Sans SC",sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(143,182,255,.95)';
    ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 10;
    ctx.fillText('建行衡东支行', a.x - 30, a.y + 6);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(127,224,180,.95)';
    ctx.fillText('农行衡东支行营业室', b.x + 30, b.y + 34);
    ctx.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function circleAt(center, radiusM, n = 128) {
    const pts = [];
    const latR = (radiusM / 111320);
    const lngR = radiusM / (111320 * Math.cos((center[1] * Math.PI) / 180));
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push([center[0] + Math.cos(a) * lngR, center[1] + Math.sin(a) * latR]);
    }
    return pts;
  }

  function drawRings(alpha) {
    if (alpha <= 0.001) return;
    const radii = [20000, 40000, 60000, 80000, 100000];
    ctx.save();
    ctx.font = '500 15px "Noto Sans SC",sans-serif';
    ctx.textAlign = 'center';
    ctx.setLineDash([5, 9]);
    for (let i = 0; i < radii.length; i++) {
      const r = radii[i];
      const a = alpha * (1 - i * 0.10) * 0.62;
      const pts = circleAt(CITY, r);
      ctx.beginPath();
      for (let j = 0; j < pts.length; j++) {
        const p = project(pts[j][0], pts[j][1]);
        if (j === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = `rgba(233,182,92,${a})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const left = project(CITY[0] - r / (111320 * Math.cos((CITY[1] * Math.PI) / 180)), CITY[1]);
      if (onScreen(left)) {
        ctx.fillStyle = `rgba(233,182,92,${Math.min(1, a * 1.5)})`;
        ctx.textAlign = 'right';
        ctx.fillText(`${r / 1000} km`, left.x - 10, left.y + 5);
        ctx.textAlign = 'center';
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawFarPoints(alpha) {
    if (alpha <= 0.01) return;
    const items = [
      { p: farthest.ccb, bank: 'CCB', label: `最远 ${Math.round(farthest.ccb.d / 1000)} km` },
      { p: farthest.abc, bank: 'ABC', label: `最远 ${Math.round(farthest.abc.d / 1000)} km` },
    ];
    ctx.save();
    for (const it of items) {
      const s = project(it.p.lng, it.p.lat);
      if (!onScreen(s)) continue;
      const c = project(CITY[0], CITY[1]);
      ctx.beginPath();
      ctx.setLineDash([3, 7]);
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(s.x, s.y);
      ctx.strokeStyle = `rgba(${RGB[it.bank]},${0.35 * alpha})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${RGB[it.bank]},${0.9 * alpha})`;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.font = '600 16px "Noto Sans SC",sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = `rgba(255,255,255,${0.9 * alpha})`;
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 10;
      ctx.fillText(it.label, s.x + 16, s.y + 5);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  /* ---------------- DOM ---------------- */
  const el = {
    brand: $('#brand'), title: $('#titleCard'), counter: $('#counterBox'),
    legend: $('#legend'), caption: $('#caption'), cmp: $('#comparePanel'),
    rows: $('#cmpRows'), pair: $('#pairCard'), rhythm: $('#rhythmPanel'),
    end: $('#endCard'), dim: $('#dim'),
  };

  const setOp = (node, v) => { node.style.opacity = v.toFixed(3); };
  const setX = (node, v) => { node.style.transform = `translateX(${v}px)`; };
  const setY = (node, v) => { node.style.transform = `translateY(${v}px)`; };

  // 区县柱状图
  const districtOrder = ['蒸湘区', '石鼓区', '珠晖区', '雁峰区', '耒阳市', '常宁市', '衡阳县', '衡南县', '祁东县', '衡东县', '衡山县', '南岳区'];
  const cmpBars = districtOrder.map((name) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div class="nm">${name}</div><div class="bars">
      <div class="bar ccb"></div><div class="bar abc"></div></div>
      <div class="val"><b>0</b><i>/</i><b>0</b></div>`;
    el.rows.appendChild(row);
    return {
      name,
      ccb: stats.by_district[name].ccb,
      abc: stats.by_district[name].abc,
      ccbBar: row.querySelector('.bar.ccb'),
      abcBar: row.querySelector('.bar.abc'),
      val: row.querySelector('.val'),
    };
  });
  const maxVal = Math.max(...cmpBars.map((b) => Math.max(b.ccb, b.abc)));

  function updateCompare(p) {
    const q = easeOut(clamp01((p - 0.10) / 0.68));
    for (const b of cmpBars) {
      b.ccbBar.style.width = ((b.ccb / maxVal) * 100 * q).toFixed(2) + '%';
      b.abcBar.style.width = ((b.abc / maxVal) * 100 * q).toFixed(2) + '%';
      b.val.innerHTML = `<b>${Math.round(b.ccb * q)}</b><i>/</i><b>${Math.round(b.abc * q)}</b>`;
    }
  }

  function highlightNumbers(s) {
    return s.replace(/(\d+(?:\.\d+)?(?:%|个|米|公里|倍|对|家|号)?)/g, '<span class="hl">$1</span>');
  }

  function updateCaption(t) {
    let found = null;
    for (const sc of timeline.scenes) {
      for (const c of sc.captions) {
        if (t >= c.start - 0.15 && t <= c.end + 0.15) { found = c; break; }
      }
      if (found) break;
    }
    if (!found) { setOp(el.caption, 0); return; }
    const fadeIn = clamp01((t - (found.start - 0.15)) / 0.22);
    const fadeOut = clamp01(((found.end + 0.15) - t) / 0.18);
    setOp(el.caption, Math.min(fadeIn, fadeOut));
    const html = highlightNumbers(found.text);
    if (el.caption.dataset.html !== html) {
      el.caption.dataset.html = html;
      el.caption.innerHTML = html;
    }
  }

  /* ---------------- 主渲染 ---------------- */
  let curScene = null;

  function render(t) {
    const sc = timeline.scenes.find((s) => t >= s.start && t < s.end) || timeline.scenes[timeline.scenes.length - 1];
    const p = clamp01((t - sc.start) / sc.duration);
    const st = stateFor(sc.id, p, t);
    curScene = sc;

    // 结尾卡片升起时，同步淡出画布上的光点与注记，避免文字背后透出地名
    const ovFade = 1 - clamp01(st.endCard * 1.15);
    st.boundAlpha *= ovFade;
    st.ccbAlpha *= ovFade;
    st.abcAlpha *= ovFade;

    map.jumpTo({
      center: st.cam.center,
      zoom: st.cam.zoom,
      pitch: st.cam.pitch,
      bearing: st.cam.bearing,
    });

    const zoom = st.cam.zoom;
    window.__dbg = { id: sc.id, p, st, mapZoom: map.getZoom(), loaded: map.loaded() };
    ctx.clearRect(0, 0, 1920, 1080);

    // 让地图先落到新位置再投影
    drawRegionFill(st.boundAlpha, zoom);
    drawBoundaries(st.boundAlpha * 0.8, zoom);
    drawDistrictLabels(st.boundAlpha, st.labels, zoom);
    if (st.rings > 0.01) drawRings(st.rings);
    const ccbAppearAbs = sc.id === 's02_ccb'
      ? [sc.start + st.ccbAppear[0] * sc.duration, sc.start + st.ccbAppear[1] * sc.duration] : null;
    const abcAppearAbs = sc.id === 's03_abc'
      ? [sc.start + st.abcAppear[0] * sc.duration, sc.start + st.abcAppear[1] * sc.duration] : null;
    let hlCcb = null, hlAbc = null;
    if (st.focusPair > 0.01) {
      const near = (pt, ref) => (Math.abs(pt.lng - ref[0]) < 1e-6 && Math.abs(pt.lat - ref[1]) < 1e-6 ? 1 : 0.10);
      hlCcb = (pt) => near(pt, HD_CCB);
      hlAbc = (pt) => near(pt, HD_ABC);
    }
    const both = st.ccbAlpha > 0.05 && st.abcAlpha > 0.05;
    if (both) {
      drawPoints(ABC, 'ABC', st.abcCount, st.abcAlpha, t, abcAppearAbs, zoom, hlAbc);
      drawPoints(CCB, 'CCB', st.ccbCount, st.ccbAlpha, t, ccbAppearAbs, zoom, hlCcb);
    } else {
      drawPoints(CCB, 'CCB', st.ccbCount, st.ccbAlpha, t, ccbAppearAbs, zoom, hlCcb);
      drawPoints(ABC, 'ABC', st.abcCount, st.abcAlpha, t, abcAppearAbs, zoom, hlAbc);
    }

    if (st.rings > 0.01) drawFarPoints(st.rings);
    if (st.focusPair > 0.01) drawPair(st.focusPair, zoom);

    // 关键：给画布留一个几乎不可见的不透明像素。
    // 否则整帧全透明时，Chrome 可能跳过该画布层的合成，导致上一帧残留。
    ctx.fillStyle = 'rgba(255,255,255,0.004)';
    ctx.fillRect(0, 0, 2, 2);

    // ---- DOM ----
    el.dim.style.opacity = st.dim.toFixed(3);
    setOp(el.brand, (sc.id === 's00_title' ? 0 : clamp01((t - timeline.scenes[1].start) / 0.8) * 0.95) * (1 - clamp01(st.endCard * 2)));

    // 标题
    if (sc.id === 's00_title') {
      const inA = clamp01((p - 0.06) / 0.16);
      const outA = clamp01((1 - p) / 0.10);
      setOp(el.title, Math.min(inA, outA));
      setY(el.title, (1 - easeOut(inA)) * 26);
    } else setOp(el.title, 0);

    // 计数器
    if (st.counter) {
      el.counter.className = st.counter.bank === 'CCB' ? 'ccb' : 'abc';
      el.counter.querySelector('.lbl').textContent = st.counter.bank === 'CCB' ? '中国建设银行 · 营业网点' : '中国农业银行 · 营业网点';
      el.counter.querySelector('.num').textContent = st.counter.value;
      const show = clamp01((p - 0.02) / 0.10);
      setOp(el.counter, show);
    } else setOp(el.counter, 0);

    // 图例
    const legendShow = (sc.id === 's02_ccb' || sc.id === 's03_abc' || sc.id === 's04_compare' || sc.id === 's05_pairs' || sc.id === 's06_rhythm' || sc.id === 's07_ending')
      ? clamp01((t - timeline.scenes[2].start) / 0.8) : 0;
    setOp(el.legend, legendShow * 0.95 * (1 - clamp01(st.endCard * 2)));

    // 对比面板
    if (st.panel === 'compare') {
      setOp(el.cmp, clamp01((p - 0.04) / 0.12));
      setX(el.cmp, (1 - easeOut(clamp01((p - 0.04) / 0.12))) * 26);
      updateCompare(p);
    } else setOp(el.cmp, 0);

    // 门对门
    if (st.panel === 'pair') {
      const a = clamp01((p - 0.40) / 0.14) * clamp01((1 - p) / 0.06);
      setOp(el.pair, a);
      setX(el.pair, (1 - easeOut(clamp01((p - 0.40) / 0.14))) * -20);
    } else setOp(el.pair, 0);

    // 节奏面板
    if (st.panel === 'rhythm') {
      const a = clamp01((p - 0.26) / 0.14);
      setOp(el.rhythm, a);
      setY(el.rhythm, (1 - easeOut(a)) * 16);
    } else setOp(el.rhythm, 0);

    // 结尾
    if (st.endCard > 0.001) {
      setOp(el.end, st.endCard);
    } else setOp(el.end, 0);

    if (st.endCard > 0.35) setOp(el.caption, 0); else updateCaption(t);

    // 结尾淡出
    if (st.fade > 0.001) {
      el.dim.style.opacity = (st.dim + st.fade * (1 - st.dim)).toFixed(3);
    }
  }

  async function waitIdle(timeout = 6000) {
    return new Promise((res) => {
      if (map.loaded()) return res();
      let done = false;
      const fin = () => { if (!done) { done = true; map.off('idle', fin); res(); } };
      map.once('idle', fin);
      setTimeout(fin, timeout);
    });
  }

  window.renderAt = async function (t) {
    render(t);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await waitIdle();
    await new Promise((r) => requestAnimationFrame(r));
  };

  window.preWarm = async function (step = 0.5) {
    for (let t = 0; t <= timeline.total; t += step) {
      render(t);
      await new Promise((r) => requestAnimationFrame(r));
      await waitIdle(8000);
    }
  };

  window.TIMELINE = timeline;
  map.on('load', () => {
    map.resize();
    computeFits();
    window.READY = true;
  });
  map.on('error', (e) => console.warn('map error', e && e.error && e.error.message));
})();
