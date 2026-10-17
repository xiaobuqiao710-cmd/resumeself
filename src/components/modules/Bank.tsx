import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store/store';
import type { Question, QKind, QuestionBank, BankCategory } from '../../types';
import { FALLBACK_CAT_ID, sortCategories, questionCatId } from '../../lib/bankMeta';
import { buildGroups, groupFallbackTitle, splitRawText, brief, type QGroup } from '../../lib/qgroup';
import { Icon } from '../ui/Icon';
import { Button, Badge, Modal, Empty, Segmented, AiBtn } from '../ui/Kit';
import { RichText } from '../ui/RichText';
import { cn } from '../../lib/util';
import { getAiConfig, hasAiKey, aiAnswerQuestion, aiAssist, callAi, extractJsonArray, extractJsonObject } from '../../lib/ai';

const DIFF_META: Record<string, string> = { '易': 'badge--ok', '中': 'badge--warn', '难': 'badge--danger' };

/** 「该分类下还没归入任何题库的题」的哨兵值 */
const NO_BANK = '__nobank__';

/** 分类卡片的配色环，按分类顺序轮转，让卡片墙一眼能区分 */
const CAT_TONES = ['badge--accent', 'badge--info', 'badge--ok', 'badge--warn', 'badge--danger'];

/** 常见题目分类（可自由扩展，AI 归类时作为候选） */
const SUGGEST_CATEGORIES: Record<QKind, string[]> = {
  written: ['行测·言语理解', '行测·数量关系', '行测·判断推理', '行测·资料分析', '专业知识·法律', '专业知识·金融', '专业知识·财会', '综合知识', '性格测评', '英语', '申论·写作', '公司常识', '其他'],
  interview: ['自我介绍与动机', '经历深挖', '行为面试(BQ)', '专业问题', '情景与压力', '行业与公司认知', '职业规划', '薪酬期望', '反问环节', '英文面试', '其他'],
};

/**
 * 笔面试题库。
 *
 * ## 三层，且只有三层
 *   **分类卡墙 → 分类页（题库卡片墙）→ 题库页（题组 / 单题）**
 *
 * 为什么推翻老版本的「左侧 256px 分类树 + 右侧长列表」：
 *   ① 老布局在 ≤1080px 宽时把整棵分类树用 `.bank-rail-body { display:none }` 藏掉，
 *      而唯一的展开入口只是标题行上一个写着数字的小徽标 —— 找不到，就等于「无法分类和归档」；
 *   ② 一屏里同时塞着树、筛选条、题目列表三种节奏，视线无处落脚；
 *   ③ 点选一条 18px 高的窄行，远不如点整张卡。
 * 卡片墙这套语言全站已有（「网申记录追踪」就是它），直接沿用 `.catc` 一族样式，
 * 不再为题库发明第二套视觉。
 *
 * ## 一场面试 = 一条「题组」
 * 真实素材是「一次 30+ 题的面试问法清单」。逐题建条会让列表炸开、归档变成 30 次点击，
 * 所以整场整篇粘进来就是一个题组：列表上一张卡，展开才是逐题。
 * 题组结构见 lib/qgroup.ts —— 元数据冗余在每道题上，老数据零迁移。
 */
export default function Bank() {
  const {
    questions, banks, bankCategories,
    addCategory, updateCategory, removeCategory, addBank, updateBank, removeBank,
    assignQuestions, addQuestion, addQuestions, updateQuestion, removeQuestion, removeQuestions,
    addQuestionSet, reorderGroup, renameGroup, dissolveGroup, mergeIntoGroup, toast,
  } = useStore();

  const cats = useMemo(() => sortCategories(bankCategories), [bankCategories]);
  const catTone = useMemo(() => {
    const m = new Map<string, string>();
    cats.forEach((c, i) => m.set(c.id, CAT_TONES[i % CAT_TONES.length]));
    return m;
  }, [cats]);

  /* ---- 三级导航 ---- */
  const [catId, setCatId] = useState<string | null>(null);
  const [bankId, setBankId] = useState<string | null>(null);   // NO_BANK = 该分类的「未归档」
  /* 笔试/面试不预设死值：用户没说，就让数据说 —— 全库只有面试题时默认看面试，
     否则点进一个纯面试题库会先看到一屏空白（老版本就是这个毛病）。null = 还没手动选过 */
  const [kindPref, setKindPref] = useState<QKind | null>(null);

  const [q, setQ] = useState('');
  const [onlyUnmastered, setOnlyUnmastered] = useState(false);
  const [openSets, setOpenSets] = useState<Set<string>>(new Set());
  const [expandedQ, setExpandedQ] = useState<string | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [answerBusy, setAnswerBusy] = useState<string | null>(null);
  const [tidyBusy, setTidyBusy] = useState<string | null>(null);

  const [catModal, setCatModal] = useState<Partial<BankCategory> | null>(null);
  const [bankModal, setBankModal] = useState<Partial<QuestionBank> | null>(null);
  const [editing, setEditing] = useState<Partial<Question> | null>(null);
  const [setImport, setSetImport] = useState(false);
  const [importing, setImporting] = useState(false);
  /** 题组命名弹窗：带 ids = 把若干单题合并成一场；带 groupId = 给已有题组改名 */
  const [nameModal, setNameModal] = useState<{ title: string; ids?: string[]; groupId?: string } | null>(null);

  /* 容器被别处删掉时回退，避免停在空白页 */
  useEffect(() => {
    if (catId && !bankCategories.some((c) => c.id === catId)) { setCatId(null); setBankId(null); }
  }, [catId, bankCategories]);
  useEffect(() => {
    if (bankId && bankId !== NO_BANK && !banks.some((b) => b.id === bankId)) setBankId(null);
  }, [bankId, banks]);

  /* ---------- 统计 ---------- */
  /** 仓库属于哪个分类：catId 缺失或指向已删除的分类时统一落到「其他」 */
  const catOfBank = (b: QuestionBank) => (b.catId && cats.some((c) => c.id === b.catId) ? b.catId : FALLBACK_CAT_ID);

  const catStats = useMemo(() => {
    const blank = () => ({ total: 0, written: 0, interview: 0, unmastered: 0, noBank: 0 });
    const m = new Map<string, ReturnType<typeof blank>>();
    cats.forEach((c) => m.set(c.id, blank()));
    questions.forEach((x) => {
      const k = questionCatId(x, banks);
      const cur = m.get(k) || blank();
      cur.total++;
      if (x.kind === 'interview') cur.interview++; else cur.written++;
      if (!x.mastered) cur.unmastered++;
      if (!x.bankId) cur.noBank++;
      m.set(k, cur);
    });
    return m;
  }, [questions, banks, cats]);

  const bankStats = useMemo(() => {
    const blank = () => ({ total: 0, written: 0, interview: 0, unmastered: 0 });
    const m = new Map<string, ReturnType<typeof blank>>();
    questions.forEach((x) => {
      if (!x.bankId) return;
      const cur = m.get(x.bankId) || blank();
      cur.total++;
      if (x.kind === 'interview') cur.interview++; else cur.written++;
      if (!x.mastered) cur.unmastered++;
      m.set(x.bankId, cur);
    });
    return m;
  }, [questions]);

  const banksOfCat = useMemo(() => {
    const m = new Map<string, QuestionBank[]>();
    cats.forEach((c) => m.set(c.id, []));
    banks.forEach((b) => {
      const k = catOfBank(b);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(b);
    });
    return m;
  }, [banks, cats]);

  /* ---------- 当前范围 ---------- */
  const activeCat = cats.find((c) => c.id === catId) || null;
  const activeBank = banks.find((b) => b.id === bankId) || null;

  const scopedCat = useMemo(
    () => (catId ? questions.filter((x) => questionCatId(x, banks) === catId) : questions),
    [questions, banks, catId],
  );
  const scopedAll = useMemo(() => {
    if (!catId) return questions;
    if (bankId === NO_BANK) return scopedCat.filter((x) => !x.bankId);
    if (bankId) return scopedCat.filter((x) => x.bankId === bankId);
    return scopedCat;
  }, [questions, scopedCat, catId, bankId]);

  const kind: QKind = kindPref ?? (scopedAll.some((x) => x.kind === 'written') ? 'written' : 'interview');
  const searching = q.trim().length > 0;

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return scopedAll.filter((x) => {
      if (x.kind !== kind) return false;
      if (onlyUnmastered && x.mastered) return false;
      if (k) return `${x.content} ${x.company || ''} ${x.category} ${x.answer || ''} ${x.groupTitle || ''}`.toLowerCase().includes(k);
      return true;
    });
  }, [scopedAll, kind, onlyUnmastered, q]);

  /** 搜索态：跨全部分类收敛到一个结果集（否则「搜了却还停在空分类里」） */
  const searchHits = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return [];
    return questions.filter((x) =>
      `${x.content} ${x.company || ''} ${x.category} ${x.answer || ''} ${x.groupTitle || ''}`.toLowerCase().includes(k));
  }, [questions, q]);

  const groups = useMemo(() => buildGroups(list), [list]);
  const masteredCount = list.filter((x) => x.mastered).length;

  /** 新题写进来的归属 */
  const targetOf = (): { bankId?: string; catId?: string } => {
    if (activeBank) return { bankId: activeBank.id, catId: catOfBank(activeBank) };
    if (catId) return { catId };
    return {};
  };

  const bankName = (id?: string) => (id ? banks.find((b) => b.id === id)?.name || '题库' : '未归档');

  /* ---------- 导航 ---------- */
  const enterCat = (id: string) => { setCatId(id); setBankId(null); setKindPref(null); setQ(''); exitPick(); };
  const enterBank = (id: string) => { setBankId(id); setKindPref(null); setQ(''); exitPick(); };
  const backToWall = () => { setCatId(null); setBankId(null); setKindPref(null); setQ(''); exitPick(); };
  const toggleSet = (key: string) => setOpenSets((s) => {
    const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n;
  });

  /* ---------- 动作 ---------- */
  const moveMany = (ids: string[], targetBankId?: string, targetCatId?: string) => {
    const n = assignQuestions(ids, targetBankId, targetCatId);
    if (!n) { toast('这些题已经在这里了', 'info'); return; }
    const where = targetBankId ? `「${bankName(targetBankId)}」`
      : targetCatId ? `「${cats.find((c) => c.id === targetCatId)?.name || '分类'}」` : '「未归档」';
    toast(`已移入${where}`, 'ok');
  };

  const genAnswer = async (item: Question) => {
    if (!hasAiKey()) { toast('未配置 API Key，请在设置中填入后使用 AI 参考答案', 'err'); return; }
    setAnswerBusy(item.id);
    try {
      const ans = await aiAnswerQuestion(`${item.category ? `【分类】${item.category}\n` : ''}${item.content}`, item.kind, getAiConfig());
      updateQuestion(item.id, { answer: ans });
      setExpandedQ(item.id);
      toast('AI 参考答案已生成');
    } catch (e) { toast('生成失败：' + (e as Error).message, 'err'); }
    finally { setAnswerBusy(null); }
  };

  /**
   * AI 整理一个题组：规范题干 + 补分类难度 + 重排顺序。
   *
   * **刻意不让 AI 增删题**：它一旦合并，用户写的「我的回答」和掌握状态就没有落脚点了。
   * 所以要求逐题回带原序号，条数对不上就整单作废、原样保留 —— 宁可没整理，不可丢答案。
   */
  const tidyGroup = async (g: QGroup) => {
    if (!hasAiKey()) { toast('未配置 API Key，请在设置中填入后使用 AI 整理', 'err'); return; }
    setTidyBusy(g.key);
    try {
      const sys = '你是面试题库整理助手。给定一场面试的题目清单，请完成四件事：'
        + '① 规范每道题的题干（去掉口语赘词、补齐主语与问句，保留原意，不得改写成另一道题）；'
        + '② 给每道题标一个分类（优先从候选里选）；③ 标难度（易/中/难）；'
        + '④ 按考察逻辑给出更合理的顺序（自我介绍与动机 → 经历深挖 → 专业问题 → 情景与压力 → 职业规划 → 反问）。'
        + '严禁合并、拆分、新增或删除题目，条数必须与输入完全一致。'
        + '只输出 JSON 数组，每项字段：i(该题在输入里的序号，从 1 开始)、t(规范化后的题干)、c(分类)、d(难度)。数组顺序即最终顺序。不要解释。';
      const user = `【题目类型】${g.items[0]?.kind === 'interview' ? '面试' : '笔试'}`
        + `\n【候选分类】${SUGGEST_CATEGORIES[g.items[0]?.kind || 'interview'].join('、')}`
        + `\n【题目清单】\n${g.items.map((x, i) => `${i + 1}. ${x.content}`).join('\n')}`;
      const arr = extractJsonArray(await callAi(getAiConfig(), sys, user, 90000));
      const rows = arr.map((it) => {
        const o = it as Record<string, unknown>;
        return {
          i: Number(o.i ?? o.index),
          t: String(o.t ?? o.content ?? o.question ?? '').trim(),
          c: String(o.c ?? o.category ?? '').trim(),
          d: String(o.d ?? o.difficulty ?? '').trim(),
        };
      }).filter((r) => Number.isFinite(r.i) && r.i >= 1 && r.i <= g.items.length);

      if (rows.length !== g.items.length) {
        toast(`AI 返回 ${rows.length} 条、原题 ${g.items.length} 条，数量对不上，已原样保留`, 'err');
        return;
      }
      const order: string[] = [];
      rows.forEach((r) => {
        const x = g.items[r.i - 1];
        order.push(x.id);
        updateQuestion(x.id, {
          content: r.t || x.content,
          category: r.c || x.category,
          difficulty: (['易', '中', '难'].includes(r.d) ? r.d : x.difficulty) as Question['difficulty'],
        });
      });
      if (g.groupId) reorderGroup(g.groupId, order);
      toast(`已整理「${groupFallbackTitle(g)}」：${order.length} 题`);
    } catch (e) { toast('整理失败：' + (e as Error).message, 'err'); }
    finally { setTidyBusy(null); }
  };

  /* ---------- 批量选择 ---------- */
  const togglePick = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const exitPick = () => { setPickMode(false); setPicked(new Set()); };

  /* ---------- 删除容器（二次确认，强调题不会丢） ---------- */
  const confirmRemoveCat = (c: BankCategory) => {
    const n = catStats.get(c.id)?.total || 0;
    const bn = (banksOfCat.get(c.id) || []).length;
    if (!window.confirm(`删除分类「${c.name}」？\n\n其中的 ${bn} 个题库与 ${n} 道题都不会被删除，会移到「其他」分类。`)) return;
    removeCategory(c.id);
    if (catId === c.id) backToWall();
    toast('已删除分类，内容已移到「其他」', 'info');
  };
  const confirmRemoveBank = (b: QuestionBank) => {
    const n = bankStats.get(b.id)?.total || 0;
    if (!window.confirm(`删除题库「${b.name}」？\n\n其中 ${n} 道题不会被删除，会回到该分类的「未归档」。`)) return;
    removeBank(b.id);
    setBankId(null);
    toast('已删除题库，题目已回到未归档', 'info');
  };

  /* ---------- 落库 ---------- */
  const saveSetImport = (v: { title: string; kind: QKind; catId: string; bankId?: string; unit?: string; items: Partial<Question>[] }) => {
    const { groupId, added } = addQuestionSet(
      v.title,
      v.items.map((it) => ({ ...it, kind: v.kind, company: it.company || v.unit || undefined })),
      { bankId: v.bankId, catId: v.catId },
    );
    setSetImport(false);
    if (!added) { toast('没有解析到有效题目', 'err'); return; }
    setOpenSets((s) => new Set(s).add(`g:${groupId}`));
    setCatId(v.catId); setBankId(v.bankId || NO_BANK); setKindPref(v.kind); setQ('');
    toast(`已把 ${added} 题作为一个场次导入（题组）`);
  };

  /* ==================== 卡片渲染 ==================== */

  /** 题库卡（第二级用）。普通函数而非组件：避免内联组件每次渲染换身份、把 DOM 整棵重挂。 */
  const bankCard = (b: QuestionBank) => {
    const s = bankStats.get(b.id) || { total: 0, written: 0, interview: 0, unmastered: 0 };
    const preview = questions.filter((x) => x.bankId === b.id).slice(0, 3);
    return (
      <div key={b.id} className={cn('catc__card', s.total === 0 && 'catc__card--empty')}
        role="button" tabIndex={0}
        onClick={() => enterBank(b.id)}
        onKeyDown={(e) => { if (e.key === 'Enter') enterBank(b.id); }}
        title={`进入「${b.name}」`}>
        <div className="catc__top">
          <span className="badge__dot badge--info" />
          <span className="catc__name">{b.name}</span>
          <span className="catc__count">{s.total}</span>
          <button className="copy-btn qbank__gear" title="编辑 / 删除题库"
            onClick={(e) => { e.stopPropagation(); setBankModal(b); }}>
            <Icon name="settings" size={11} />
          </button>
        </div>
        <div className="catc__hint tx-4">
          {b.note || (s.total ? `笔试 ${s.written} · 面试 ${s.interview}` : '还没有题目')}
        </div>
        <div className="catc__list">
          {preview.map((x) => (
            <div className="catc__row" key={x.id}>
              <span className="qbank__qline truncate">{brief(x.content, 42)}</span>
            </div>
          ))}
          {!preview.length && <div className="catc__none tx-4">点进去加题，或用「整场导入」</div>}
        </div>
        <div className="catc__more tx-4">共 {s.total} 题{s.unmastered ? ` · 未掌握 ${s.unmastered}` : ''} →</div>
      </div>
    );
  };

  /** 题目卡（题组 / 单题同一套骨架） */
  const renderCard = (g: QGroup, showBank: boolean) => (
    <QuestionCard
      key={g.key}
      g={g}
      open={openSets.has(g.key)}
      onToggle={() => toggleSet(g.key)}
      showBank={showBank}
      cats={cats}
      banks={banks}
      pickMode={pickMode}
      picked={picked}
      togglePick={togglePick}
      pickAll={(on) => setPicked((p) => {
        const n = new Set(p);
        g.items.forEach((x) => { if (on) n.add(x.id); else n.delete(x.id); });
        return n;
      })}
      answerBusy={answerBusy}
      genAnswer={genAnswer}
      expandedQ={expandedQ}
      setExpandedQ={setExpandedQ}
      moveMany={moveMany}
      setEditing={setEditing}
      removeQuestion={removeQuestion}
      updateQuestion={updateQuestion}
      onRename={() => setNameModal({ title: g.title || groupFallbackTitle(g), groupId: g.groupId })}
      onTidy={() => tidyGroup(g)}
      tidyBusy={tidyBusy === g.key}
      onDissolve={() => {
        if (!g.groupId) return;
        if (!window.confirm(`解散题组「${groupFallbackTitle(g)}」？\n\n${g.items.length} 道题都会保留，只是不再成组显示。`)) return;
        dissolveGroup(g.groupId);
        toast('已解散题组，题目全部保留', 'info');
      }}
      onDeleteAll={() => {
        if (!window.confirm(`删除这一场的全部 ${g.items.length} 道题？\n\n此操作不可撤销。`)) return;
        removeQuestions(g.items.map((x) => x.id));
        toast(`已删除 ${g.items.length} 道题`, 'info');
      }}
      onReorder={(id, dir) => {
        if (!g.groupId) return;
        const ids = g.items.map((x) => x.id);
        const at = ids.indexOf(id);
        const to = at + dir;
        if (at < 0 || to < 0 || to >= ids.length) return;
        [ids[at], ids[to]] = [ids[to], ids[at]];
        reorderGroup(g.groupId, ids);
      }}
      onAddChild={(kindOfSet) => setEditing({
        kind: kindOfSet, category: '其他',
        groupId: g.groupId, groupTitle: g.title || undefined,
        bankId: g.items[0]?.bankId, catId: g.items[0]?.catId,
        order: g.items.length,
      })}
    />
  );

  /* ==================== 页面 ==================== */
  let body: React.ReactNode = null;

  if (searching && !bankId) {
    /* ---- 搜索态（不在某个题库里时）：跨全部分类收敛 ----
       在题库内部搜索则**不**跳走，直接就地过滤 —— 否则输入框会随着视图切换被卸载，
       用户每敲一个字就丢一次焦点（这个坑「网申记录追踪」当初也踩过）。 */
    body = (
      <div className="glass card" style={{ padding: 8 }}>
        <div className="catc_back" style={{ padding: '4px 8px 10px' }}>
          <span className="tx-3" style={{ fontSize: 12.5 }}>
            搜索「{q.trim()}」命中 {searchHits.length} 题（跨全部分类与题库）
          </span>
          <span className="grow" />
          <Button size="sm" icon="x" onClick={() => setQ('')}>清除搜索</Button>
        </div>
        {searchHits.length === 0
          ? <div className="tx-4" style={{ padding: '26px 0', textAlign: 'center', fontSize: 13 }}>没有匹配的题目</div>
          : <div className="col gap-8 stagger">{buildGroups(searchHits).map((g) => renderCard(g, true))}</div>}
      </div>
    );
  } else if (!catId) {
    /* ---- 第一级：分类卡片墙 ----
       ★ 即使一道题都没有，卡墙也照常渲染。
       之前这里用一整块 Empty 把卡墙顶掉了，代价是：新账号（或刚清空过数据的账号）
       打开题库只看到一句「题库还是空的」，那十几个预置分类**一张都看不见** ——
       用户的体感正是「没法分类、也没法归档」，因为屏幕上根本没有可点的分类卡。
       现在改成「引导条 + 卡墙」：上一条细提示讲清三步怎么用，下面分类卡照常可点。 */
    const blank = questions.length === 0 && banks.length === 0;
    body = (
      <>
        {blank && (
          <div className="glass card qbank__blank">
            <Icon name="layers" size={15} />
            <span className="qbank__blank-t">题库还是空的</span>
            <span className="tx-3 grow">
              三步就能用起来：① 点下面任意分类卡进入（没有合适的就「新建分类」）；② 在分类下建题库（如「中核集团 2026 秋招 一面」）；③ 点右上「整场导入」，把一整场面试整篇粘贴进来，自动切成一题一条并成一个题组。
            </span>
          </div>
        )}
        <div className="catc">
        {cats.map((c) => {
          const st = catStats.get(c.id) || { total: 0, written: 0, interview: 0, unmastered: 0, noBank: 0 };
          const group = banksOfCat.get(c.id) || [];
          const tone = catTone.get(c.id) || 'badge--accent';
          return (
            <div key={c.id} className={cn('catc__card', st.total === 0 && 'catc__card--empty')}
              role="button" tabIndex={0}
              onClick={() => enterCat(c.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') enterCat(c.id); }}
              title={`查看「${c.name}」的题库`}>
              <div className="catc__top">
                <span className={cn('badge__dot', tone)} />
                <span className={cn('catc__name', tone)}>{c.name}</span>
                <span className="catc__count">{st.total}</span>
                <button className="copy-btn qbank__gear" title={c.presets ? '重命名分类' : '编辑 / 删除分类'}
                  onClick={(e) => { e.stopPropagation(); setCatModal(c); }}>
                  <Icon name={c.presets ? 'edit' : 'settings'} size={11} />
                </button>
              </div>
              <div className="catc__hint tx-4">
                {group.length ? `${group.length} 个题库 · 笔试 ${st.written} · 面试 ${st.interview}` : '还没有题库'}
              </div>
              <div className="catc__list">
                {group.slice(0, 3).map((b) => {
                  const bs = bankStats.get(b.id);
                  return (
                    <div className="catc__row" key={b.id}>
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="catc__co truncate">{b.name}</span>
                        <span className="catc__pos tx-3 truncate">{bs?.total || 0} 题</span>
                      </span>
                      {!!bs?.unmastered && <span className="catc__dl tx-4">未掌握 {bs.unmastered}</span>}
                    </div>
                  );
                })}
                {group.length === 0 && <div className="catc__none tx-4">点进去建第一个题库</div>}
              </div>
              {group.length > 3
                ? <div className="catc__more tx-4">还有 {group.length - 3} 个题库 →</div>
                : group.length > 0 ? <div className="catc__more tx-4">共 {group.length} 个题库 →</div> : null}
              {st.noBank > 0 && <div className="catc__more tx-4">未归档 {st.noBank} 题（待归入题库）</div>}
            </div>
          );
        })}
        <button className="catc__card qbank__newcard" onClick={() => setCatModal({})}>
          <Icon name="plus" size={18} />
          <span>新建分类</span>
        </button>
        </div>
      </>
    );
  } else if (!bankId) {
    /* ---- 第二级：某分类下的题库卡片墙 ---- */
    const st = catStats.get(catId) || { total: 0, written: 0, interview: 0, unmastered: 0, noBank: 0 };
    const group = banksOfCat.get(catId) || [];
    body = (
      <>
        <div className="catc_back">
          <Button size="sm" icon="chevron" onClick={backToWall}>返回全部分类</Button>
          <span className={cn('badge', catTone.get(catId) || 'badge--accent')} style={{ marginLeft: 4 }}>{activeCat?.name}</span>
          <span className="tx-4" style={{ fontSize: 12, marginLeft: 2 }}>
            {group.length} 个题库 · {st.total} 题 · 未掌握 {st.unmastered}
          </span>
          <span className="grow" />
          {/* 分类这一层也要能直接记题：不是每个人都想先建题库 —— 挂不上题库的题会进「未归档」，
              而「未归档」卡只有在有这类题时才出现，所以这里必须留一个入口，否则那个卡永远长不出来。
              「整场导入」不在这儿重复一份：顶栏已经有了，同屏两个同名主按钮只会让人犹豫点哪个。 */}
          <Button size="sm" icon="plus" onClick={() => setEditing({ kind, category: '其他', catId })}>加一题（挂分类下）</Button>
        </div>
        <div className="catc">
          {group.map((b) => bankCard(b))}
          {st.noBank > 0 && (
            <div className="catc__card" role="button" tabIndex={0}
              onClick={() => enterBank(NO_BANK)}
              onKeyDown={(e) => { if (e.key === 'Enter') enterBank(NO_BANK); }}
              title="还没归入任何题库的题">
              <div className="catc__top">
                <span className="badge__dot badge--warn" />
                <span className={cn('catc__name', 'badge--warn')}>未归档</span>
                <span className="catc__count">{st.noBank}</span>
              </div>
              <div className="catc__hint tx-4">这些题还没归入题库 · 点进去勾选即可归档</div>
              <div className="catc__list">
                {scopedCat.filter((x) => !x.bankId).slice(0, 3).map((x) => (
                  <div className="catc__row" key={x.id}>
                    <span className="qbank__qline truncate">{brief(x.content, 42)}</span>
                  </div>
                ))}
              </div>
              <div className="catc__more tx-4">共 {st.noBank} 题 →</div>
            </div>
          )}
          <button className="catc__card qbank__newcard" onClick={() => setBankModal({ catId })}>
            <Icon name="plus" size={18} />
            <span>新建题库</span>
          </button>
        </div>
      </>
    );
  } else {
    /* ---- 第三级：题库（或未归档）里的题目 ---- */
    const title = activeBank ? activeBank.name : '未归档';
    const kindCount = (k: QKind) => scopedAll.filter((x) => x.kind === k).length;
    /* 本库里是否已经有题组：一道都没有才提示「合并成一场」（已有题组时这话就多余了） */
    const hasSets = scopedAll.some((x) => !!x.groupId);
    body = (
      <>
        <div className="catc_back">
          <Button size="sm" icon="chevron" onClick={() => { setBankId(null); setKindPref(null); exitPick(); }}>返回题库列表</Button>
          <span className={cn('badge', activeBank ? 'badge--info' : 'badge--warn')} style={{ marginLeft: 4 }}>{title}</span>
          <span className="tx-4" style={{ fontSize: 12 }}>
            {scopedAll.length} 题 · 未掌握 {scopedAll.filter((x) => !x.mastered).length}
            {activeBank ? ` · 属「${cats.find((c) => c.id === activeBank.catId)?.name || '其他'}」` : ' · 还没归入题库'}
          </span>
          <span className="grow" />
          {activeBank && (
            <MoreMenu title="题库设置" items={[
              { icon: 'edit', text: '改名 / 改分类', onClick: () => setBankModal(activeBank) },
              { icon: 'trash', text: '删除题库', danger: true, onClick: () => confirmRemoveBank(activeBank) },
            ]} />
          )}
        </div>

        {bankId === NO_BANK && scopedAll.length > 0 && (
          <div className="glass card" style={{ padding: '10px 14px', marginBottom: 12 }}>
            <div className="row gap-8 wrap" style={{ alignItems: 'center' }}>
              <Icon name="inbox" size={15} />
              <span className="tx-3" style={{ fontSize: 12.5 }}>
                这些题还没归入题库 —— 勾选后点目标题库即可归档。
              </span>
              <span className="grow" />
              <Button size="sm" icon="check" onClick={() => setPickMode(true)}>批量归入…</Button>
            </div>
          </div>
        )}

        {/* 全是散题时主动提一句「可以合并成一场」。
            存在的理由：老数据的题是一道一道进来的（比如同一家央企面试的 35 个问题），
            在列表里就是 35 张卡，看着像「题目被拆碎了」—— 用户根本不知道还能成组，
            只能逐题点开。这里给出唯一一条出路，且默认用「分类名 › 题库名」当标题。 */}
        {!pickMode && !hasSets && scopedAll.length >= 2 && (
          <div className="glass card qbank__blank" style={{ marginBottom: 12 }}>
            <Icon name="layers" size={15} />
            <span className="qbank__blank-t">这 {scopedAll.length} 题还是散的</span>
            <span className="tx-3 grow">
              如果它们是同一场面试或同一套卷，合并成一个题组后列表只占一张卡，点开才是逐题（顺序还能调）。
            </span>
            <Button size="sm" icon="layers"
              onClick={() => setNameModal({ title: activeBank?.name || '', ids: scopedAll.map((x) => x.id) })}>
              合并成一场
            </Button>
          </div>
        )}

        <div className="row gap-8 wrap" style={{ marginBottom: 12, alignItems: 'center' }}>
          <Segmented value={kind} onChange={(v) => { setKindPref(v); }}
            options={[
              { value: 'written', label: `笔试 ${kindCount('written')}`, icon: 'edit' },
              { value: 'interview', label: `面试 ${kindCount('interview')}`, icon: 'video' },
            ]} />
          {/* 掌握度原本是旁边一枚独立统计胶囊，说的和「只看未掌握」是同一件事 —— 并进按钮里：
              点它就是筛，不关心数字时它也不额外占地方。 */}
          <button className={cn('badge', onlyUnmastered ? 'badge--accent' : 'badge--muted')}
            style={{ cursor: 'pointer', padding: '4px 10px' }}
            title={`已掌握 ${masteredCount} / ${list.length}，点击只看未掌握`}
            onClick={() => setOnlyUnmastered((v) => !v)}>
            {onlyUnmastered && <Icon name="check" size={11} />} 只看未掌握
            <span style={{ opacity: .6, marginLeft: 3 }}>{masteredCount}/{list.length}</span>
          </button>
          <span className="grow" />
          {!pickMode && list.length > 0 && (
            <Button size="sm" variant="ghost" icon="check" onClick={() => setPickMode(true)}>批量</Button>
          )}
          {/* 导入全站只留顶栏「导入 ▾」一份，这里不再放第二个入口 */}
          <Button size="sm" icon="plus" onClick={() => setEditing({ kind, category: '其他', ...targetOf() })}>加一题</Button>
        </div>

        {pickMode && (
          <div className="glass card fade" style={{ marginBottom: 12, padding: '10px 14px' }}>
            <div className="row gap-8 wrap" style={{ alignItems: 'center' }}>
              <span className="badge badge--accent" style={{ padding: '4px 10px' }}>已选 {picked.size}</span>
              <Button size="sm" onClick={() => setPicked(new Set(list.map((x) => x.id)))}>全选当前 {list.length} 题</Button>
              <Button size="sm" onClick={() => setPicked(new Set())}>清空</Button>
              {picked.size >= 2 && (
                <Button size="sm" icon="layers" onClick={() => setNameModal({ title: '', ids: [...picked] })}>合并为一场</Button>
              )}
              <span className="tx-4" style={{ fontSize: 11.5 }}>
                {picked.size ? '移入 →' : '先点卡片勾选要移动的题目，再点目标 →'}
              </span>
            </div>
            <div className="row gap-6 wrap" style={{ marginTop: 8 }}>
              {cats.map((c) => {
                const group = banksOfCat.get(c.id) || [];
                return (
                  <React.Fragment key={c.id}>
                    <Button size="sm" disabled={!picked.size} onClick={() => { moveMany([...picked], undefined, c.id); exitPick(); }}>
                      仅改分类 · {c.name}
                    </Button>
                    {group.map((b) => (
                      <Button key={b.id} size="sm" disabled={!picked.size}
                        onClick={() => { moveMany([...picked], b.id, c.id); exitPick(); }}>
                        {c.name} / {b.name}
                      </Button>
                    ))}
                  </React.Fragment>
                );
              })}
              <Button size="sm" disabled={!picked.size} onClick={() => { moveMany([...picked]); exitPick(); }}>未归档</Button>
              <Button size="sm" variant="ghost" icon="x" onClick={exitPick} aria-label="退出批量模式" />
            </div>
          </div>
        )}

        {list.length === 0 ? (
          <div className="glass card">
            <Empty icon="layers"
              title={scopedAll.length === 0
                ? (activeBank ? `「${activeBank.name}」里还没有题` : '这里还没有题')
                : `没有${kind === 'written' ? '笔试题' : '面试题'}符合当前筛选`}
              desc={scopedAll.length === 0
                ? '推荐用上面那枚「整场导入」：把一整场面试的问法整篇粘贴进来，会自动切成一题一条、并作为一个题组显示在列表里。只想记一道就用「加一题」。'
                : '试试切到另一个笔试/面试标签，或清掉「只看未掌握」。'}
              action={<Button variant="primary" icon="plus" onClick={() => setEditing({ kind, category: '其他', ...targetOf() })}>加一题</Button>} />
          </div>
        ) : (
          <div className="col gap-12 stagger">
            {groups.map((g) => renderCard(g, false))}
          </div>
        )}
      </>
    );
  }

  /* ---- 顶栏 ---- */
  const headTitle = activeBank ? activeBank.name : activeCat ? activeCat.name : '笔试面试题库';
  const headDesc = activeBank
    ? (activeBank.note || `属「${cats.find((c) => c.id === activeBank.catId)?.name || '其他'}」 · 共 ${scopedAll.length} 题`)
    : activeCat
      ? `${(banksOfCat.get(activeCat.id) || []).length} 个题库 · ${(catStats.get(activeCat.id)?.total || 0)} 题`
      : `共 ${questions.length} 题 · ${banks.length} 个题库 · ${cats.length} 个分类`;

  return (
    <div className="rise">
      <div className="section-head">
        <div style={{ minWidth: 0 }}>
          <div className="section-head__t">{headTitle}</div>
          <div className="section-head__d">{headDesc}</div>
        </div>
        <div className="row gap-8 wrap">
          <div className="search"><Icon name="search" size={16} />
            <input className="input input--sm" style={{ width: 180 }} placeholder="搜索题目/单位…"
              value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <MoreMenu label="导入" icon="upload" align="right" items={[
            { icon: 'layers', text: '整场导入 · 一场面试 / 一套卷', onClick: () => setSetImport(true) },
            { icon: 'doc', text: '逐题导入 · JSON 文件 / 粘贴', onClick: () => setImporting(true) },
          ]} />
          <Button variant="primary" icon="plus"
            onClick={() => { if (activeCat) setBankModal({ catId: activeCat.id }); else setCatModal({}); }}>
            {activeCat ? '新建题库' : '新建分类'}
          </Button>
        </div>
      </div>

      {body}

      {catModal && (
        <CategoryModal data={catModal} onClose={() => setCatModal(null)}
          onSave={(v) => {
            if (!v.name?.trim()) { toast('分类名称不能为空', 'err'); return; }
            if (v.id) { updateCategory(v.id, { name: v.name.trim() }); toast('已更新分类'); }
            else { const c = addCategory(v); setCatId(c.id); setBankId(null); toast(`已创建分类「${c.name}」`); }
            setCatModal(null);
          }}
          onDelete={catModal.id ? () => { confirmRemoveCat(catModal as BankCategory); setCatModal(null); } : undefined} />
      )}

      {bankModal && (
        <BankModal data={bankModal} categories={cats} onClose={() => setBankModal(null)}
          onSave={(v) => {
            if (!v.name?.trim()) { toast('题库名称不能为空', 'err'); return; }
            if (v.id) {
              updateBank(v.id, v);
              /* 题库换了分类、而用户正站在它里面：跟着它走。
                 否则当前 scopedAll 会立刻变空 —— 页面看着像「题目全没了」，
                 其实题好好的，只是被一个过时的分类筛选挡住了。 */
              if (v.catId && bankId === v.id) setCatId(v.catId);
              toast('已更新题库');
            } else {
              const b = addBank(v);
              toast(`已创建「${b.name}」`);
              setCatId(catOfBank(b)); setBankId(b.id); setKindPref(null);
            }
            setBankModal(null);
          }} />
      )}

      {editing && (
        <QuestionModal data={editing} categories={cats} banks={banks} onClose={() => setEditing(null)}
          onSave={(v) => {
            if (!v.content?.trim()) { toast('题目内容不能为空', 'err'); return; }
            if (editing.id) { updateQuestion(editing.id, v); toast('已更新题目'); }
            else { addQuestion(v); toast(v.groupId ? '已加入题组' : '已添加题目'); }
            setEditing(null);
          }} />
      )}

      {setImport && (
        <SetImportModal cats={cats} banks={banks}
          defaultCat={catId || cats[0]?.id || FALLBACK_CAT_ID}
          defaultBank={activeBank?.id || (bankId && bankId !== NO_BANK ? bankId : '')}
          defaultKind={kind} onClose={() => setSetImport(false)} onSubmit={saveSetImport} />
      )}

      {importing && (
        <ImportModal defaultKind={kind} currentCat={catId || undefined} onClose={() => setImporting(false)}
          onImportJson={(file) => { importJsonFile(file, banks, cats, targetOf(), toast, addQuestions); setImporting(false); }}
          onImportText={(items) => {
            const cur = targetOf();
            const n = addQuestions(items.map((it) => ({ ...it, bankId: it.bankId ?? cur.bankId, catId: it.catId ?? cur.catId ?? FALLBACK_CAT_ID })));
            setImporting(false);
            toast(n ? `已导入 ${n} 道题目` : '没有解析到有效题目', n ? 'ok' : 'err');
          }} />
      )}

      {nameModal && (
        <SetMetaModal data={nameModal}
          count={nameModal.ids?.length || 0}
          onClose={() => setNameModal(null)}
          onSave={(title) => {
            if (!title.trim()) { toast('题组名称不能为空', 'err'); return; }
            if (nameModal.ids) {
              mergeIntoGroup(title.trim(), nameModal.ids);
              exitPick();
              toast(`已把 ${nameModal.ids.length} 道题合并为一场`);
            } else if (nameModal.groupId) {
              renameGroup(nameModal.groupId, title.trim());
              toast('题组已重命名');
            }
            setNameModal(null);
          }} />
      )}
    </div>
  );
}

/* ==================== 题目卡（题组 / 单题同一套骨架） ==================== */
type CardProps = {
  g: QGroup;
  open: boolean;
  onToggle: () => void;
  showBank: boolean;
  cats: BankCategory[];
  banks: QuestionBank[];
  pickMode: boolean;
  picked: Set<string>;
  togglePick: (id: string) => void;
  pickAll: (on: boolean) => void;
  answerBusy: string | null;
  genAnswer: (q: Question) => void;
  expandedQ: string | null;
  setExpandedQ: (id: string | null) => void;
  moveMany: (ids: string[], bankId?: string, catId?: string) => void;
  setEditing: (q: Partial<Question>) => void;
  removeQuestion: (id: string) => void;
  updateQuestion: (id: string, patch: Partial<Question>) => void;
  onRename: () => void;
  onTidy: () => void;
  tidyBusy: boolean;
  onDissolve: () => void;
  onDeleteAll: () => void;
  onReorder: (id: string, dir: -1 | 1) => void;
  onAddChild: (kind: QKind) => void;
};

function QuestionCard(p: CardProps) {
  const { g } = p;
  const first = g.items[0];
  const own = p.banks.find((b) => b.id === first.bankId);
  const ownCat = p.cats.find((c) => c.id === (own?.catId || first.catId));
  const allMastered = g.items.every((x) => x.mastered);
  const somePicked = g.items.some((x) => p.picked.has(x.id));

  return (
    <div className="glass" style={{
      padding: g.isSet ? 13 : 12, borderRadius: 16,
      opacity: !g.isSet && first.mastered ? .72 : 1,
      outline: p.pickMode && somePicked ? '1.5px solid var(--accent-1)' : 'none',
    }}>
      {/* ---- 题组头 ---- */}
      {g.isSet && (
        <div className="row gap-8" style={{ alignItems: 'center' }}>
          {p.pickMode && (
            <button className={cn('badge', somePicked ? 'badge--accent' : 'badge--muted')}
              style={{ cursor: 'pointer', padding: '5px 9px', flexShrink: 0 }}
              title="勾选整组" onClick={() => p.pickAll(!somePicked)}>
              <Icon name={somePicked ? 'check' : 'plus'} size={12} />
            </button>
          )}
          <button className={cn('badge', allMastered ? 'badge--ok' : 'badge--muted')}
            style={{ cursor: 'pointer', padding: '5px 9px', flexShrink: 0 }}
            title={allMastered ? '整组已掌握，点击取消' : '整组标记为已掌握'}
            onClick={() => { const next = !allMastered; g.items.forEach((x) => p.updateQuestion(x.id, { mastered: next })); }}>
            <Icon name="check" size={12} />
          </button>
          <button className="row gap-8 grow" style={{ textAlign: 'left', minWidth: 0, alignItems: 'center' }}
            onClick={p.onToggle} title={p.open ? '收起' : '展开这一场的题目'}>
            <Icon name={p.open ? 'chevron' : 'chevronR'} size={13} />
            <span className="h-sub truncate" style={{ fontSize: 13.5 }}>{groupFallbackTitle(g)}</span>
            <span className="badge badge--accent" style={{ padding: '2px 8px', flexShrink: 0 }}>{g.items.length} 题</span>
            {g.unmastered > 0 && <span className="badge badge--warn" style={{ padding: '2px 8px', flexShrink: 0 }}>未掌握 {g.unmastered}</span>}
            {first.company && <span className="badge badge--info" style={{ padding: '2px 8px', flexShrink: 0 }}>{first.company}</span>}
            {first.year && <span className="badge badge--muted" style={{ padding: '2px 8px', flexShrink: 0 }}>{first.year}</span>}
          </button>
          <div className="row gap-6" style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
            {/* 整组这一层就两枚图标：AI 整理 + ⋯。
                AI 单独留一枚是因为它是这一场唯一的「非归档类」动作，也是导入完 30 题后
                最该发现的下一步 —— 全塞进 ⋯ 里，用户不会知道自己还能让 AI 收拾这一场。
                其余（加一题 / 改名 / 移动 / 解散 / 删除整组）全在 ⋯，其中两个是破坏性的。 */}
            <Button size="sm" variant="ghost" icon="sparkles"
              className={cn('btn--ai', p.tidyBusy && 'btn--ai-busy')} disabled={p.tidyBusy}
              title={p.tidyBusy ? 'AI 整理中…' : 'AI 整理这一场：重排顺序 · 规范题干 · 补分类难度'}
              aria-label="AI 整理这一场" onClick={p.onTidy} />
            <MoreMenu title="题组操作">
              {(close) => (
                <>
                  <button className="bank-item" onClick={() => { close(); p.onAddChild(g.items[0]?.kind || 'interview'); }}>
                    <Icon name="plus" size={13} /><span className="grow truncate">在本题组加一题</span>
                  </button>
                  <button className="bank-item" onClick={() => { close(); p.onRename(); }}>
                    <Icon name="edit" size={13} /><span className="grow truncate">改题组名</span>
                  </button>
                  <div className="moremenu__sep" />
                  <MoveMenuBody cats={p.cats} banks={p.banks} atBankId={first.bankId}
                    onMove={(bankId, catId) => { close(); p.moveMany(g.items.map((x) => x.id), bankId, catId); }} />
                  <div className="moremenu__sep" />
                  <button className="bank-item" onClick={() => { close(); p.onDissolve(); }}>
                    <Icon name="layers" size={13} /><span className="grow truncate">解散题组（题目保留）</span>
                  </button>
                  <button className="bank-item bank-item--danger" onClick={() => { close(); p.onDeleteAll(); }}>
                    <Icon name="trash" size={13} /><span className="grow truncate">删除整组</span>
                  </button>
                </>
              )}
            </MoreMenu>
          </div>
        </div>
      )}

      {/* ---- 折叠时的预览 ---- */}
      {g.isSet && !p.open && (
        <div className="qset__preview">
          {g.items.slice(0, 2).map((x, i) => (
            <div className="qset__pline" key={x.id}>
              <span className="qset__pno">{i + 1}</span>
              <span className="truncate">{brief(x.content, 60)}</span>
            </div>
          ))}
          {g.items.length > 2 && <div className="qset__pmore tx-4">还有 {g.items.length - 2} 题 →</div>}
        </div>
      )}

      {/* ---- 单题：直接铺开 ---- */}
      {!g.isSet && (
        <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
          {p.pickMode && (
            <button className={cn('badge', p.picked.has(first.id) ? 'badge--accent' : 'badge--muted')}
              style={{ cursor: 'pointer', padding: '5px 9px', marginTop: 1, flexShrink: 0 }}
              onClick={() => p.togglePick(first.id)} aria-label="选择题目">
              <Icon name={p.picked.has(first.id) ? 'check' : 'plus'} size={12} />
            </button>
          )}
          <button className={cn('badge', first.mastered ? 'badge--ok' : 'badge--muted')}
            style={{ cursor: 'pointer', padding: '5px 9px', marginTop: 1, flexShrink: 0 }}
            title={first.mastered ? '已掌握，点击取消' : '标记为已掌握'}
            onClick={() => p.updateQuestion(first.id, { mastered: !first.mastered })}>
            <Icon name="check" size={12} />
          </button>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row gap-6 wrap" style={{ marginBottom: 5 }}>
              <Badge tone="badge--accent">{first.category}</Badge>
              {p.showBank && (own
                ? <Badge tone="badge--muted">{ownCat ? ownCat.name + '·' : ''}{own.name}</Badge>
                : <Badge tone="badge--warn">未归档</Badge>)}
              {first.company && <Badge tone="badge--info">{first.company}</Badge>}
              {first.year && <Badge tone="badge--muted">{first.year}</Badge>}
              {first.difficulty && <Badge tone={DIFF_META[first.difficulty]}>{first.difficulty}</Badge>}
              {first.mastered && <Badge tone="badge--ok">已掌握</Badge>}
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.7, fontWeight: 600, whiteSpace: 'pre-wrap' }}>{first.content}</div>
            {p.expandedQ === first.id && <AnswerBlock item={first} />}
          </div>
          <div className="row gap-6" style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
            <Button size="sm" variant="ghost" icon={p.expandedQ === first.id ? 'chevron' : 'chevronR'}
              onClick={() => p.setExpandedQ(p.expandedQ === first.id ? null : first.id)}
              title="展开 / 收起参考答案" aria-label="展开答案" />
            {/* 这是「不成组的独立一题」，右侧和题组头一样：✨ 与 ⋯ 都常驻。
                ⚠️ 这里绝不能再套 .qset__hover：那条显隐规则写作 `.qset__item:hover .qset__hover`，
                而这张卡没有 .qset__item 祖先 —— 套上就是桌面端**永久隐身**（opacity 恒为 0），
                只有 ≤720px 的媒体查询会把它放出来。真实踩过：用户截图问「为什么这题没有 AI 按钮」。
                程序化 click 对 opacity:0 的元素照样生效，所以光靠「点得到」测不出这种 bug。 */}
            <Button size="sm" variant="ghost" icon="sparkles" className="btn--ai"
              disabled={p.answerBusy === first.id}
              onClick={() => p.genAnswer(first)} title="AI 参考答案" aria-label="AI 参考答案" />
            <MoreMenu title="更多操作">
              {(close) => (
                <>
                  <button className="bank-item" onClick={() => { close(); p.setEditing(first); }}>
                    <Icon name="edit" size={13} /><span className="grow truncate">编辑这道题</span>
                  </button>
                  <div className="moremenu__sep" />
                  <MoveMenuBody cats={p.cats} banks={p.banks} atBankId={first.bankId}
                    onMove={(bankId, catId) => { close(); p.moveMany([first.id], bankId, catId); }} />
                  <div className="moremenu__sep" />
                  <button className="bank-item bank-item--danger" onClick={() => { close(); p.removeQuestion(first.id); }}>
                    <Icon name="trash" size={13} /><span className="grow truncate">删除这道题</span>
                  </button>
                </>
              )}
            </MoreMenu>
          </div>
        </div>
      )}

      {/* ---- 题组展开后的逐题 ---- */}
      {g.isSet && p.open && (
        <div className="qset__body">
          {g.items.map((x, i) => (
            <div className="qset__item" key={x.id}>
              {p.pickMode ? (
                <button className={cn('badge', p.picked.has(x.id) ? 'badge--accent' : 'badge--muted')}
                  style={{ cursor: 'pointer', padding: '5px 9px', flexShrink: 0 }}
                  onClick={() => p.togglePick(x.id)} aria-label="选择题目">
                  <Icon name={p.picked.has(x.id) ? 'check' : 'plus'} size={12} />
                </button>
              ) : <span className="qset__no">{i + 1}</span>}
              <button className={cn('badge', x.mastered ? 'badge--ok' : 'badge--muted')}
                style={{ cursor: 'pointer', padding: '5px 9px', flexShrink: 0 }}
                title={x.mastered ? '已掌握，点击取消' : '标记为已掌握'}
                onClick={() => p.updateQuestion(x.id, { mastered: !x.mastered })}>
                <Icon name="check" size={12} />
              </button>
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{x.content}</div>
                <div className="row gap-6 wrap" style={{ marginTop: 4 }}>
                  {x.category && <Badge tone="badge--accent">{x.category}</Badge>}
                  {x.difficulty && <Badge tone={DIFF_META[x.difficulty]}>{x.difficulty}</Badge>}
                  {x.answer && <Badge tone="badge--ok">有参考答案</Badge>}
                </div>
                {p.expandedQ === x.id && <AnswerBlock item={x} />}
              </div>
              <div className="row gap-6" style={{ flexShrink: 0 }}>
                <Button size="sm" variant="ghost" icon={p.expandedQ === x.id ? 'chevron' : 'chevronR'}
                  onClick={() => p.setExpandedQ(p.expandedQ === x.id ? null : x.id)}
                  title="展开 / 收起参考答案" aria-label="展开答案" />
                {/* ✨ 常驻：一行里唯一的「生成类」动作，藏起来用户就不知道这题能一键出参考答案。
                    只有 ⋯（编辑 / 上移 / 下移 / 移动 / 删除，清一色归档类低频动作）留在
                    .qset__hover 里 —— 「30 题 × 5 枚图标糊满右边缘」那个老问题由它兜住。 */}
                <Button size="sm" variant="ghost" icon="sparkles" className="btn--ai"
                  disabled={p.answerBusy === x.id}
                  onClick={() => p.genAnswer(x)} title="AI 参考答案" aria-label="AI 参考答案" />
                <div className="row gap-6 qset__hover">
                  <MoreMenu title="更多操作">
                    {(close) => (
                      <>
                        <button className="bank-item" onClick={() => { close(); p.setEditing(x); }}>
                          <Icon name="edit" size={13} /><span className="grow truncate">编辑这道题</span>
                        </button>
                        <button className="bank-item" onClick={() => { close(); p.onReorder(x.id, -1); }}>
                          <Icon name="chevron" size={13} /><span className="grow truncate">上移一位</span>
                        </button>
                        <button className="bank-item" onClick={() => { close(); p.onReorder(x.id, 1); }}>
                          <Icon name="chevronR" size={13} /><span className="grow truncate">下移一位</span>
                        </button>
                        <div className="moremenu__sep" />
                        <MoveMenuBody cats={p.cats} banks={p.banks} atBankId={x.bankId}
                          onMove={(bankId, catId) => { close(); p.moveMany([x.id], bankId, catId); }} />
                        <div className="moremenu__sep" />
                        <button className="bank-item bank-item--danger" onClick={() => { close(); p.removeQuestion(x.id); }}>
                          <Icon name="trash" size={13} /><span className="grow truncate">删除这道题</span>
                        </button>
                      </>
                    )}
                  </MoreMenu>
                </div>
              </div>
            </div>
          ))}

          {/* 底部工具行整行撤销：AI 整理与加一题都并进了题组头右侧。
              题组卡现在只有两层 —— 标题行 + 逐题，底下不再有一道虚线切出来的第三层。 */}
        </div>
      )}
    </div>
  );
}

/* 一条题目的参考答案块（题组内与单题共用）
 *
 * 为什么走 RichText 而不是直接 {item.answer}：AI 吐出来的是带 Markdown 记号的文本
 * （`**1. xxx**`），原先当纯文本渲染，页面上就是一排排裸露的 `**`，既不好看也看不出层次。
 * RichText 会把加粗、编号、「答案：/解析：」标签渲染出来，层级自然就有了。
 */
function AnswerBlock({ item }: { item: Question }) {
  return (
    <div className="fade ans-blk">
      <div className="ans-blk__head">
        <Icon name="sparkles" size={12} />
        <span>参考答案</span>
      </div>
      {item.answer
        ? <div className="ans-blk__body"><RichText text={item.answer} /></div>
        : <div className="tx-4 ans-blk__empty">暂无答案，可点右侧星标按钮生成 AI 参考答案。</div>}
      {item.analysis && (
        <div className="ans-blk__sub">
          <div className="ans-blk__subhead">解析</div>
          <div className="ans-blk__body"><RichText text={item.analysis} /></div>
        </div>
      )}
    </div>
  );
}

/* ==================== ⋯ 更多菜单 ==================== */

type MoreItem = { icon: string; text: string; danger?: boolean; onClick: () => void };

/**
 * 通用「⋯」更多菜单。
 *
 * 存在的理由：这一页原本是「每个层级都把所有动作平铺出来」——
 * 题组头并排着「移动 / 展开」，单题行更是一排 6 枚图标（上移 / 下移 / 展开 / AI / 编辑 / 删除），
 * 其中删除、解散、删除整组这些破坏性操作，离正文右侧不到 10px。一屏 30 题 = 150 个图标。
 * 收进 ⋯ 之后一步仍可达，但视线里只剩真正该看的东西。
 *
 * children 是 render-prop：里面嵌的「移动到哪个题库」是动态内容，
 * 点完同样要收起菜单，所以把 close 交给调用方而不是替它猜。
 */
function MoreMenu({ items, children, label, icon = 'more', title, align = 'right' }:
  { items?: MoreItem[]; children?: (close: () => void) => React.ReactNode;
    label?: string; icon?: string; title?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxH: number } | null>(null);
  const btnRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  /* 坐标在 useLayoutEffect 里算：layout effect 里的 setState 会在浏览器绘制前跑完，
     所以菜单不会先在错位置闪一下再跳过去。 */
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 236, GAP = 6, PAD = 8;
    const left = Math.min(Math.max(PAD, r.right - W), Math.max(PAD, window.innerWidth - W - PAD));
    const below = window.innerHeight - r.bottom - GAP - PAD;
    const above = r.top - GAP - PAD;
    /* EST 只用来决定朝哪边展开，不参与最终高度 —— 最终高度永远由可用空间卡住，
       否则菜单会像之前那样一路捅出视口底部，「删除整组」永远滚不到。 */
    const EST = 340;
    setPos(below < EST && above > below
      ? { left, bottom: window.innerHeight - r.top + GAP, maxH: Math.max(150, above) }
      : { left, top: r.bottom + GAP, maxH: Math.max(150, below) });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    /* 菜单是 fixed 的，页面一滚坐标就失效了（会「漂」在原地），直接收起最省事也最不意外 */
    const onAway = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onAway);
    window.addEventListener('scroll', onAway, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onAway);
      window.removeEventListener('scroll', onAway, true);
    };
  }, [open]);

  const tip = title || label || '更多操作';
  return (
    <>
      <div ref={btnRef} style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
        <Button size={label ? undefined : 'sm'} variant="ghost" icon={icon}
          title={tip} aria-label={tip} aria-expanded={open}
          onClick={() => setOpen((v) => !v)}>{label}</Button>
      </div>
      {open && pos && createPortal(
        <div ref={popRef} className={cn('glass', 'card', 'fade', 'moremenu')}
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}>
          {items?.map((it) => (
            <button key={it.text} className={cn('bank-item', it.danger && 'bank-item--danger')}
              onClick={() => { setOpen(false); it.onClick(); }}>
              <Icon name={it.icon} size={13} />
              <span className="grow truncate">{it.text}</span>
            </button>
          ))}
          {children?.(() => setOpen(false))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** 移动菜单的**内容**（不含浮层本体）：分类 → 题库两级，一次点击到位（题组会整组移动）。
 *  抽成纯内容是因为它嵌在 ⋯ 里 —— 定位、滚动、「点外部关闭」都交给 MoreMenu 统一管，
 *  否则会出现「菜单里又套一层自己的关闭逻辑」的重复。
 *
 *  默认折成一行摘要：移动目标数 = 分类数 × 各自的题库数，条目数随资料量增长 ——
 *  7 个分类就能把它撑到十几行，把「改题组名 / 解散 / 删除整组」全挤出屏幕。 */
function MoveMenuBody({ cats, banks, atBankId, onMove }:
  { cats: BankCategory[]; banks: QuestionBank[]; atBankId?: string;
    onMove: (bankId?: string, catId?: string) => void }) {
  const [open, setOpen] = useState(false);
  const inCat = (b: QuestionBank, cid: string) => (b.catId && cats.some((c) => c.id === b.catId) ? b.catId === cid : cid === FALLBACK_CAT_ID);

  if (!open) {
    return (
      <button className="bank-item" style={{ width: '100%' }} onClick={() => setOpen(true)}>
        <Icon name="inbox" size={13} />
        <span className="grow truncate">移动到其他题库</span>
        <Icon name="chevronR" size={12} />
      </button>
    );
  }

  return (
    <>
      <div className="moremenu__sec">移动到</div>
      <button className={cn('bank-item', !atBankId && 'bank-item--on')} style={{ width: '100%' }}
        disabled={!atBankId} onClick={() => onMove(undefined, undefined)}>
        <Icon name="inbox" size={13} /><span className="grow truncate">未归档</span>
        {!atBankId && <Icon name="check" size={12} />}
      </button>
      {cats.map((c) => (
        <div key={c.id}>
          <div className="moremenu__sec">{c.name}</div>
          <button className="bank-item" style={{ width: '100%' }} onClick={() => onMove(undefined, c.id)}>
            <Icon name="project" size={13} /><span className="grow truncate">仅改分类（不归题库）</span>
          </button>
          {banks.filter((b) => inCat(b, c.id)).map((b) => (
            <button key={b.id} className={cn('bank-item', atBankId === b.id && 'bank-item--on')}
              style={{ width: '100%' }} disabled={atBankId === b.id}
              onClick={() => onMove(b.id, c.id)}>
              <Icon name="archive" size={13} />
              <span className="grow truncate">{b.name}</span>
              {atBankId === b.id && <Icon name="check" size={12} />}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

/* ==================== 弹窗 ==================== */

/** 新建 / 编辑分类 */
function CategoryModal({ data, onClose, onSave, onDelete }:
  { data: Partial<BankCategory>; onClose: () => void; onSave: (c: Partial<BankCategory>) => void; onDelete?: () => void }) {
  const [form, setForm] = useState<Partial<BankCategory>>(data);
  return (
    <Modal open onClose={onClose} icon="project" title={data.id ? '编辑分类' : '新建分类'}
      footer={<>
        {onDelete && !data.presets && <Button variant="danger" icon="trash" onClick={onDelete}>删除</Button>}
        <span className="grow" />
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="check" onClick={() => onSave(form)}>保存</Button>
      </>}>
      <div className="col gap-14">
        <div className="field"><label className="field__label">分类名称 <span className="field__req">*</span></label>
          <input className="input" value={form.name || ''} placeholder="如 国央企 / 银行 / 券商基金"
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          <div className="field__hint">
            分类是题库最外层那一张卡。分类下面建题库（如「国央企」→「中核集团 2026 秋招 一面」），题目放在题库里。
          </div></div>
      </div>
    </Modal>
  );
}

/** 新建 / 编辑题库：一个题库 ≈ 一家单位的一次招聘 / 一场考试 */
function BankModal({ data, categories, onClose, onSave }:
  { data: Partial<QuestionBank>; categories: BankCategory[]; onClose: () => void; onSave: (b: Partial<QuestionBank>) => void }) {
  const [form, setForm] = useState<Partial<QuestionBank>>(data);
  return (
    <Modal open onClose={onClose} icon="archive" title={data.id ? '编辑题库' : '新建题库'}
      footer={<><Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="check" onClick={() => onSave(form)}>保存</Button></>}>
      <div className="col gap-14">
        <div className="field"><label className="field__label">所属分类 <span className="field__req">*</span></label>
          <select className="select" value={form.catId || FALLBACK_CAT_ID} onChange={(e) => setForm((f) => ({ ...f, catId: e.target.value }))}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div className="field__hint">换分类时，题库里的题会一起跟着换，不会走散。</div></div>
        <div className="field"><label className="field__label">题库名称 <span className="field__req">*</span></label>
          <input className="input" value={form.name || ''} placeholder="如 中核集团 2026 秋招 一面 / 建设银行笔试"
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
        <div className="field"><label className="field__label">备注（可空）</label>
          <input className="input" value={form.note || ''} placeholder="如 一面半结构化，主要问经历与专业问题"
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} /></div>
      </div>
    </Modal>
  );
}

/** 单题表单（在题组里加题时会带上 groupId / order） */
function QuestionModal({ data, categories, banks, onClose, onSave }:
  { data: Partial<Question>; categories: BankCategory[]; banks: QuestionBank[];
    onClose: () => void; onSave: (q: Partial<Question>) => void }) {
  const { toast } = useStore();
  const [form, setForm] = useState<Partial<Question>>(data);
  const [busy, setBusy] = useState<null | 'answer' | 'analysis' | 'meta'>(null);
  const set = (k: keyof Question, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const kd = (form.kind || 'written') as QKind;
  const banksOfCat = banks.filter((b) => (b.catId || FALLBACK_CAT_ID) === (form.catId || FALLBACK_CAT_ID));

  const aiReady = (needContent = true) => {
    if (!hasAiKey()) { toast('未配置 API Key，请到「设置 → AI」填入后再用', 'err'); return false; }
    if (needContent && !(form.content || '').trim()) { toast('请先填写题目内容，AI 才知道要答什么', 'err'); return false; }
    return true;
  };

  const genAnswer = async () => {
    if (!aiReady()) return;
    setBusy('answer');
    try {
      const ans = await aiAnswerQuestion(`${form.category ? `【分类】${form.category}\n` : ''}${form.content}`, kd, getAiConfig());
      setForm((f) => ({ ...f, answer: ans }));
      toast('已生成参考答案');
    } catch (e) { toast('生成失败：' + (e as Error).message, 'err'); }
    finally { setBusy(null); }
  };

  const genAnalysis = async () => {
    if (!aiReady()) return;
    setBusy('analysis');
    try {
      const ctx = `【题型】${kd === 'interview' ? '面试题' : '笔试题'}\n【分类】${form.category || '未分类'}\n【题目】${form.content}`
        + (form.answer ? `\n【已有参考答案】${form.answer.slice(0, 800)}` : '');
      const out = await aiAssist(
        '针对上面这道题写一份备考解析/复盘笔记：① 考察点 ② 答题思路（分点、可操作） ③ 容易被追问或失分的地方。'
        + '直接输出正文，不要重复完整答案，不要用 Markdown 标题符号。', ctx, getAiConfig());
      setForm((f) => ({ ...f, analysis: out }));
      toast('已生成解析');
    } catch (e) { toast('生成失败：' + (e as Error).message, 'err'); }
    finally { setBusy(null); }
  };

  const genMeta = async () => {
    if (!aiReady()) return;
    setBusy('meta');
    try {
      const sys = '你是题库整理助手。根据题目判定分类、单位、难度。只输出一个 JSON 对象，不要解释。'
        + '字段：category(分类，优先从给定候选中选)、company(题目中提到的单位，没有则空字符串)、difficulty(易/中/难)。';
      const user = `【题目类型】${kd === 'written' ? '笔试' : '面试'}\n【候选分类】${SUGGEST_CATEGORIES[kd].join('、')}\n【题目】${form.content}`;
      const o = extractJsonObject(await callAi(getAiConfig(), sys, user, 30000));
      if (!o) { toast('AI 没返回可解析的结果，请重试', 'err'); return; }
      const diff = String(o.difficulty || '');
      setForm((f) => ({
        ...f,
        category: o.category ? String(o.category) : f.category,
        company: o.company ? String(o.company) : f.company,
        difficulty: (['易', '中', '难'] as string[]).includes(diff) ? diff as Question['difficulty'] : f.difficulty,
      }));
      toast('已识别分类 / 单位 / 难度');
    } catch (e) { toast('识别失败：' + (e as Error).message, 'err'); }
    finally { setBusy(null); }
  };

  return (
    <Modal open onClose={onClose} wide icon="edit"
      title={data.id ? '编辑题目' : (data.groupId ? '在本题组里加一题' : '添加题目')}
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" icon="check" onClick={() => onSave(form)}>保存</Button></>}>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="field"><label className="field__label">题目类型</label>
          <Segmented size="sm" value={form.kind || 'written'} onChange={(v) => set('kind', v)}
            options={[{ value: 'written', label: '笔试题' }, { value: 'interview', label: '面试题' }]} /></div>
        <div className="field"><label className="field__label">题目分类</label>
          <input className="input" list="q-cats" value={form.category || ''} placeholder="选择或输入新分类"
            onChange={(e) => set('category', e.target.value)} />
          <datalist id="q-cats">{SUGGEST_CATEGORIES[kd].map((c) => <option key={c} value={c} />)}</datalist></div>
        <div className="field"><label className="field__label">所属分类（赛道）</label>
          <select className="select" value={form.catId || FALLBACK_CAT_ID}
            onChange={(e) => setForm((f) => ({ ...f, catId: e.target.value, bankId: undefined }))}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
        <div className="field"><label className="field__label">归入题库（可空 = 直接挂在分类下）</label>
          <select className="select" value={form.bankId || ''} onChange={(e) => setForm((f) => ({ ...f, bankId: e.target.value || undefined }))}>
            <option value="">（不归入题库）</option>
            {banksOfCat.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select></div>
        <div className="field"><label className="field__label">单位（可空）</label>
          <input className="input" value={form.company || ''} placeholder="如 中核集团" onChange={(e) => set('company', e.target.value)} /></div>
        <div className="field"><label className="field__label">年份 / 场次（可空）</label>
          <input className="input" value={form.year || ''} placeholder="如 2026 秋招一面" onChange={(e) => set('year', e.target.value)} /></div>
        <div className="field"><label className="field__label">难度</label>
          <div className="row gap-6">
            {(['易', '中', '难'] as const).map((d) => (
              <button key={d} className={cn('badge', form.difficulty === d ? DIFF_META[d] : 'badge--muted')}
                style={{ cursor: 'pointer', padding: '5px 14px' }}
                onClick={() => set('difficulty', form.difficulty === d ? '' : d)}>{d}</button>
            ))}
          </div></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label className="field__label">题目内容 <span className="field__req">*</span></label>
          <textarea className="textarea" style={{ minHeight: 90 }} value={form.content || ''} onChange={(e) => set('content', e.target.value)} />
          <div className="row gap-8 wrap" style={{ marginTop: 8, alignItems: 'center' }}>
            <span className="field__hint">题干写好后，可让 AI 自动识别并回填上面的「分类 / 单位 / 难度」</span>
            <AiBtn label="AI 识别分类·单位·难度" busyLabel="识别中…" busy={busy === 'meta'} onClick={genMeta} />
          </div></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label className="field__label">答案 / 参考回答（可空）
            <AiBtn label="AI 生成参考答案" busyLabel="生成中…" busy={busy === 'answer'} onClick={genAnswer} />
          </label>
          <textarea className="textarea" style={{ minHeight: 80 }} value={form.answer || ''}
            placeholder="可留空，点右上「AI 生成参考答案」由 AI 写；也可以自己写或改"
            onChange={(e) => set('answer', e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label className="field__label">解析 / 面试经验笔记（可空）
            <AiBtn label="AI 生成解析" busyLabel="生成中…" busy={busy === 'analysis'} onClick={genAnalysis} />
          </label>
          <textarea className="textarea" style={{ minHeight: 64 }} value={form.analysis || ''}
            placeholder="如：考察点、答题思路、面试官追问方向…（也可点上方按钮让 AI 先写一版）"
            onChange={(e) => set('analysis', e.target.value)} /></div>
      </div>
    </Modal>
  );
}

/** 题组改名 / 把若干单题合并成一场 */
function SetMetaModal({ data, count, onClose, onSave }:
  { data: { title: string; ids?: string[]; groupId?: string }; count: number;
    onClose: () => void; onSave: (title: string) => void }) {
  const [title, setTitle] = useState(data.title || '');
  const merging = !!data.ids;
  return (
    <Modal open onClose={onClose} icon="layers" title={merging ? '合并为一场' : '题组改名'}
      footer={<><Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="check" onClick={() => onSave(title)}>保存</Button></>}>
      <div className="col gap-14">
        <div className="field"><label className="field__label">题组名称 <span className="field__req">*</span></label>
          <input className="input" value={title} placeholder="如 中核集团 2026 秋招 一面"
            onChange={(e) => setTitle(e.target.value)} />
          <div className="field__hint">
            {merging
              ? `选中的 ${count} 道题会合成一个题组，在列表上只占一张卡；题目本身一道都不会少。`
              : '题组名就是列表上那一行标题，建议写「单位 + 场次」。'}
          </div></div>
      </div>
    </Modal>
  );
}

/* ---------------- AI 归类（整场导入用） ---------------- */
async function aiClassifyItems(texts: string[], kind: QKind): Promise<Partial<Question>[]> {
  const out: Partial<Question>[] = [];
  const BATCH = 20;
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
    const sys = '你是题库整理助手。为每道题目判定分类、单位、难度。只输出 JSON 数组，'
      + '每项字段：index(题目序号,从0开始),category(分类,优先从给定候选中选),company(题目中提到的单位,没有则空字符串),difficulty(易/中/难)。不要解释。';
    const user = `【题目类型】${kind === 'written' ? '笔试' : '面试'}\n【候选分类】${SUGGEST_CATEGORIES[kind].join('、')}`
      + `\n【题目列表】\n${chunk.map((t, j) => `[${j}] ${t.slice(0, 200)}`).join('\n')}`;
    try {
      const raw = await callAi(getAiConfig(), sys, user, 60000);
      const arr = extractJsonArray(raw);
      const meta = new Map<number, Record<string, unknown>>();
      arr.forEach((it) => {
        const o = it as Record<string, unknown>;
        const idx = Number(o.index);
        if (!Number.isNaN(idx)) meta.set(idx, o);
      });
      chunk.forEach((content, j) => {
        const m = meta.get(j);
        out.push({
          kind, content,
          category: m?.category ? String(m.category) : '其他',
          company: m?.company ? String(m.company) : undefined,
          difficulty: ['易', '中', '难'].includes(String(m?.difficulty || ''))
            ? String(m!.difficulty) as Question['difficulty'] : undefined,
        });
      });
    } catch {
      chunk.forEach((content) => out.push({ kind, content, category: '其他' }));
    }
  }
  return out;
}

/** 从题组标题里粗提单位名，作为「单位」输入框的默认值（用户可改，改错了也只是个冗余字段） */
function guessUnit(title: string): string {
  const t = (title || '').trim();
  if (!t) return '';
  const m = t.match(/^([^\s·,，(_（【\-—]{2,20})/);
  return m ? m[1] : '';
}

/* ---------------- 整场导入：一场面试 / 一套卷，整篇粘贴 ---------------- */
function SetImportModal({ cats, banks, defaultCat, defaultBank, defaultKind, onClose, onSubmit }:
  { cats: BankCategory[]; banks: QuestionBank[]; defaultCat: string; defaultBank: string; defaultKind: QKind;
    onClose: () => void;
    onSubmit: (v: { title: string; kind: QKind; catId: string; bankId?: string; unit?: string; items: Partial<Question>[] }) => void }) {
  const { toast } = useStore();
  const [title, setTitle] = useState('');
  const [unit, setUnit] = useState('');
  const [kind, setKind] = useState<QKind>(defaultKind);
  const [catId, setCatId] = useState(defaultCat);
  const [bankId, setBankId] = useState(defaultBank);
  const [raw, setRaw] = useState('');
  const [useAi, setUseAi] = useState(true);
  const [busy, setBusy] = useState(false);

  const parts = useMemo(() => splitRawText(raw), [raw]);
  const banksOfCat = banks.filter((b) => (b.catId || FALLBACK_CAT_ID) === catId);

  const submit = async () => {
    if (!parts.length) { toast('请先把面试题整篇粘贴进来', 'err'); return; }
    setBusy(true);
    try {
      let items: Partial<Question>[] = parts.map((content) => ({ kind, content, category: '其他' }));
      if (useAi && hasAiKey()) items = await aiClassifyItems(parts, kind);
      onSubmit({
        title: title.trim() || `未命名题组（${parts.length} 题）`,
        kind, catId, bankId: bankId || undefined, unit: unit.trim() || undefined, items,
      });
    } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} wide icon="layers" title="整场导入（一场面试 / 一套卷）"
      footer={<><Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="upload" disabled={busy || !parts.length} onClick={submit}>
          {busy ? 'AI 归类中…' : `导入 ${parts.length} 题`}
        </Button></>}>
      <div className="col gap-14">
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="field"><label className="field__label">题组名称 <span className="field__req">*</span></label>
            <input className="input" value={title} placeholder="如 中核集团 2026 秋招 一面"
              onChange={(e) => { setTitle(e.target.value); if (!unit) setUnit(guessUnit(e.target.value)); }} /></div>
          <div className="field"><label className="field__label">单位（写到每道题上，可空）</label>
            <input className="input" value={unit} placeholder="如 中核集团" onChange={(e) => setUnit(e.target.value)} /></div>
          <div className="field"><label className="field__label">题目类型</label>
            <Segmented size="sm" value={kind} onChange={setKind}
              options={[{ value: 'written', label: '笔试' }, { value: 'interview', label: '面试' }]} /></div>
          <div className="field"><label className="field__label">归属分类 / 题库</label>
            <div className="row gap-8">
              <select className="select grow" value={catId} onChange={(e) => { setCatId(e.target.value); setBankId(''); }}>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select className="select grow" value={bankId} onChange={(e) => setBankId(e.target.value)}>
                <option value="">（不归入题库）</option>
                {banksOfCat.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="field__hint">选「不归入题库」也不会丢题，它们会落在该分类的「未归档」里。</div></div>
        </div>

        <div className="field">
          <label className="field__label">整篇粘贴题目 <span className="field__req">*</span></label>
          <textarea className="textarea" style={{ minHeight: 220 }} value={raw}
            placeholder={'把整场面试的问法直接粘进来，不用自己排版。例如：\n\n1. 请先做个自我介绍\n2. 为什么选择我们单位\n3. 你做过的最有挑战的一件事是什么\n\n（空行会分段、编号行会断开成新题；每行一题也能识别）'}
            onChange={(e) => setRaw(e.target.value)} />
          <div className="row gap-8 wrap" style={{ marginTop: 8, alignItems: 'center' }}>
            <span className={cn('badge', parts.length ? 'badge--ok' : 'badge--muted')} style={{ padding: '4px 10px' }}>
              已识别 {parts.length} 题
            </span>
            <button className={cn('badge', useAi ? 'badge--accent' : 'badge--muted')}
              style={{ cursor: 'pointer', padding: '4px 10px' }} onClick={() => setUseAi((v) => !v)}>
              {useAi && <Icon name="check" size={11} />} <Icon name="sparkles" size={11} />
              AI 归类{useAi && !hasAiKey() ? '（未配置 Key，将归入「其他」）' : ''}
            </button>
            <span className="grow" />
            <span className="field__hint">导入后作为一个题组显示在列表里，展开才是逐题。</span>
          </div>
          {parts.length > 0 && (
            <div className="glass" style={{ marginTop: 10, padding: 12, borderRadius: 12 }}>
              <div className="tx-4" style={{ fontSize: 11, marginBottom: 6 }}>切题预览（前 8 条）</div>
              <div className="col gap-4">
                {parts.slice(0, 8).map((t, i) => (
                  <div className="row gap-8" key={i} style={{ fontSize: 12.5 }}>
                    <span className="qset__no">{i + 1}</span>
                    <span className="grow tx-2">{brief(t, 70)}</span>
                  </div>
                ))}
                {parts.length > 8 && <div className="tx-4" style={{ fontSize: 11.5 }}>还有 {parts.length - 8} 题…</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- JSON 文件导入（沿用老格式，兼容已有素材） ---------------- */
function importJsonFile(file: File, banks: QuestionBank[], cats: BankCategory[],
  cur: { bankId?: string; catId?: string },
  toast: (m: string, k?: 'ok' | 'err' | 'info') => void,
  addQuestions: (qs: Partial<Question>[]) => number) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(String(r.result));
      const arr: unknown[] = Array.isArray(d) ? d : Array.isArray(d.questions) ? d.questions : [];
      /* 归属解析顺序：bankId 命中 → 题库名命中 → 分类名命中 → 当前范围。
         都没命中就留空，题会落到「未归档」，不因为容器不存在而丢题。 */
      const resolve = (o: Record<string, unknown>): { bankId?: string; catId?: string } => {
        const byId = o.bankId != null ? String(o.bankId) : '';
        if (byId) { const hit = banks.find((b) => b.id === byId); if (hit) return { bankId: hit.id, catId: hit.catId }; }
        const byName = o.bank != null ? String(o.bank) : (o.bankName != null ? String(o.bankName) : '');
        if (byName) { const hit = banks.find((b) => b.name === byName); if (hit) return { bankId: hit.id, catId: hit.catId }; }
        const catName = o.cat != null ? String(o.cat) : (o.categoryName != null ? String(o.categoryName) : '');
        if (catName) { const hit = cats.find((c) => c.name === catName); if (hit) return { catId: hit.id }; }
        if (o.catId != null && cats.some((c) => c.id === String(o.catId))) return { catId: String(o.catId) };
        return cur;
      };
      const items = arr.map((it) => {
        const o = it as Record<string, unknown>;
        const s = (k: string) => (o[k] != null ? String(o[k]) : undefined);
        const own = resolve(o);
        return {
          kind: (o.kind === 'interview' ? 'interview' : 'written') as QKind,
          category: s('category') || '其他',
          content: s('content') || s('question') || '',
          answer: s('answer'), analysis: s('analysis'), company: s('company'), year: s('year'),
          difficulty: (['易', '中', '难'].includes(s('difficulty') || '') ? s('difficulty') : undefined) as Question['difficulty'],
          bankId: own.bankId, catId: own.catId,
          groupId: s('groupId'), groupTitle: s('groupTitle'),
        };
      });
      const n = addQuestions(items);
      toast(n ? `已导入 ${n} 道题目` : '文件中没有有效题目（需包含 content 字段）', n ? 'ok' : 'err');
    } catch { toast('导入失败：JSON 格式错误', 'err'); }
  };
  r.readAsText(file);
}

/* ---------------- 批量导入弹窗（JSON 文件 / 多行粘贴，逐题铺开不成组） ---------------- */
function ImportModal({ defaultKind, currentCat, onClose, onImportJson, onImportText }:
  { defaultKind: QKind; currentCat?: string; onClose: () => void;
    onImportJson: (f: File) => void; onImportText: (items: Partial<Question>[]) => void }) {
  const { toast } = useStore();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<QKind>(defaultKind);
  const [busy, setBusy] = useState(false);
  const [useAi, setUseAi] = useState(true);

  const doImport = async () => {
    const items = splitRawText(text);
    if (!items.length) { toast('请先粘贴题目文本', 'err'); return; }
    if (useAi && hasAiKey()) {
      setBusy(true);
      try { onImportText(await aiClassifyItems(items, kind)); }
      finally { setBusy(false); }
    } else {
      if (useAi && !hasAiKey()) toast('未配置 API Key，已按「其他」分类导入，可后续手动调整', 'info');
      onImportText(items.map((content) => ({ kind, content, category: '其他' })));
    }
  };

  return (
    <Modal open onClose={onClose} wide icon="upload" title="导入题目（逐题铺开，不成组）"
      footer={<><Button onClick={onClose}>取消</Button>
        <Button variant="primary" icon="upload" disabled={busy} onClick={doImport}>{busy ? 'AI 归类中…' : '导入'}</Button></>}>
      <div className="col gap-12">
        <div className="glass" style={{ padding: 14, borderRadius: 16 }}>
          <div className="card__title" style={{ fontSize: 13.5, marginBottom: 8 }}><Icon name="doc" size={15} /> 方式一：导入 JSON 文件</div>
          <div className="field__hint" style={{ marginBottom: 8 }}>
            数组格式，每题字段：content(必填)、kind(written/interview)、category、answer、analysis、company、year、difficulty(易/中/难)；
            再加 <span className="mono">bank</span>（题库名）或 <span className="mono">cat</span>（分类名）可指定归入位置。
            对不上会先落到「未归档」，不会丢题。
          </div>
          <label className="btn btn--sm" style={{ cursor: 'pointer' }}>
            <Icon name="upload" size={14} /> 选择 JSON 文件
            <input type="file" accept="application/json,.json" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onImportJson(f); }} />
          </label>
        </div>

        <div className="divider" />

        <div>
          <div className="card__title" style={{ fontSize: 13.5, marginBottom: 8 }}><Icon name="edit" size={15} /> 方式二：粘贴文本（自动切题）</div>
          <div className="row gap-8 wrap" style={{ marginBottom: 8 }}>
            <Segmented size="sm" value={kind} onChange={setKind}
              options={[{ value: 'written', label: '导入到笔试' }, { value: 'interview', label: '导入到面试' }]} />
            <button className={cn('badge', useAi ? 'badge--accent' : 'badge--muted')}
              style={{ cursor: 'pointer', padding: '4px 10px' }} onClick={() => setUseAi((v) => !v)}>
              {useAi && <Icon name="check" size={11} />} <Icon name="sparkles" size={11} />
              AI 自动归类{useAi && !hasAiKey() ? '（未配置 Key，将归入「其他」）' : ''}
            </button>
            {currentCat && <span className="tx-4" style={{ fontSize: 11.5 }}>导入到当前所在的范围</span>}
          </div>
          <textarea className="textarea" style={{ minHeight: 200 }} value={text}
            placeholder={'每行一题或整篇粘进来都可以，会自动切题，例如：\n1. 中金公司 2026 笔试：下列属于要约邀请的是？\n2. 请谈谈你对注册制的理解'}
            onChange={(e) => setText(e.target.value)} />
          <div className="field__hint" style={{ marginTop: 6 }}>
            这种是「逐题铺开、不成组」的导入。想让一场面试只占一张卡，用上面的「整场导入」。
          </div>
        </div>
      </div>
    </Modal>
  );
}
