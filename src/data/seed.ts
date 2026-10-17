/**
 * 种子数据 —— 现在**默认为空**。
 *
 * 早期版本在这里预填了真实姓名、证书、项目经历与真实案件细节，这些内容会随
 * 代码打包进公开 JS bundle。为消除隐私与执业保密风险，已全部移除。
 *
 * 你的真实数据保存在本机浏览器 localStorage 中，不受此处改动影响：
 *   - 已在使用网站：数据原样保留（迁移只做“补齐”，从不覆盖已有记录）
 *   - 换设备/新浏览器：用「设置 → 导出 JSON」备份，在新设备「导入 JSON」恢复
 *   - 或用坚果云 WebDAV：「上传备份」→「下载恢复」
 */
import type { ProfileData } from '../types';

export const SEED_PROFILE: ProfileData = {
  single: { personal: {}, education: {}, resumeFile: {}, extra: {} },
  multi: {
    education: [],
    internship: [],
    work: [],
    project: [],
    practice: [],
    certificate: [],
    award: [],
    paper: [],
    family: [],
  },
};

/** 需要增量迁移的项目经历（保持为空；留作未来按需预置模板的入口） */
export const MIGRATION_PROJECTS: Record<string, string>[] = [];

export const SEED_APPLICATIONS: unknown[] = [];
export const SEED_EVENTS: unknown[] = [];
