/**
 * 对比度探针（由 scripts/qa-e2e.mjs 的 contrast 场景用 fs 读取后原样注入页面执行）。
 *
 * 独立成文件的原因：若把这段代码写进 qa-e2e.mjs 的模板字符串里，正则中的反斜杠会被
 * 模板字面量当作转义符吃掉（`\(` → `(`），探针会静默算出 NaN。文件形式没有这层转义。
 *
 * 注意：本站是玻璃拟态 + 极光渐变背景，这里只做「半透明层逐级合成到 body 底色」的近似，
 * 不用来做精确验收，只用于把明显过低的对比度捞出来人工复核。
 */
(() => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const bodyBg = () => parse(getComputedStyle(document.body).backgroundColor) || { r: 11, g: 16, b: 32, a: 1 };
  const bgOf = (el) => {
    let p = el;
    let acc = null;
    while (p && p !== document.documentElement) {
      const c = parse(getComputedStyle(p).backgroundColor);
      if (c && c.a > 0) {
        acc = acc ? over(acc, c) : c;
        if (c.a >= 0.95) return acc;      // 已完全不透明，无需再往上合成
      }
      p = p.parentElement;
    }
    return acc ? over(acc, bodyBg()) : bodyBg();
  };

  const out = [];
  for (const el of document.querySelectorAll('.app__scroll *')) {
    if (el.children.length) continue;
    const t = (el.textContent || '').trim();
    if (t.length < 2) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.4) continue;
    /* 渐变文字（background-clip:text）的 color 是 transparent、颜色靠背景渐变画出来，
       按 cs.color 算出来恒等于 1.0。不跳过的话每次巡检都固定报一条「❌ 1」，
       久了就没人再看这份报告了 —— 假红比不报更糟。 */
    if (cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text') continue;
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const L1 = lum(over(fg, bg));
    const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    out.push({
      cls: (typeof el.className === 'string' ? el.className : el.tagName).slice(0, 34),
      text: t.slice(0, 18),
      ratio: Math.round(ratio * 100) / 100,
      size: Math.round(parseFloat(cs.fontSize) * 10) / 10,
      bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
    });
  }
  out.sort((a, b) => a.ratio - b.ratio);
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    n: out.length,
    worst: out.slice(0, 8),
    /* WCAG AA：正文 4.5、大字号(≥18.66px 或 14px 粗体) 3.0；这里把低于 3 的都算「需人工复核」 */
    below3: out.filter((x) => x.ratio < 3).length,
    below45: out.filter((x) => x.ratio < 4.5).length,
  };
})();
