/**
 * 临时脚本：算出候选色板的 WCAG 对比度，避免"看着还行"就上线。
 * 用完即删。
 */

const hex = (h) => {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const lum = (h) => {
  const [r, g, b] = hex(h).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a, b) => {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const P = {
  bg: '#101615',
  panel: '#151d1c',
  panel2: '#1a2422',
  paper: '#d6d0c0',
  paperDone: '#b9b3a4',
  text: '#cdd5d0',
  textDim: '#93a09a',
  textFaint: '#7e8a84',
  paperInk: '#2b2823',
  paperDim: '#565248',
  brass: '#a4843f',
  brassLt: '#d3b273',
  seal: '#8a3a34',
  sealLt: '#cf8b81',
  olive: '#7fae86',
};

const pairs = [
  ['text on bg', P.text, P.bg],
  ['text on panel', P.text, P.panel],
  ['textDim on bg', P.textDim, P.bg],
  ['textDim on panel', P.textDim, P.panel],
  ['textFaint on bg', P.textFaint, P.bg],
  ['textFaint on panel', P.textFaint, P.panel],
  ['brassLt on bg', P.brassLt, P.bg],
  ['brassLt on panel', P.brassLt, P.panel],
  ['brass on bg', P.brass, P.bg],
  ['sealLt on bg', P.sealLt, P.bg],
  ['olive on bg', P.olive, P.bg],
  ['paperInk on paper', P.paperInk, P.paper],
  ['paperInk on paperDone', P.paperInk, P.paperDone],
  ['paperDim on paper', P.paperDim, P.paper],
  ['seal on paper', P.seal, P.paper],
  ['paper on bg (node block)', P.paper, P.bg],
];

const verdict = (r, size) => {
  if (r >= 7) return 'AAA';
  if (r >= 4.5) return 'AA';
  if (r >= 3) return size === 'large' ? 'AA-large' : 'FAIL(小字)';
  return 'FAIL';
};

for (const [name, fg, bg] of pairs) {
  const r = ratio(fg, bg);
  console.log(
    `${name.padEnd(30)} ${String(r.toFixed(2)).padStart(6)}  ${verdict(r, name.includes('node') ? 'large' : 'small')}`
  );
}
