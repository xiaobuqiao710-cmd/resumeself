import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, ImageRun, Table, TableRow, TableCell, WidthType, BorderStyle } from 'docx';
import type { ProfileData } from '../types';

/** 无边框（抬头两栏：左文字 + 右证件照） */
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;
const NO_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };

/**
 * 把本机证件照（data URL）转成 Word 图片。
 *
 * 修复背景：导出的 Word 原先**完全没有图片**——证件照只存在于网页预览（`PhotoSlot`），
 * 生成器根本没接收它，于是用户上传的证件照在真正投出去的 Word 里丢了，
 * 而国央企 / 银行网申普遍要求简历贴照片。尺寸按一寸照比例 3:4 渲染。
 */
async function photoRun(dataUrl?: string | null): Promise<ImageRun | null> {
  /* docx 的 ImageRun 只认 svg/png/jpg/gif/bmp；`lib/photo.ts` 产出的就是 JPEG，
     PNG 也一并支持，其余格式（webp 等）直接跳过而不是抛错。 */
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const type = m[1].toLowerCase() === 'png' ? 'png' : 'jpg';
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    /* 按原图比例算高度：证件照有 3:4 / 5:7 等多种比例，写死高度会把脸拉扁。
       宽度固定 92px（≈2.4cm），高度按比例推，拿不到尺寸时退回一寸照比例 5:7。 */
    const ratio = await new Promise<number>((resolve) => {
      try {
        const img = new Image();
        const t = setTimeout(() => resolve(7 / 5), 1500);
        img.onload = () => { clearTimeout(t); resolve(img.naturalHeight && img.naturalWidth ? img.naturalHeight / img.naturalWidth : 7 / 5); };
        img.onerror = () => { clearTimeout(t); resolve(7 / 5); };
        img.src = String(dataUrl);
      } catch { resolve(7 / 5); }
    });
    const height = Math.round(92 * Math.min(1.6, Math.max(1.1, ratio)));
    return new ImageRun({ type, data: bytes, transformation: { width: 92, height } });
  } catch { return null; }   // data URL 损坏时宁可不带照片，也不能让整份简历导不出来
}

/**
 * 依据个人档案（profile）综合生成 Word(.docx) 简历。
 * opts.photo 传本机证件照 data URL（`lib/photo.ts: getPhoto()`），有则排在抬头右侧（与网页预览一致）。
 *
 * 早期还有 `opts.agent` 会附加一份写死在代码里的「AI Agent 项目经历」——那是作者本人
 * 职业转向专用的内容，站点面向所有人后已移除；想要多版本简历请用「简历版本」板块自行维护。
 */
export async function buildResumeDocx(profile: ProfileData, opts: { photo?: string | null } = {}): Promise<Blob> {
  const p = profile.single.personal || {};
  const edu = profile.multi.education || [];
  const intern = profile.multi.internship || [];
  const proj = profile.multi.project || [];
  const prac = profile.multi.practice || [];
  const certs = profile.multi.certificate || [];
  const awards = profile.multi.award || [];
  const extra = profile.single.extra || {};
  const C: (Paragraph | Table)[] = [];

  const h1 = (t: string) => C.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 100 }, children: [new TextRun({ text: t, bold: true, size: 26 })] }));
  const line = (main: string, right?: string, bold = true) => C.push(new Paragraph({
    spacing: { before: 80, after: 20 },
    children: [
      new TextRun({ text: main, bold, size: 22 }),
      ...(right ? [new TextRun({ text: `\t${right}`, size: 20, color: '666666' })] : []),
    ],
  }));
  const bullet = (t: string) => t && C.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 20 }, children: [new TextRun({ text: t, size: 21 })] }));
  const span = (a?: string, b?: string) => [a, b].filter(Boolean).join(' ~ ');

  // ---- 抬头（有证件照时用两栏：左姓名联系方式、右照片；无照片保持原来的居中排版） ----
  const photo = await photoRun(opts.photo);
  const namePara = (align: (typeof AlignmentType)[keyof typeof AlignmentType]) => new Paragraph({ alignment: align, spacing: { after: 40 }, children: [new TextRun({ text: p.name || '我的简历', bold: true, size: 40 })] });
  const contactPara = (align: (typeof AlignmentType)[keyof typeof AlignmentType]) => new Paragraph({ alignment: align, spacing: { after: 20 }, children: [new TextRun({ text: [p.phone, p.email, p.currentCity].filter(Boolean).join('  |  '), size: 20 })] });
  const tagPara = (align: (typeof AlignmentType)[keyof typeof AlignmentType]) => new Paragraph({ alignment: align, spacing: { after: 120 }, children: [new TextRun({ text: [p.political, p.highestEdu, p.englishLevel, p.wechat ? `微信 ${p.wechat}` : null].filter(Boolean).join('  |  '), size: 20, color: '555555' })] });
  if (photo) {
    C.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: NO_BORDERS,
      rows: [new TableRow({
        children: [
          new TableCell({
            width: { size: 76, type: WidthType.PERCENTAGE }, borders: NO_BORDERS,
            margins: { top: 0, bottom: 0, left: 0, right: 120 },
            children: [namePara(AlignmentType.LEFT), contactPara(AlignmentType.LEFT), tagPara(AlignmentType.LEFT)],
          }),
          new TableCell({
            width: { size: 24, type: WidthType.PERCENTAGE }, borders: NO_BORDERS,
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [photo] })],
          }),
        ],
      })],
    }));
  } else {
    C.push(namePara(AlignmentType.CENTER), contactPara(AlignmentType.CENTER), tagPara(AlignmentType.CENTER));
  }

  // ---- 教育经历 ----
  if (edu.length) {
    h1('教育经历');
    edu.forEach((e) => {
      line(`${e.school || ''} · ${e.major || ''}`, span(e.start, e.end));
      bullet([e.edu, e.degree, e.gpa ? `GPA ${e.gpa}` : null].filter(Boolean).join(' / '));
      if (e.courses) bullet(`课程：${e.courses}`);
      if (e.majorDesc) bullet(e.majorDesc);
    });
  }

  // ---- 实习经历 ----
  if (intern.length) {
    h1('实习经历');
    intern.forEach((e) => {
      line(`${e.company || ''} · ${e.position || ''}`, span(e.start, e.end));
      (e.content || '').split('\n').forEach(bullet);
    });
  }

  // ---- 项目经历 ----
  if (proj.length) {
    h1('项目经历');
    proj.forEach((e) => {
      line(e.name || e.desc || '项目', span(e.start, e.end));
      if (e.desc) bullet(e.desc);
      if (e.duty) bullet(`职责：${e.duty}`);
      if (e.result) bullet(`成果：${e.result}`);
    });
  }

  // ---- 在校实践与职务 ----
  if (prac.length) {
    h1('在校实践与职务');
    prac.forEach((e) => {
      line(e.title || e.name || '', span(e.start, e.end));
      if (e.desc) bullet(e.desc);
    });
  }

  // ---- 技能证书 ----
  if (certs.length) {
    h1('技能证书');
    certs.forEach((e) => bullet(`${e.name}${e.issuer ? `（${e.issuer}）` : ''}${e.date ? ` ${e.date}` : ''}${e.desc ? `：${e.desc}` : ''}`));
  }

  // ---- 获奖与证书 ----
  if (awards.length) {
    h1('获奖与证书');
    awards.forEach((e) => bullet(`${e.name}${e.level ? `（${e.level}）` : ''}${e.date ? ` ${e.date}` : ''}${e.desc ? `：${e.desc}` : ''}`));
  }

  // ---- 专业技能 ----
  h1('专业技能');
  if (p.skills) bullet(p.skills);

  // ---- 自我评价 ----
  const selfEval = extra.selfEval || p.selfEval;
  if (selfEval) {
    h1('自我评价');
    C.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: selfEval, size: 21 })] }));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: '宋体', size: 21 } } } },
    sections: [{ properties: {}, children: C }],
  });
  return Packer.toBlob(doc);
}
