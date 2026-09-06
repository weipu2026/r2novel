/**
 * gen-icon.mjs — 零依赖生成 PWA 图标（Node zlib 手写 PNG）
 * 产出 public/icons/{icon-192,icon-512,maskable-512}.png
 *
 * 视觉：与书架「首字色块」同源的暖棕底色 + 翻开的书页（白），页内横线模拟文字。
 * 用法：npm run icons
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 像素绘图 ---------- */
function roundRectInside(x, y, rx, ry, rw, rh, rad) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const dx = x < rx + rad ? rx + rad - x : x > rx + rw - rad ? x - (rx + rw - rad) : 0;
  const dy = y < ry + rad ? ry + rad - y : y > ry + rh - rad ? y - (ry + rh - rad) : 0;
  return dx * dx + dy * dy <= rad * rad;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 画图标
 * @param {number} size 画布边长
 * @param {boolean} maskable true=背景铺满（安全区裁切），false=圆角卡片
 * @returns {Buffer} rgba 像素
 */
function draw(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  const bgTop = [0xcf, 0x8a, 0x44];
  const bgBot = [0x9c, 0x58, 0x1f];
  const rad = Math.round(size * 0.2);
  const inset = maskable ? 0 : Math.round(size * 0.1);

  // 内容（书页）区域参数，单位=size
  const W = size;
  const book = {
    top: maskable ? 0.3 : 0.27,
    bot: maskable ? 0.78 : 0.72,
    lx: maskable ? 0.26 : 0.22,
    w: maskable ? 0.48 : 0.56,
  };
  // 书页拆两页：左页右页宽度 = (w - spineW)/2
  const spine = maskable ? 0.05 : 0.045;
  const gap = 0; // 页与脊无缝
  const pageLx = book.lx;
  const pageRx = book.lx + book.w - (book.w - spine) / 2 + spine * 0.02;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x / W;
      const py = y / W;
      const i = (y * size + x) * 4;
      const inside = maskable || roundRectInside(x, y, inset, inset, W - inset * 2, W - inset * 2, rad);
      if (!inside) {
        buf[i + 3] = 0;
        continue;
      }
      // 背景垂直渐变
      const t = Math.max(0, Math.min(1, y / W));
      const r = Math.round(lerp(bgTop[0], bgBot[0], t));
      const g = Math.round(lerp(bgTop[1], bgBot[1], t));
      const b = Math.round(lerp(bgTop[2], bgBot[2], t));
      let R = r, G = g, B = b;

      const inPage = (pxx, pw) => {
        if (py < book.top || py > book.bot) return false;
        if (px < pxx || px > pxx + pw) return false;
        // 页轻微圆角不细究
        return true;
      };
      // 左页 / 右页
      const pw = (book.w - spine) / 2;
      if (inPage(pageLx, pw) || inPage(pageRx, pw)) {
        // 书页白底
        R = 255; G = 255; B = 255;
        // 页内文字行：深棕横线，避开书脊侧 12%
        const lx0 = pageLx + pw * 0.16;
        const lw = pw * 0.68;
        for (let row = 0; row < 4; row++) {
          const ly = book.top + (book.bot - book.top) * (0.2 + row * 0.2);
          const lh = (book.bot - book.top) * 0.055;
          if (py >= ly - lh / 2 && py <= ly + lh / 2 && px >= lx0 && px <= lx0 + lw) {
            const rr = Math.round(lerp(188, 140, 0.3));
            R = rr; G = Math.round(lerp(120, 96, 0.3)); B = Math.round(lerp(66, 52, 0.3));
          }
        }
      }
      buf[i] = R;
      buf[i + 1] = G;
      buf[i + 2] = B;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

/* ---------- 产出 ---------- */
const jobs = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true],
];
for (const [name, size, maskable] of jobs) {
  const rgba = draw(size, maskable);
  const png = encodePng(size, size, rgba);
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`✓ ${name} (${size}x${size}${maskable ? ', maskable' : ''}, ${png.length} bytes)`);
}
console.log('图标已生成到 public/icons/');
