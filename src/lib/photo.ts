/**
 * 个人证件照（本机浏览器内保存，不随站点部署）。
 *
 * 早期版本把证件照打包进站点根目录 /profile-photo.jpg，任何访客都能直接下载。
 * 现在照片只存于你自己的浏览器 localStorage，并在上传时自动压缩到长边 480px，
 * 既避免公网泄露，也避免占用过多本地存储配额。
 */
const KEY = 'qz.photo';

export function getPhoto(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function clearPhoto() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** 读取图片文件 → 压缩 → 存 localStorage，返回压缩后的 dataURL */
export async function setPhotoFromFile(file: File, maxEdge = 480): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('图片解析失败'));
    i.src = dataUrl;
  });
  const scale = Math.min(1, maxEdge / Math.max(img.width || 1, img.height || 1));
  const w = Math.max(1, Math.round((img.width || maxEdge) * scale));
  const h = Math.max(1, Math.round((img.height || maxEdge) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持图片压缩');
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL('image/jpeg', 0.85);
  /* 证件照 base64 约 100–200KB，本机存储接近 5MB 时会写不进去。
     原先这里裸调 setItem，配额异常直接冒泡成「图片解析失败」之外的未捕获错误。 */
  try { localStorage.setItem(KEY, out); }
  catch { throw new Error('本机存储已满，证件照没能保存：请先到「设置 → 数据与备份」导出备份，再清理不需要的数据'); }
  return out;
}
