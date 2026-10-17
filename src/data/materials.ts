/**
 * 网申材料清单（默认模板）。
 *
 * 与早期版本的区别：材料清单不再硬编码在代码里，而是保存在你本机浏览器
 * （localStorage: qz.materials / qz.materialBase），可在「材料清单」板块增删改。
 * 这样文件名、单位名等私人信息不会随站点部署到公网。
 *
 * 站点也不会再打包任何个人图片（原 profile-photo.jpg 已移除，证件照改为
 * 从本机浏览器读取，见 src/lib/photo.ts）。
 */

export interface MaterialGroup {
  id: string;
  title: string;
  icon: string;
  dir: string;             // 相对「材料根目录」的子目录（'' 表示根目录）
  hint: string;
  files: { name: string; note: string }[];
}

const LS_GROUPS = 'qz.materials';
const LS_BASE = 'qz.materialBase';

export const MATERIAL_BASE_DEFAULT = '';

export const DEFAULT_MATERIAL_GROUPS: MaterialGroup[] = [
  {
    id: 'proof', title: '证明材料', icon: 'award', dir: '证明材料',
    hint: '奖项 / 政治面貌 / 任职等证明扫描件，用于网申「获奖情况」「在校职务」板块。',
    files: [
      { name: '（示例）奖学金证明.jpg', note: '按你本机实际文件名修改' },
      { name: '（示例）政治面貌证明.jpg', note: '如党员证明等' },
    ],
  },
  {
    id: 'id', title: '证件照 / 身份证件', icon: 'user', dir: '证件',
    hint: '身份证正反面、证件照、学生证，用于身份核验与证件照上传。',
    files: [
      { name: '（示例）证件照.jpg', note: '一寸/二寸白底照' },
      { name: '（示例）身份证人像面.jpg', note: '' },
      { name: '（示例）身份证国徽面.jpg', note: '' },
      { name: '（示例）学生证.jpg', note: '' },
    ],
  },
  {
    id: 'edu', title: '学历学位验证', icon: 'edu', dir: '学历学位',
    hint: '学信网在线验证报告，网申「教育经历」学历核验用。',
    files: [
      { name: '（示例）教育部学历证书电子注册备案表.pdf', note: '' },
      { name: '（示例）学位在线验证报告.pdf', note: '' },
    ],
  },
  {
    id: 'score', title: '成绩与外语', icon: 'paper', dir: '成绩',
    hint: '成绩单、四六级成绩单、职业资格成绩，多数企业网申需上传。',
    files: [
      { name: '（示例）本科成绩单.pdf', note: '教务处盖章版' },
      { name: '（示例）CET-6成绩单.pdf', note: '' },
    ],
  },
  {
    id: 'misc', title: '其他', icon: 'layers', dir: '',
    hint: '个人形象照、求职补贴表等杂项。',
    files: [{ name: '（示例）个人照片.jpg', note: '形象照' }],
  },
];

export function getMaterialGroups(): MaterialGroup[] {
  try {
    const raw = localStorage.getItem(LS_GROUPS);
    if (raw) {
      const d = JSON.parse(raw);
      if (Array.isArray(d) && d.length) return d as MaterialGroup[];
    }
  } catch { /* ignore */ }
  return DEFAULT_MATERIAL_GROUPS;
}
export function setMaterialGroups(groups: MaterialGroup[]) {
  try { localStorage.setItem(LS_GROUPS, JSON.stringify(groups)); } catch { /* ignore */ }
}

export function getMaterialBase(): string {
  try { return localStorage.getItem(LS_BASE) || MATERIAL_BASE_DEFAULT; } catch { return MATERIAL_BASE_DEFAULT; }
}
export function setMaterialBase(base: string) {
  try { localStorage.setItem(LS_BASE, base.trim()); } catch { /* ignore */ }
}

export function materialPath(g: MaterialGroup, name: string): string {
  const base = getMaterialBase();
  if (!base) return g.dir ? `${g.dir}/${name}` : name;
  return g.dir ? `${base}/${g.dir}/${name}` : `${base}/${name}`;
}

/**
 * 早期版本把个人证件照打包进了站点（/profile-photo.jpg），已移除。
 * 现在证件照保存在你本机浏览器并仅在本地渲染，见 src/lib/photo.ts。
 */
export const BUNDLED_IMAGES: Record<string, string> = {};

export function bundledImage(name: string): string | null {
  return BUNDLED_IMAGES[name.trim()] || null;
}
