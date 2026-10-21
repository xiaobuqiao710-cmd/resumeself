import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StoreProvider, useStore, type CloudBoot } from './store/store';
import { supabase, INITIAL_RECOVERY, SUPABASE_CONFIGURED } from './lib/supabase';
import { loadCloudState } from './lib/cloudState';
import Login from './components/modules/Login';
import SetPassword from './components/modules/SetPassword';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { Toaster, Button, Modal, Segmented } from './components/ui/Kit';
import { Icon } from './components/ui/Icon';
import Dashboard from './components/modules/Dashboard';
import { DemoBanner } from './lib/demoMode';

/* 其余板块按需懒加载：首屏只下载概览（原先是单个 649KB 大包一次拉全）。
   加载器统一放在 lib/modules.ts —— 与「空闲预取」共用同一批 import，保证 chunk 只产出一份，
   预取过的板块离线也能打开。 */
const Database = React.lazy(MODULE_LOADERS.Database);
const Applications = React.lazy(MODULE_LOADERS.Applications);
const Jobs = React.lazy(MODULE_LOADERS.Jobs);
const Bank = React.lazy(MODULE_LOADERS.Bank);
const Calendar = React.lazy(MODULE_LOADERS.Calendar);
const MailCenter = React.lazy(MODULE_LOADERS.MailCenter);
const Resume = React.lazy(MODULE_LOADERS.Resume);
const Insights = React.lazy(MODULE_LOADERS.Insights);
const Offers = React.lazy(MODULE_LOADERS.Offers);
const Interviews = React.lazy(MODULE_LOADERS.Interviews);
const Checklist = React.lazy(MODULE_LOADERS.Checklist);
const Versions = React.lazy(MODULE_LOADERS.Versions);
const Contacts = React.lazy(MODULE_LOADERS.Contacts);

import { pingBridge, fetchMe, getBridgeUrl, setBridgeUrl, getBridgeToken, setBridgeToken, DEFAULT_BRIDGE } from './lib/mail';
import { getAiConfig, setAiConfig, testAiConnection, testSearchConnection, AI_PROVIDERS, detectProvider, DEFAULT_AI, aiErrorKind } from './lib/ai';
import { getWebdavConfig, setWebdavConfig, testWebdav, pushBackup, pullBackup, WEBDAV_PROVIDERS, detectWebdavProvider, davErrorKind, DEFAULT_SYNC_DOC } from './lib/webdav';
import { cn, download, todayISO, copyText } from './lib/util';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { CommandPalette } from './components/ui/CommandPalette';
import { AgentPanel } from './components/ui/AgentPanel';
import { SkinMarket } from './components/ui/SkinMarket';
import { skinDef } from './lib/skins';
import { Guide, guideSeen, markGuideSeen } from './components/ui/Guide';
import { TabBar } from './components/layout/TabBar';
import { NAV_GROUPS, groupOf, VIEW_INFO, type NavGroupDef } from './components/layout/nav';
import { ReminderBar } from './components/layout/ReminderBar';
import { SyncStatus } from './components/ui/SyncStatus';
import { listSnapshots, readSnapshot, removeSnapshot, saveSnapshot, clearSnapshots, localUsage, topKeys, fmtBytes, LOCAL_QUOTA_CHARS, type Snapshot } from './lib/backup';
import { getSyncDocPath } from './lib/webdav';
import { isAutoSyncOn, setAutoSyncOn } from './lib/autosync';
import { ensureNotifyPermission } from './lib/remind';
import { buildICS, deadlinesToIcsEvents, jobsToMarkdown, jobsToCSV, applicationsToCSV } from './lib/exporters';
import { MODULE_LOADERS } from './lib/modules';
import type { MailAccount, ViewId } from './types';

/* 这两个弹窗按需加载：不要把 44KB 的岗位库模块拖进首屏包（同样复用统一加载器） */
const JobsImportModal = React.lazy(() => MODULE_LOADERS.JobsImport().then((m) => ({ default: m.JobsImportModal })));
const JobsSyncModal = React.lazy(() => MODULE_LOADERS.Jobs().then((m) => ({ default: m.JobsSyncModal })));
/* 从本机文件导入（.md / .json / .csv / .ics → 自动路由到各板块）也走按需加载 */
const FileImportModal = React.lazy(() => MODULE_LOADERS.FileImport().then((m) => ({ default: m.FileImportModal })));

/* 顶部标题由 nav.ts 派生：t = 主入口名，c = 当前标签的说明（标签本身由 TabBar 呈现，不重复） */
const TITLES: Record<string, { t: string; c: string }> = Object.fromEntries(
  Object.entries(VIEW_INFO).map(([id, v]) => [id, { t: v.groupLabel, c: v.desc }]),
);

function Shell({ userEmail, onLogout }: { userEmail?: string; onLogout?: () => void }) {
  const { view, setView, skin, exportAll, importAll, resetAll, toast,
    remind, setRemind, jobs, applications, allEvents,
    interviews, offers, materials, contacts, questions, importMerge,
    cloud, pushToCloud, enableCloud, storageKey, storageUnsaved, storageCleanupTick } = useStore();
  const [online, setOnline] = useState(false);
  const [account, setAccount] = useState<MailAccount | null>(null);
  const [unread, setUnread] = useState(0);
  const [mobileNav, setMobileNav] = useState(false);
  const [settings, setSettings] = useState(false);
  /**
   * 配额告警里的「打开备份与清理」→ store 把 storageCleanupTick +1 → 这里展开设置面板。
   * 展开的是设置弹窗本身（用户找的就是「设置 → 数据与备份」），
   * 而不是再做一个只给配额用的专用弹窗：导出备份、清快照、看大项都在这一个地方，
   * 两套界面迟早会分叉。
   */
  useEffect(() => {
    if (!storageCleanupTick) return;
    setSettings(true);
  }, [storageCleanupTick]);
  /* 皮肤市场：做成独立弹窗而不是塞进设置的分页里。
     换皮肤是「看一眼、换一个、再看一眼」的行为，埋在设置第三层分页里就完全没法比较了。 */
  const [skinMkt, setSkinMkt] = useState(false);
  const [autoSync, setAutoSync] = useState(isAutoSyncOn());
  const [bridgeInput, setBridgeInput] = useState(getBridgeUrl());
  const [tokenInput, setTokenInput] = useState(getBridgeToken());
  const [paletteOpen, setPaletteOpen] = useState(false);
  /* 「设置 → 数据与备份」里也能直接导入秋招信息（那是用户最自然的入口） */
  const [jobsSyncOpen, setJobsSyncOpen] = useState(false);
  const [jobsImportOpen, setJobsImportOpen] = useState(false);
  const [jobsImportText, setJobsImportText] = useState('');
  const [jobsImportLabel, setJobsImportLabel] = useState<string | undefined>(undefined);
  /* 「数据与备份」里的「从本机文件导入」：吃 .md/.json/.csv/.ics，自动路由到全站各板块 */
  const [fileImportOpen, setFileImportOpen] = useState(false);
  /* AI 助手右栏：记住开关状态；窄屏（<1180px）自动退回浮窗，避免三列挤坏内容 */
  const [agentOpen, setAgentOpen] = useState(() => { try { return localStorage.getItem('qz.agentOpen') === '1'; } catch { return false; } });
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1180);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 1180);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const toggleAgent = useCallback(() => {
    setAgentOpen((v) => { try { localStorage.setItem('qz.agentOpen', v ? '0' : '1'); } catch { /* ignore */ } return !v; });
  }, []);
  /* 右栏宽度：可拖拽调整并记住（用户明确反馈过「右栏不能伸缩」）。
     上限跟着窗口走，保证主区至少还有 640px，否则内容会被挤成一条。 */
  const [agentW, setAgentW] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('qz.agentW'));
      return v >= 320 && v <= 760 ? v : 384;
    } catch { return 384; }
  });
  const resizeAgent = useCallback((w: number) => {
    setAgentW(w);
    try { localStorage.setItem('qz.agentW', String(w)); } catch { /* ignore */ }
  }, []);
  const agentDocked = agentOpen && wide;
  const [stab, setStab] = useState<'cloud' | 'look' | 'bridge' | 'ai' | 'data'>(userEmail ? 'cloud' : 'look');
  const [pwdOpen, setPwdOpen] = useState(false);

  /* 新手指南：首次进站自动弹一次，之后只从顶栏 ⓘ 或设置里进。
     延迟 800ms 再弹 —— 让首屏先把骨架画出来，否则弹窗出现时背后还在 loading，观感像卡住。
     guideSeen() 读不到 localStorage 时（隐私模式）按「看过了」处理，宁可不弹也不要每次刷新都弹。 */
  const [guide, setGuide] = useState(false);
  useEffect(() => {
    if (guideSeen()) return;
    const t = setTimeout(() => { setGuide(true); markGuideSeen(); }, 800);
    return () => clearTimeout(t);
  }, []);

  /* 「数据与备份」里的存储体检放在 ⑥ 区块（那里能看到分项），见下方 usage */
  /* 记住每个主入口上次看的标签：点侧边栏「求职进程」会回到你上次看的「投递记录」 */
  const [tabMemory, setTabMemory] = useState<Record<string, ViewId>>({});
  const goTo = useCallback((v: ViewId) => {
    setView(v);
    const g = groupOf(v);
    setTabMemory((m) => (m[g.id] === v ? m : { ...m, [g.id]: v }));
  }, [setView]);
  const openGroup = useCallback((g: NavGroupDef) => {
    const remembered = tabMemory[g.id];
    const target = remembered && g.tabs.some((t) => t.id === remembered) ? remembered : g.tabs[0].id;
    goTo(target);
  }, [tabMemory, goTo]);
  /* 侧边栏与页内标签共用同一套角标统计 */
  const badgeOf = useCallback((id: ViewId): number => {
    /* 必须用本地日期：原先用 `new Date().toISOString().slice(0,10)`（UTC），
       东八区 00:00–08:00 之间 UTC 还停在前一天，「日程 / 待跟进」角标会比侧边栏少一天。 */
    const today = todayISO();
    switch (id) {
      case 'applications': return applications.filter((a) => !['offer', 'reject'].includes(a.status)).length;
      case 'calendar': return allEvents.filter((e) => e.date === today).length;
      case 'jobs': return jobs.filter((j) => j.status === 'new' || j.status === 'interested').length;
      case 'bank': return questions.filter((q) => !q.mastered).length;
      case 'interviews': return interviews.filter((i) => i.result === 'pending').length;
      case 'offers': return offers.filter((o) => o.status === 'considering').length;
      case 'checklist': return materials.filter((m) => !m.done).length;
      case 'contacts': return contacts.filter((c) => c.nextFollowUp && c.nextFollowUp <= today).length;
      default: return 0;
    }
  }, [applications, allEvents, jobs, questions, interviews, offers, materials, contacts]);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  /* 打开设置就把快照列表读出来：否则「清理全部快照」要等用户先点一次「查看快照」才出现 */
  useEffect(() => { if (settings) setSnaps(listSnapshots()); }, [settings]);
  /* 存储体检：打开设置时算一次。必须**分项**列出 —— 配额几乎总是被「快照」吃掉的
     （一份快照 = 一份完整全量状态），只报总数看不出该删什么。
     依赖 snaps 是为了「清理全部快照」后数字立刻刷新。 */
  const usage = useMemo(() => localUsage(storageKey), [settings, storageKey, snaps]);
  /* 占用前几大项：配额被吃光时「已用 10MB」是没法行动的，得让用户看见是谁吃的 */
  const bigKeys = useMemo(() => topKeys(5), [settings, snaps]);
  const [aiInput, setAiInput] = useState(getAiConfig());
  const [aiTest, setAiTest] = useState<{ st: 'idle' | 'busy' | 'ok' | 'fail'; msg: string }>({ st: 'idle', msg: '' });
  const [searchTest, setSearchTest] = useState<{ st: 'idle' | 'busy' | 'ok' | 'fail'; msg: string }>({ st: 'idle', msg: '' });
  const [modelManual, setModelManual] = useState(false);
  const [wdInput, setWdInput] = useState(getWebdavConfig());
  const [wdBusy, setWdBusy] = useState<'idle' | 'test' | 'push' | 'pull'>('idle');
  const [wdMsg, setWdMsg] = useState<{ st: 'ok' | 'fail'; text: string } | null>(null);

  const refreshBridge = useCallback(async () => {
    const ok = await pingBridge();
    setOnline(ok);
    if (ok) { try { setAccount(await fetchMe()); } catch { /* ignore */ } }
    else { setAccount(null); setUnread(0); }
  }, []);

  useEffect(() => {
    refreshBridge();
    const t = setInterval(refreshBridge, 15000);
    return () => clearInterval(t);
  }, [refreshBridge]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((v) => !v); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const doExport = () => { download(`秋招网申数据-${new Date().toISOString().slice(0, 10)}.json`, exportAll()); toast('已导出全部数据'); };

  /**
   * ⭐「先导出再清理」：给配额满的用户一个不会做错顺序的入口。
   *
   * 为什么不能只写提示：告警让用户「先导出、再清理」，可导出与清理分散在设置的三四个小节里，
   * 用户很容易先点了清理。而清快照腾不出位置说明大头在数据本身 —— 那更要先落盘。
   *
   * 顺序在浏览器里是**保证得住的**：`download()` 是 a[href=blob] + click，同步触发、同一次点击的用户手势内，
   * 现代浏览器不会拦；`exportAll()` 读的是**内存里的当前状态**（不是 localStorage），
   * 所以哪怕本机那副本已经存不下，导出的也是用户眼前这份，当前修改一并带上。
   */
  const doBackupThenClean = () => {
    try {
      download(`秋招网申数据-${new Date().toISOString().slice(0, 10)}.json`, exportAll());
    } catch (e) {
      toast('导出失败：' + (e as Error).message, 'err', 8000);
      return;
    }
    const freed = clearSnapshots();
    setSnaps(listSnapshots());
    const u = localUsage(storageKey);
    const left = u.mainChars * 2;          // 字符数 → 字节（localStorage 按 UTF-16）
    if (left > 3_000_000) {
      toast(`备份已下载；快照已清空（腾出 ${fmtBytes(freed)}）。但主数据本身还有约 ${fmtBytes(u.mainChars)} —— 请接着删岗位库里不投的岗位。`, 'info', 12000);
    } else {
      toast(`备份已下载，旧快照已清空（腾出 ${fmtBytes(freed)}）。本机现在有足够空间保存新的修改了。`, 'ok', 9000);
    }
  };
  /* 导入前先给当前数据留一份快照，任何误操作都能从「本机自动备份」回滚 */
  const snapshotNow = () => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) saveSnapshot(storageKey, raw, 'preimport');
    } catch { /* ignore */ }
  };
  const doImport = (file: File, mode: 'merge' | 'overwrite') => {
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result);
      snapshotNow();
      if (mode === 'merge') {
        const res = importMerge(text);
        if (res.ok) toast(res.detail.length ? `已合并导入：${res.detail.join('；')}` : '合并导入完成：没有需要新增的内容');
        else toast(`导入失败：${res.detail[0]}`, 'err');
      } else {
        if (importAll(text)) toast('已覆盖导入（原数据已在本机自动备份中留存）');
        else toast('导入失败：文件格式错误', 'err');
      }
    };
    r.readAsText(file);
  };

  /* ---- 网盘（WebDAV）多设备同步 ----
   *
   * 「有没有未保存的修改」必须显示出来 —— 这是「我明明连好了网盘，却什么也没发生」的标准成因：
   * 「先测试连接」走的是 `testWebdav(wdInput)`，测的是**输入框里的值**；
   * 而自动拉取走 `pullSyncDoc()` → `getWebdavConfig()`，读的是**已保存到 localStorage 的值**。
   * 用户填完字段、点「先测试连接」看到「网盘连接可用」，非常自然地就以为配好了，
   * 实际上一次都没写进存储。于是自动同步仍然认为「未配网盘」。
   * 修法不是改措辞，而是让状态可见 + 未保存时把主按钮换成「保存配置」。 */
  const wdDirty = (() => {
    try { return JSON.stringify(wdInput) !== JSON.stringify(getWebdavConfig()); } catch { return false; }
  })();
  const wdSave = () => { setWebdavConfig(wdInput); toast('网盘同步配置已保存（凭据仅存本机浏览器）'); };
  const wdTest = async () => {
    setWdBusy('test'); setWdMsg(null);
    try {
      const m = await testWebdav(wdInput);
      setWdMsg({ st: 'ok', text: m });
      /* 测通 ≠ 配好。这里必须点破，否则那句「连接可用」会把用户送进「为什么没同步」的死胡同。 */
      toast(wdDirty ? '网盘连接可用 —— 但配置还没保存，点「保存配置」后自动同步才会读它' : '网盘连接可用');
    }
    catch (e) { setWdMsg({ st: 'fail', text: (e as Error).message }); toast('网盘连接失败：' + (e as Error).message, 'err'); }
    finally { setWdBusy('idle'); }
  };
  const wdPush = async () => {
    setWdBusy('push'); setWdMsg(null);
    try {
      await pushBackup(wdInput, exportAll());
      const now = new Date().toISOString();
      setWdInput((c) => ({ ...c, lastSync: now })); setWebdavConfig({ ...wdInput, lastSync: now });
      setWdMsg({ st: 'ok', text: '已上传到网盘' }); toast('已上传备份到网盘');
    } catch (e) { setWdMsg({ st: 'fail', text: (e as Error).message }); toast('上传失败：' + (e as Error).message, 'err'); }
    finally { setWdBusy('idle'); }
  };
  const wdPull = async () => {
    if (!confirm('从网盘下载将覆盖本机当前数据，确定继续？')) return;
    setWdBusy('pull'); setWdMsg(null);
    try {
      const json = await pullBackup(wdInput);
      if (!importAll(json)) throw new Error('备份文件格式错误，导入失败');
      const now = new Date().toISOString();
      setWdInput((c) => ({ ...c, lastSync: now })); setWebdavConfig({ ...wdInput, lastSync: now });
      setWdMsg({ st: 'ok', text: '已从网盘恢复' }); toast('已从网盘恢复数据');
    } catch (e) { setWdMsg({ st: 'fail', text: (e as Error).message }); toast('下载失败：' + (e as Error).message, 'err'); }
    finally { setWdBusy('idle'); }
  };

  const meta = TITLES[view];
  return (
    <div className="aurora">
      <div className="aurora__blob aurora__blob--1" /><div className="aurora__blob aurora__blob--2" />
      <div className="aurora__blob aurora__blob--3" /><div className="aurora__blob aurora__blob--4" />
      <div className="aurora__grain" />

      <div className={cn('app', agentDocked && 'app--agent')} style={{ ['--agent-w' as string]: `${agentW}px` }}>
        {mobileNav && <div className="scrim" onClick={() => setMobileNav(false)} />}
        <Sidebar bridgeOnline={online} unread={unread} open={mobileNav}
          onNavigate={() => setMobileNav(false)} onOpenGroup={openGroup}
          userEmail={userEmail} onLogout={onLogout} />

        <div className="app__main">
          <TopBar title={meta.t} crumb={meta.c} onMenu={() => setMobileNav(true)} onSettings={() => { setBridgeInput(getBridgeUrl()); setTokenInput(getBridgeToken()); setAiInput(getAiConfig()); setAiTest({ st: 'idle', msg: '' }); setModelManual(false); setWdInput(getWebdavConfig()); setWdMsg(null); setWdBusy('idle'); setSettings(true); }}>
            <Button size="sm" variant="ghost" icon="info" onClick={() => setGuide(true)}
              aria-label="使用教程" title="使用教程：这个网站能做什么、设置怎么配" />
            <Button size="sm" variant={agentOpen ? 'primary' : 'ghost'} icon="sparkles" onClick={toggleAgent}
              aria-label={agentOpen ? '收起 AI 助手' : '展开 AI 助手'} title={agentOpen ? '收起 AI 助手' : '展开 AI 助手（右栏）'} />
            <Button size="sm" variant="ghost" icon="palette" onClick={() => setSkinMkt(true)}
              aria-label="皮肤市场" title={`皮肤市场 · 当前「${skinDef(skin).name}」`} />
            {/* 这里原先还有一个 ☀️/🌙 明暗按钮。已删：它只在极光玻璃下有效，
                换到纸 / 墨 / 石墨 / 青绿就变成隐藏或空操作 —— 换明暗请回皮肤市场，
                那里两档并排摆着，比一个「只对一款皮肤成立」的顶栏开关清楚得多。 */}
          </TopBar>
          <main className="app__scroll">
            <TabBar tabs={groupOf(view).tabs} active={view} onChange={goTo} badge={badgeOf} />
            <ReminderBar onNav={goTo} />
            <ErrorBoundary label={meta.t}>
              <React.Suspense fallback={<div className="tx-3" style={{ padding: 40, textAlign: 'center', fontSize: 13 }}>加载中…</div>}>
                {view === 'dashboard' && <Dashboard mail={{ online, unread, account }} onNav={(v) => goTo(v as ViewId)} />}
                {view === 'insights' && <Insights />}
                {view === 'database' && <Database />}
                {view === 'jobs' && <Jobs />}
                {view === 'applications' && <Applications />}
                {view === 'bank' && <Bank />}
                {view === 'calendar' && <Calendar />}
                {view === 'interviews' && <Interviews />}
                {view === 'offers' && <Offers />}
                {view === 'checklist' && <Checklist />}
                {view === 'versions' && <Versions />}
                {view === 'contacts' && <Contacts />}
                {view === 'mail' && <MailCenter online={online} account={account} onUnread={setUnread} onRefreshBridge={refreshBridge} />}
                {view === 'resume' && <Resume />}
              </React.Suspense>
            </ErrorBoundary>
          </main>
        </div>

        <AgentPanel docked={agentDocked} floating={agentOpen && !wide}
          width={agentW} onResize={resizeAgent}
          onOpen={toggleAgent} onClose={toggleAgent} />
      </div>

      <Modal open={pwdOpen} onClose={() => setPwdOpen(false)} icon="user" title="修改密码"
        footer={<Button onClick={() => setPwdOpen(false)}>关闭</Button>}>
        <SetPassword mode="change" onDone={() => { setPwdOpen(false); toast('密码已更新'); }} onCancel={() => setPwdOpen(false)} />
      </Modal>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={goTo} />
      <SkinMarket open={skinMkt} onClose={() => setSkinMkt(false)} />
      <Guide open={guide} onClose={() => setGuide(false)} onNavigate={goTo}
        onOpenSettings={() => setSettings(true)} />
      <Toaster />

      {/* 「设置 → 数据与备份」里的秋招信息导入入口（与岗位库里的两个弹窗复用同一套组件） */}
      <React.Suspense fallback={null}>
        {jobsSyncOpen && <JobsSyncModal onClose={() => setJobsSyncOpen(false)}
          onLoaded={(text) => { setJobsSyncOpen(false); setJobsImportText(text); setJobsImportLabel('来自网盘'); setJobsImportOpen(true); }} />}
        {jobsImportOpen && <JobsImportModal onClose={() => setJobsImportOpen(false)}
          initialText={jobsImportText || undefined} sourceLabel={jobsImportLabel} />}
        {fileImportOpen && <FileImportModal onClose={() => setFileImportOpen(false)} />}
      </React.Suspense>

      <Modal open={settings} onClose={() => setSettings(false)} icon="settings" title="设置与数据管理"
        footer={<Button variant="primary" onClick={() => setSettings(false)}>完成</Button>}>
        <div className="col gap-16">
          {/* 设置是「看不懂就不敢动」的典型：先给一条通往教程的路，再让用户看分页 */}
          <div className="guide-banner">
            <Icon name="info" size={14} />
            <span className="grow">第一次用？这里三分钟讲清「网站能做什么」，以及下面每一项设置要不要配。</span>
            <Button size="sm" icon="info" onClick={() => { setSettings(false); setGuide(true); }}>看教程</Button>
          </div>
          <Segmented value={stab} onChange={setStab} options={[
            ...(userEmail ? [{ value: 'cloud' as const, label: '云端与同步' }] : []),
            { value: 'look', label: '外观与提醒' },
            { value: 'bridge', label: '邮件桥' },
            { value: 'ai', label: 'AI 助手' },
            { value: 'data', label: '数据与备份' },
          ]} />
          <div className="divider" />
          {stab === 'cloud' && (<>
          <div>
            <div className="h-sub" style={{ marginBottom: 8 }}>云端账号与同步</div>
            <div className="field__hint" style={{ marginBottom: 10, lineHeight: 1.8 }}>
              数据存在你自己的 Supabase 项目里（每张表都启用了行级安全策略，只有你自己的账号读得到），
              同时在本机浏览器留一份缓存 —— 断网、云端暂停时站点照常可用，联网后自动补齐。
              多设备可以同时打开，但请避免同一时刻在两台设备上改同一块内容（云端以最后写入为准）。
            </div>
            <div className="row gap-8 wrap">
              <span className="badge badge--muted">{userEmail || '本机模式（不连云）'}</span>
              <span className={cloud.enabled ? 'badge badge--ok' : 'badge badge--muted'}>
                {cloud.enabled ? '同步已开启' : '同步未开启'}
              </span>
              {cloud.state === 'saving' && <span className="badge badge--muted">正在上传…</span>}
              {cloud.state === 'saved' && cloud.at && <span className="badge badge--ok">最后同步 {new Date(cloud.at).toLocaleString('zh-CN')}</span>}
              {cloud.state === 'error' && (
                <span className="badge badge--danger" style={{ maxWidth: 420, whiteSpace: 'normal', textAlign: 'left' }}>
                  同步失败：{cloud.error}
                </span>
              )}
            </div>
            <div className="row gap-8 wrap" style={{ marginTop: 10 }}>
              <Button size="sm" variant="primary" icon="refresh" disabled={cloud.state === 'saving'}
                onClick={async () => { await pushToCloud(); toast(cloud.state === 'error' ? '推送失败，见上方原因' : '已推送到云端', cloud.state === 'error' ? 'err' : 'ok'); }}>
                立即同步到云端
              </Button>
              {!cloud.enabled && (
                <Button size="sm" icon="check" disabled={cloud.state === 'saving'}
                  onClick={async () => {
                    toast('正在重新连接云端…', 'info');
                    const ok = await enableCloud();
                    if (!ok) toast('仍然连不上云端，原因见上方', 'err');
                  }}>{cloud.state === 'saving' ? '连接中…' : '重试连接'}</Button>
              )}
              <Button size="sm" icon="user" onClick={() => setPwdOpen(true)}>修改密码</Button>
              {onLogout && <Button size="sm" variant="ghost" icon="logout" onClick={onLogout}>退出登录</Button>}
            </div>
            {cloud.state === 'error' && (
              <div className="field__hint" style={{ marginTop: 10, lineHeight: 1.8 }}>
                本机数据不会因为同步失败而丢（每次改动都已写进本机缓存）。若长期连不上，多为 Supabase
                免费版项目因长时间未使用被暂停 —— 到 supabase.com 后台点 Restore 即可恢复。
              </div>
            )}
          </div>

          <div className="divider" />

          <div>
            <div className="h-sub" style={{ marginBottom: 8 }}>把旧站数据搬过来</div>
            <div className="field__hint" style={{ lineHeight: 1.8 }}>
              旧的「本机版」站点数据存在那台浏览器的 localStorage 里，不会自动过来。
              做法：在旧站点打开「设置 → 数据与备份 → 导出 JSON 备份」，回到这里用
              <b>「数据与备份 → 导入并合并」</b>拉进来 —— 只补新内容，不覆盖你已经填好的。
            </div>
          </div>
          </>)}
          {stab === 'look' && (<>
          <div>
            <div className="h-sub" style={{ marginBottom: 8 }}>外观 · 皮肤</div>
            <div className="field__hint" style={{ marginBottom: 10, lineHeight: 1.8 }}>
              皮肤换的是<b>整套视觉语言</b> —— 底色、圆角、字体、质感，数据与布局一个字都不动。
              当前是 <b>{skinDef(skin).name}</b>：{skinDef(skin).sub}。
            </div>
            <div className="row gap-10 wrap">
              <Button variant="primary" icon="palette"
                onClick={() => { setSettings(false); setSkinMkt(true); }}>逛皮肤市场</Button>
            </div>
            <div className="field__hint" style={{ marginTop: 8, lineHeight: 1.8 }}>
              这里没有单独的深 / 浅色开关 —— <b>明暗是皮肤的一部分</b>，不单独拧。
              想要另一档明暗，回皮肤市场换一张卡：极光玻璃的「夜」与「晨」并排摆着，
              豆绿护眼则固定在浅色（WPS 那支护眼绿打底，是给长时间阅读准备的）。
            </div>
          </div>
          <div className="divider" />
          <div>
            <div className="h-sub" style={{ marginBottom: 8 }}>截止提醒</div>
            <div className="field__hint" style={{ marginBottom: 10 }}>
              网页关掉之后没法主动叫你，所以提醒由三条腿组成：打开站点时的顶部提醒条、
              浏览器系统通知（装成 PWA 后手机同样生效）、以及带提前闹钟的 ICS 日历文件
              —— 想要真正的「到点响」，把 ICS 导入手机日历最稳。
            </div>
            <div className="row gap-8 wrap">
              <Button size="sm" icon="bell" onClick={async () => {
                const ok = await ensureNotifyPermission();
                setRemind({ enabled: ok });
                toast(ok ? '已开启系统通知（每档每天最多一次）' : '未获得通知权限', ok ? 'ok' : 'err');
              }}>{remind.enabled ? '系统通知：已开启' : '开启系统通知'}</Button>
              <Button size="sm" icon="calendar" onClick={() => {
                const ics = buildICS(deadlinesToIcsEvents(jobs, applications, allEvents, remind.days?.length ? remind.days : [7, 3, 1]), '2027 秋招追踪');
                download(`秋招截止日历-${new Date().toISOString().slice(0, 10)}.ics`, ics, 'text/calendar');
                toast('已导出 ICS，双击导入系统日历');
              }}>导出 ICS 日历</Button>
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label className="field__label">提前提醒天数（逗号分隔）</label>
              <input className="input mono" value={(remind.days || []).join(',')}
                onChange={(e) => setRemind({ days: e.target.value.split(/[,，\s]+/).map(Number).filter((n) => n > 0) })} />
              <div className="field__hint">默认 7,3,1 —— 同时用于站内提醒条与导出的 ICS 闹钟。</div>
            </div>
            <div className="row gap-16 wrap" style={{ marginTop: 8 }}>
              <label className="row gap-6" style={{ fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={remind.includeJobs} onChange={(e) => setRemind({ includeJobs: e.target.checked })} /> 岗位截止
              </label>
              <label className="row gap-6" style={{ fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={remind.includeApps} onChange={(e) => setRemind({ includeApps: e.target.checked })} /> 投递截止
              </label>
              <label className="row gap-6" style={{ fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={remind.includeEvents} onChange={(e) => setRemind({ includeEvents: e.target.checked })} /> 笔试面试日程
              </label>
            </div>
          </div></>)}
          {stab === 'bridge' && (<>
          <div>
            <div className="h-sub" style={{ marginBottom: 8 }}>这是什么</div>
            <div className="field__hint" style={{ lineHeight: 1.85 }}>
              「邮件中心」要读你的邮箱，但浏览器不可能直接说 IMAP/SMTP 协议，也不该把你的邮箱密码交给任何网站。
              所以中间需要一个跑在<b>你自己电脑上</b>的小程序 —— 就是邮件桥。<br />
              <b>这是可选功能</b>，不装它不影响其它任何板块，只是邮件中心会一直显示连接引导。<br />
              凭据只存在你那台电脑上，邮件内容不经过本站服务器。
            </div>
          </div>

          <div className="divider" />

          <div>
            <div className="h-sub" style={{ marginBottom: 8 }}>怎么装（下载后双击一次，不用终端）</div>
            <div className="row gap-8" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
              <a className="btn btn--primary" href="/download/邮件桥安装器.zip" download>
                <Icon name="download" size={15} /> 下载安装器（macOS）
              </a>
            </div>
            <div className="mono" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-brd)', borderRadius: 10, padding: '10px 12px', margin: '8px 0', fontSize: 11.5, lineHeight: 2 }}>
              <div><b>① 解压后双击安装</b> —— 自动检查环境、装依赖；没有 Node.js 会带你去下载页。</div>
              <div><b>② 弹窗里填邮箱和授权码</b> —— 服务器地址按你的邮箱域名自动填好，不用自己查。</div>
              <div><b>③ 安装器真连一次邮箱验证</b> —— 连上才算成功；连不上会直接告诉你卡在哪一步。</div>
              <div><b>④ 回到本页粘贴令牌</b> —— 令牌已自动复制到剪贴板，按 <b>⌘V</b> 粘到下面即可。</div>
            </div>
            <div className="field__hint" style={{ marginTop: 8, lineHeight: 1.85 }}>
              <b>下载的是 zip，解压后双击「安装邮件桥.command」</b>：浏览器下载会丢掉文件的可执行权限，
              直接下 <span className="mono">.command</span> 双击会<b>毫无反应</b>，zip 解压才能保留权限。<br />
              <b>仍提示「无法验证开发者」？</b>右键点文件 → 选「打开」，再点一次「打开」即可；或执行
              <span className="mono"> xattr -d com.apple.quarantine ~/Downloads/图鲲邮件桥/安装邮件桥.command</span>。<br />
              <b>授权码不是登录密码</b>：要去邮箱网页版设置里开启 IMAP/SMTP 并生成授权码。
              常见服务商的对照表在 <b>mail-bridge/README.md</b>。<br />
              <b>装完会自动设成开机自启</b>（不需要留着任何终端窗口）。想停用或卸载，
              双击同目录下的 <b>卸载邮件桥.command</b>。<br />
              <b>不想填真邮箱、只想先试试通不通？</b>在 mail-bridge 目录里执行
              <span className="mono"> npm run demo</span>，会返回一个假收件箱，用来确认「网站 ↔ 桥」这段是通的。
            </div>
          </div>

          <div className="divider" />

          <div>
            <div className="h-sub" style={{ marginBottom: 8 }}>连接配置</div>
            <div className="field">
              <label className="field__label">邮件桥地址</label>
              <input className="input mono" value={bridgeInput} onChange={(e) => setBridgeInput(e.target.value)} placeholder={DEFAULT_BRIDGE} />
              <div className="field__hint">默认 {DEFAULT_BRIDGE}。桥跑在你自己的电脑上，装好后通常不用改；改了端口才需要同步改这里。</div>
            </div>
            <div className="field">
              <label className="field__label">访问令牌（X-QZ-Token）</label>
              <input className="input mono" type="password" value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)} placeholder="48 位令牌（安装时已自动复制到剪贴板，⌘V 粘贴即可）" />
              <div className="field__hint">
                桥除健康检查外所有接口都要求这个令牌：否则你打开别的网页时，那个网页也能偷偷调用它读你的邮箱。
                令牌在安装时自动生成，也保存在 <b>mail-bridge/bridge.token</b>；只存在本机浏览器，不会上传。
              </div>
            </div>
            <div className="row gap-8" style={{ marginTop: 10 }}>
              <Button size="sm" variant="primary" icon="check" onClick={() => { setBridgeUrl(bridgeInput.trim() || DEFAULT_BRIDGE); setBridgeToken(tokenInput); toast('已保存并重连'); refreshBridge(); }}>保存并重连</Button>
              <Button size="sm" icon="refresh" onClick={refreshBridge}>测试连接</Button>
              <span className={online ? 'badge badge--ok' : 'badge badge--muted'}>{online ? `在线 · ${account?.email || ''}` : '离线'}</span>
            </div>
            {!online && (
              <div className="field__hint" style={{ marginTop: 8 }}>
                显示离线时按顺序排查：① 桥装了吗（双击一次 <b>安装邮件桥.command</b> 即可）；
                ② 令牌填了吗（这是最常见的漏项）；③ 地址端口对不对。<br />
                装了但仍然离线，多半是令牌不对或服务没起来 —— 用安装器重跑一次会明确告诉你是哪一步。
              </div>
            )}
          </div>
          </>)}
          {stab === 'ai' && (<>          <div>
            <div className="h-sub" style={{ marginBottom: 8 }}>AI 助手（全站智能能力）</div>
            <div className="field__hint" style={{ marginBottom: 10 }}>
              填入你自己的任意 OpenAI 兼容接口 API Key，即可解锁：收件箱→投递状态同步、JD 智能录入、简历匹配度评估、公司背景生成、题库 AI 分类与参考答案、邮件代写、资料一键生成。<br />
              Key <b>只保存在这台设备的浏览器里，不会同步到云端账号</b>（避免密钥进数据库）——换电脑或手机时要重新填一次。
              模型请求直连你填的那家服务商，本站不代转、不留存。
            </div>
            <div className="col gap-8">
              <div className="field">
                <label className="field__label">服务商</label>
                <select className="select" value={detectProvider(aiInput.baseUrl).id}
                  onChange={(e) => {
                    const p = AI_PROVIDERS.find((x) => x.id === e.target.value)!;
                    if (p.id === 'custom') { setModelManual(true); return; }
                    setModelManual(false);
                    setAiInput({ ...aiInput, baseUrl: p.baseUrl, model: p.models.includes(aiInput.model) ? aiInput.model : p.models[0] });
                  }}>
                  {AI_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <div className="field__hint">选择后自动填充 API Base URL 与模型列表。注意：Base URL 须填「接口地址」（如 DeepSeek 为 https://api.deepseek.com/v1），填官网网址（www.deepseek.com）会连接失败。</div>
              </div>
              <div className="field">
                <label className="field__label">API Base URL</label>
                <input className="input mono" value={aiInput.baseUrl} placeholder={DEFAULT_AI.baseUrl}
                  onChange={(e) => setAiInput({ ...aiInput, baseUrl: e.target.value })} />
              </div>
              <div className="field">
                <label className="field__label">API Key</label>
                <input className="input mono" type="password" value={aiInput.apiKey} placeholder="sk-…"
                  onChange={(e) => setAiInput({ ...aiInput, apiKey: e.target.value })} />
              </div>
              <div className="field">
                <label className="field__label">模型</label>
                {detectProvider(aiInput.baseUrl).id !== 'custom' && !modelManual ? (
                  <>
                    <select className="select" value={detectProvider(aiInput.baseUrl).models.includes(aiInput.model) ? aiInput.model : '__other__'}
                      onChange={(e) => { if (e.target.value === '__custom__') setModelManual(true); else setAiInput({ ...aiInput, model: e.target.value }); }}>
                      {!detectProvider(aiInput.baseUrl).models.includes(aiInput.model) && (
                        <option value="__other__">{aiInput.model || '（未设置）'}（当前值·自定义）</option>
                      )}
                      {detectProvider(aiInput.baseUrl).models.map((m) => <option key={m} value={m}>{m}</option>)}
                      <option value="__custom__">其他模型（手动输入）…</option>
                    </select>
                    <div className="field__hint">{detectProvider(aiInput.baseUrl).label} 常用模型；选「其他模型」可手动输入任意模型名。</div>
                  </>
                ) : (
                  <>
                    <input className="input mono" value={aiInput.model} placeholder={DEFAULT_AI.model}
                      onChange={(e) => setAiInput({ ...aiInput, model: e.target.value })} />
                    {detectProvider(aiInput.baseUrl).id !== 'custom' && (
                      <button className="copy-btn" style={{ marginTop: 6 }} onClick={() => setModelManual(false)}>返回模型选择</button>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="row gap-8 wrap" style={{ marginTop: 10 }}>
              <Button size="sm" variant="primary" icon="check" onClick={() => { setAiConfig(aiInput); toast('AI 配置已保存'); }}>保存 AI 配置</Button>
              <Button size="sm" icon="refresh" disabled={aiTest.st === 'busy'}
                onClick={async () => {
                  if (!aiInput.apiKey.trim()) { toast('请先填入 API Key 再测试', 'err'); return; }
                  setAiTest({ st: 'busy', msg: '' });
                  try {
                    const reply = await testAiConnection(aiInput);
                    setAiTest({ st: 'ok', msg: reply.slice(0, 30) });
                    toast('AI 连接可用');
                  } catch (e) {
                    setAiTest({ st: 'fail', msg: (e as Error).message });
                    toast('AI 连接失败：' + (e as Error).message, 'err');
                  }
                }}>{aiTest.st === 'busy' ? '测试中…' : '测试连接'}</Button>
              <span className={aiInput.apiKey.trim() ? 'badge badge--ok' : 'badge badge--muted'}>{aiInput.apiKey.trim() ? '已配置 Key' : '未配置（将用关键词兜底）'}</span>
              {aiTest.st === 'ok' && <span className="badge badge--ok">连接可用 · 模型 {aiInput.model} 回复：{aiTest.msg}</span>}
            </div>
            {/* 报错要把「服务商的原话 + 下一步怎么做」完整显示出来。
                塞进 badge 会因 maxWidth 截断，恰好丢掉最关键的那半句。 */}
            {aiTest.st === 'fail' && (
              <div className="glass" style={{
                marginTop: 10, padding: '11px 13px', borderRadius: 12,
                borderColor: 'var(--danger-brd, rgba(220,80,80,.35))',
              }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
                  {aiErrorKind(aiTest.msg) === 'money' ? '账户余额不足'
                    : aiErrorKind(aiTest.msg) === 'auth' ? 'API Key 无效'
                    : aiErrorKind(aiTest.msg) === 'net' ? '连不上服务商'
                    : aiErrorKind(aiTest.msg) === 'config' ? '配置格式不对'
                    : '连接失败'}
                  <span className="tx-4" style={{ fontWeight: 400 }}> · 测试的模型是 <span className="mono">{aiInput.model || '（空）'}</span></span>
                </div>
                <div className="mono" style={{ fontSize: 11.5, lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{aiTest.msg}</div>
                <div className="row gap-8" style={{ marginTop: 9 }}>
                  <button className="copy-btn" onClick={() => { copyText(aiTest.msg); toast('已复制报错原文'); }}>复制报错</button>
                </div>
              </div>
            )}

            <div className="divider" />

            {/* 联网搜索：默认没有这个能力，AI 就只能查本站数据，用户问「大商所待遇」这类问题会被拒。
                做成可选 + 自带 Key，是因为本站是纯前端应用 —— 任何写进代码的密钥都会随 JS 包发给每个访客。 */}
            <div>
              <div className="h-sub" style={{ marginBottom: 8 }}>联网搜索（让助手能查站外信息）</div>
              <div className="field__hint" style={{ marginBottom: 10, lineHeight: 1.85 }}>
                AI 本身只能查本站的岗位库 / 投递 / 题库。填了下面的搜索 Key，对话框里它就多出一个
                <b>联网搜索</b>能力：招聘公告与截止时间、岗位待遇与薪资、笔试面试经验、公司背景，
                都能去真实互联网上查，并<b>在回答里附上来源链接</b>供你自己复核。<br />
                <b>可选功能</b>，不填不影响其它任何板块。搜索走你自己的额度（本站不代付、不代转请求），
                Key 与 AI Key 一样只存在这台设备的浏览器里，不会同步到云端账号。<br />
                <b>怎么拿 Key</b>：到博查开放平台（open.bochaai.com）注册后创建 API Key，粘贴到下面即可，有免费额度。
              </div>
              <div className="field">
                <label className="field__label">搜索 API Key</label>
                <input className="input mono" type="password" value={aiInput.searchKey || ''}
                  placeholder="sk-…（博查 Web Search API Key）"
                  onChange={(e) => setAiInput({ ...aiInput, searchKey: e.target.value })} />
                <div className="field__hint">保存后，AI 助手在处理站外问题时就会出现「联网搜索」这一步。</div>
              </div>
              <div className="row gap-8 wrap" style={{ marginTop: 10 }}>
                <Button size="sm" variant="primary" icon="check"
                  onClick={() => { setAiConfig(aiInput); toast('联网搜索配置已保存'); }}>保存搜索配置</Button>
                <Button size="sm" icon="refresh" disabled={searchTest.st === 'busy'}
                  onClick={async () => {
                    if (!(aiInput.searchKey || '').trim()) { toast('请先填入搜索 API Key 再测试', 'err'); return; }
                    setSearchTest({ st: 'busy', msg: '' });
                    try {
                      const sample = await testSearchConnection(aiInput);
                      setSearchTest({ st: 'ok', msg: sample });
                      toast('联网搜索可用');
                    } catch (e) {
                      setSearchTest({ st: 'fail', msg: (e as Error).message });
                      toast('联网搜索不可用：' + (e as Error).message, 'err');
                    }
                  }}>{searchTest.st === 'busy' ? '测试中…' : '测试搜索'}</Button>
                <span className={(aiInput.searchKey || '').trim() ? 'badge badge--ok' : 'badge badge--muted'}>
                  {(aiInput.searchKey || '').trim() ? '已配置联网搜索' : '未配置（助手查不了站外信息）'}
                </span>
                {searchTest.st === 'ok' && <span className="badge badge--ok">搜索可用 · 样例：{searchTest.msg}</span>}
              </div>
              {searchTest.st === 'fail' && (
                <div className="glass" style={{
                  marginTop: 10, padding: '11px 13px', borderRadius: 12,
                  borderColor: 'var(--danger-brd, rgba(220,80,80,.35))',
                }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>联网搜索不可用</div>
                  <div className="mono" style={{ fontSize: 11.5, lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{searchTest.msg}</div>
                  <div className="row gap-8" style={{ marginTop: 9 }}>
                    <button className="copy-btn" onClick={() => { copyText(searchTest.msg); toast('已复制报错原文'); }}>复制报错</button>
                  </div>
                </div>
              )}
            </div>
          </div></>)}
          {stab === 'data' && (<>
          {/* ① 每天用的那一件事，放在最上面 */}
          <div className="glass card" style={{ padding: 14 }}>
            <div className="h-sub" style={{ marginBottom: 6 }}>① 批量导入秋招信息（汇总表 / Markdown）</div>
            <div className="field__hint" style={{ marginBottom: 10, lineHeight: 1.8 }}>
              你手上如果有一份整理好的岗位汇总表（Markdown / 表格文本），不必一条条手敲：直接选文件或拖进来，
              站内会解析成结构化岗位入库，同一份反复导入不会重复堆积。<br />
              需要多设备自动同步时，把它放到你自己的网盘（WebDAV）里，打开网站即可自动拉取 —— 见下面的「⑤ 网盘同步」。
              浏览器读不到你本机磁盘，所以要么走网盘，要么手动选文件。
            </div>
            <div className="row gap-8 wrap">
              <Button size="sm" variant="primary" icon="refresh"
                onClick={() => { setSettings(false); setJobsSyncOpen(true); }}>从网盘同步汇总表</Button>
              <Button size="sm" icon="upload"
                onClick={() => { setSettings(false); setJobsImportText(''); setJobsImportLabel(undefined); setJobsImportOpen(true); }}>
                选文件 / 拖拽导入
              </Button>
            </div>
            <label className="row gap-6" style={{ marginTop: 12, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoSync} onChange={(e) => { setAutoSyncOn(e.target.checked); setAutoSync(e.target.checked); toast(e.target.checked ? '已开启：打开网站时自动同步，内容没变不会打扰你' : '已关闭自动同步，请用上面的按钮手动同步'); }} />
              打开网站时自动同步（内容没变则静默跳过；有更新才写入，并给「撤销」按钮）
            </label>
            <div className="field__hint" style={{ marginTop: 6 }}>
              自动同步只做增量写入（同一份汇总表反复同步不会重复堆积），写入前会自动存一份快照，可在④里回滚。
            </div>
            {/* 同步体检：把「上次检查」与「上次有更新」两个时间摆出来。
                原先这里只有一行「上次自动同步：<时间>（摘要）」，而那一行只在**内容真的变了**时才刷新，
                于是「一切正常、上游没更新」和「链路早断了」显示完全相同。
                这块的存在意义就是让这两种情况可分。 */}
            <SyncStatus variant="block" onAction={() => { setSettings(false); setJobsSyncOpen(true); }} />
            <div className="field__hint" style={{ marginTop: 8 }}>
              当前网盘路径：<span className="mono">{getSyncDocPath()}</span>（可在「岗位库 → 从网盘同步」里修改）
            </div>
          </div>

          <div className="divider" />

          {/* ② 从本机文件导入：不认识「该放哪」的文件，交给它自己判断 */}
          <div>
            <div className="h-sub" style={{ marginBottom: 8 }}>② 从本机文件导入</div>
            <div className="field__hint" style={{ marginBottom: 10 }}>
              把桌面上的文件直接拖进来，站点会自动判断<b>这是什么内容、该进哪个板块</b>，解析后先给你看样例行，确认再写入。<br />
              支持 <b>.md</b>（秋招信息汇总表 → 岗位库 + 截止日历）、<b>.json</b>（整站备份 / 题库 / 岗位数组）、<b>.csv</b>（含「单位/公司」列的表格）、<b>.ics</b>（手机日历导出 → 截止日历）。
              文件不会上传，全部在本机浏览器里解析。
            </div>
            <div className="row gap-8 wrap">
              <Button size="sm" variant="primary" icon="upload"
                onClick={() => { setSettings(false); setFileImportOpen(true); }}>
                选择文件 / 拖拽导入
              </Button>
            </div>
            <div className="field__hint" style={{ marginTop: 8 }}>
              和①的区别：① 只认《秋招信息汇总》那一种文档；这里认任何文件，并且会自动分流到题库 / 资料库 / 简历版本 / 人脉等板块。
            </div>
          </div>

          <div className="divider" />

          {/* ③ 本机数据概览 + 整站备份的导入导出 */}
          <div>
            <div className="h-sub" style={{ marginBottom: 8 }}>③ 本机数据与整站备份</div>
            {storageUnsaved && (
              <div className="glass" style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 12,
                borderColor: 'var(--danger-brd, rgba(220,80,80,.35))', lineHeight: 1.8 }}>
                <span className="badge badge--danger" style={{ flexShrink: 0 }}>最近一次修改没存进本机</span>
                <div style={{ fontSize: 12.5, marginTop: 6 }}>
                  本机浏览器存储已满，且清空旧快照也腾不出位置 —— 说明占地方的是数据本身（多半是岗位库太大）。
                  先点下面的<b>「先导出备份，再清理旧快照」</b>把当前数据落盘，再去「岗位追踪 → 更多 → 清理岗位库」删掉不投的岗位。
                  <b>在腾出空间之前，别刷新或关闭这个标签页</b>：没存下的修改只在内存里。
                </div>
              </div>
            )}
            <div className="field__hint" style={{ marginBottom: 10 }}>
              云端版把整站内容存进你自己的 Supabase 账号（每次改动先写本机缓存、再防抖同步到云端），
              同时在本机浏览器留一份完整副本 —— 断网或云端不可用时站点照常可用。<br />
              当前：岗位 <b>{jobs.length}</b> · 投递 <b>{applications.length}</b> · 日历 <b>{allEvents.length}</b> · 题库 <b>{questions.length}</b> · 面试复盘 <b>{interviews.length}</b> · 人脉 <b>{contacts.length}</b> · 占用约 <b>{fmtBytes(usage.chars)}</b>（其中快照 {fmtBytes(usage.snapshotChars)}）
            </div>
            <div className="row gap-8 wrap">
              <Button size="sm" icon="download" onClick={doExport}>导出 JSON 备份（整站）</Button>
              {/* 配额满时的正确做法只有一种顺序：先落盘、再删。把它做成一个按钮，用户就不需要读说明书。 */}
              <Button size="sm" variant="primary" icon="download" onClick={doBackupThenClean}>先导出备份，再清理旧快照</Button>
              <label className="btn btn--sm" style={{ cursor: 'pointer' }}>
                <Icon name="upload" size={14} /> 导入并合并
                <input type="file" accept="application/json" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f, 'merge'); e.target.value = ''; }} />
              </label>
              <label className="btn btn--sm" style={{ cursor: 'pointer' }}>
                <Icon name="refresh" size={14} /> 覆盖导入
                <input type="file" accept="application/json" hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f && confirm('覆盖导入会用文件内容替换当前全部数据（已有数据会先留一份本机快照）。确定继续？')) doImport(f, 'overwrite');
                    e.target.value = '';
                  }} />
              </label>
            </div>
            <div className="field__hint" style={{ marginTop: 8, lineHeight: 1.8 }}>
              ⚠️ 这两个按钮导入的是<b>整站备份 JSON</b>（资料库 / 投递 / 岗位 / 日历 / 题库…），
              <b>不是</b>秋招信息汇总表 —— 汇总表请用上面第 ① 区。<br />
              「导入并合并」只补新内容、不删你现有的；「覆盖导入」整体替换（会先自动存快照，可回滚）。
            </div>
          </div>

          <div className="divider" />

          {/* ④ 导出其它格式 */}
          <div>
            <div className="h-sub" style={{ marginBottom: 8 }}>④ 导出其它格式</div>
            <div className="row gap-8 wrap">
              <Button size="sm" icon="doc" onClick={() => { download(`岗位表-${new Date().toISOString().slice(0, 10)}.md`, '# 岗位与截止日历\n\n' + jobsToMarkdown(jobs), 'text/markdown'); toast('已导出岗位 Markdown'); }}>岗位 Markdown</Button>
              <Button size="sm" icon="download" onClick={() => { download(`岗位表-${new Date().toISOString().slice(0, 10)}.csv`, '\uFEFF' + jobsToCSV(jobs), 'text/csv'); toast('已导出岗位 CSV'); }}>岗位 CSV</Button>
              <Button size="sm" icon="download" onClick={() => { download(`投递记录-${new Date().toISOString().slice(0, 10)}.csv`, '\uFEFF' + applicationsToCSV(applications), 'text/csv'); toast('已导出投递 CSV'); }}>投递 CSV</Button>
              <Button size="sm" icon="calendar" onClick={() => {
                const alarmDays = remind.days?.length ? remind.days : [7, 3, 1];
                download(`秋招截止日历-${new Date().toISOString().slice(0, 10)}.ics`, buildICS(deadlinesToIcsEvents(jobs, applications, allEvents, alarmDays), '2027 秋招追踪'), 'text/calendar');
                toast('已导出 ICS（含提前提醒），双击即可导入手机日历');
              }}>导出日历 ICS</Button>
            </div>
          </div>

          <div className="divider" />

          {/* ⑤ 网盘同步：可选的第三份备份。
               放在可折叠区里 —— 多设备同步已经由云端账号完成，对绝大多数用户来说这一段是纯负担：
               平铺着会让人以为「不配它就没法多设备用」。默认收起，文案先把「你多半不需要」讲清楚。 */}
          <details className="adv">
            <summary className="adv__sum">
              <span>⑤ 网盘同步 —— 可选的第三份备份<i className="adv__tag">多半不需要</i></span>
              <span className="adv__hint">展开配置</span>
            </summary>
          <div style={{ paddingTop: 12 }}>
            <div className="field__hint" style={{ marginBottom: 10, lineHeight: 1.85 }}>
              <b>你的数据已经多设备同步了</b>（存在你自己的账号里，换电脑 / 手机登录同一个账号就能看到），
              <b>所以这一段不配也完全不影响使用</b>。<br />
              只有一种情况才需要它：你想在云端账号之外，<b>再往自己的网盘放一份独立备份</b>
              （例如想把数据存进自己的坚果云、或想留一份不依赖本站的副本）。<br />
              用法：常用设备点「上传备份」，新设备点「下载恢复」（两台设备填相同账号与路径）。
              凭据只存本机浏览器、备份只存你的网盘。
            </div>
            <div className="col gap-8">
              <div className="field">
                <label className="field__label">网盘类型</label>
                <select className="select" value={detectWebdavProvider(wdInput.server).id}
                  onChange={(e) => { const p = WEBDAV_PROVIDERS.find((x) => x.id === e.target.value)!; setWdInput({ ...wdInput, server: p.server }); }}>
                  {WEBDAV_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <div className="field__hint">{detectWebdavProvider(wdInput.server).hint}</div>
              </div>
              <div className="field">
                <label className="field__label">WebDAV 服务器地址</label>
                <input className="input mono" value={wdInput.server} placeholder="https://dav.jianguoyun.com/dav/"
                  onChange={(e) => setWdInput({ ...wdInput, server: e.target.value })} />
              </div>
              <div className="field">
                <label className="field__label">账号</label>
                <input className="input mono" value={wdInput.username} placeholder="网盘账号（坚果云填注册邮箱）"
                  onChange={(e) => setWdInput({ ...wdInput, username: e.target.value })} />
              </div>
              <div className="field">
                <label className="field__label">应用密码</label>
                <input className="input mono" type="password" value={wdInput.password} placeholder="第三方应用生成的应用密码（非登录密码）"
                  onChange={(e) => setWdInput({ ...wdInput, password: e.target.value })} />
                <div className="field__hint">坚果云网页版 → 账户信息 → 安全选项 → 第三方应用管理 → 添加应用；密码失效会报 401，重新生成后填这里。</div>
              </div>
              <div className="field">
                <label className="field__label">备份文件路径</label>
                <input className="input mono" value={wdInput.path} placeholder="qiuzhao-sync/data.json"
                  onChange={(e) => setWdInput({ ...wdInput, path: e.target.value })} />
                <div className="field__hint">
                  相对网盘根目录的文件路径，文件夹会自动创建；多台设备须填相同路径才能互通。<br />
                  注意分清两个文件：这里是<b>本站整站数据的备份</b>（手动上传/下载）；
                  而岗位汇总表是 <span className="mono">{DEFAULT_SYNC_DOC}</span>，
                  它是「桌面 → 网盘 → 网站」<b>单向流入</b>的 —— 网站里的改动不会写回那份 md。
                </div>
              </div>
            </div>
            {wdDirty && (
              <div className="glass" style={{ marginTop: 10, padding: '9px 11px', borderRadius: 12,
                borderColor: 'var(--warn, rgba(251,191,36,.4))', lineHeight: 1.75 }}>
                <span className="badge badge--warn" style={{ flexShrink: 0 }}>有修改未保存</span>
                <div style={{ fontSize: 12.5, marginTop: 6 }}>
                  「先测试连接」测的是输入框里的值，而<b>自动拉取汇总表读的是已保存的配置</b> ——
                  不点「保存配置」，填了也不会生效。
                </div>
              </div>
            )}
            <div className="row gap-8 wrap" style={{ marginTop: 10 }}>
              {/* 未保存时把主按钮让给「保存配置」：此刻它才是用户真正该点的那个 */}
              <Button size="sm" variant={wdDirty ? 'primary' : 'default'} icon="check" onClick={wdSave}>保存配置</Button>
              <Button size="sm" variant={wdDirty ? 'default' : 'primary'} icon="refresh" disabled={wdBusy !== 'idle'} onClick={wdTest}>{wdBusy === 'test' ? '测试中…' : '先测试连接'}</Button>
              <Button size="sm" icon="upload" disabled={wdBusy !== 'idle'} onClick={wdPush}>{wdBusy === 'push' ? '上传中…' : '上传备份'}</Button>
              <Button size="sm" icon="download" disabled={wdBusy !== 'idle'} onClick={wdPull}>{wdBusy === 'pull' ? '下载中…' : '下载恢复'}</Button>
              {wdInput.lastSync && <span className="badge badge--muted">上次同步 {new Date(wdInput.lastSync).toLocaleString('zh-CN')}</span>}
              {wdMsg?.st === 'ok' && <span className="badge badge--ok">{wdMsg.text}</span>}
            </div>
            {/* 同 AI 分页：网盘报错常带云端真实目录/路径建议，塞进 badge 会截断在最关键处 */}
            {wdMsg?.st === 'fail' && (
              <div className="glass" style={{
                marginTop: 10, padding: '11px 13px', borderRadius: 12,
                borderColor: 'var(--danger-brd, rgba(220,80,80,.35))',
              }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
                  {davErrorKind(wdMsg.text) === 'auth' ? '账号或应用密码不对'
                    : davErrorKind(wdMsg.text) === 'path' ? '云端路径对不上'
                    : davErrorKind(wdMsg.text) === 'server' ? '网盘侧故障'
                    : davErrorKind(wdMsg.text) === 'config' ? '配置没填全'
                    : '网盘连接失败'}
                  <span className="tx-4" style={{ fontWeight: 400 }}> · 服务器 <span className="mono">{wdInput.server || '（空）'}</span></span>
                </div>
                <div className="mono" style={{ fontSize: 11.5, lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{wdMsg.text}</div>
                <div className="row gap-8 wrap" style={{ marginTop: 9 }}>
                  <button className="copy-btn" onClick={() => { copyText(wdMsg.text); toast('已复制报错原文'); }}>复制报错</button>
                  {(davErrorKind(wdMsg.text) === 'auth' || davErrorKind(wdMsg.text) === 'path') && (
                    <button className="copy-btn" onClick={() => { setSettings(false); setJobsSyncOpen(true); }}>浏览网盘目录看云端有什么</button>
                  )}
                </div>
              </div>
            )}
          </div>
          </details>

          <div className="divider" />

          {/* ⑥ 本机自动备份快照 */}
          <div>
            <div className="h-sub" style={{ marginBottom: 8 }}>⑥ 本机自动备份（快照）</div>
            <div className="field__hint" style={{ marginBottom: 10, lineHeight: 1.8 }}>
              数据结构升级、存档损坏、覆盖导入、清理重复岗位之前都会自动留一份快照 —— 后悔了在这里一键回滚。<br />
              保留策略是<b>按体积</b>而不是按份数：最多 5 份，且总占用不超过约 1.8 MB。
              <b>一份快照就是一份完整数据</b>，所以数据量大时只会留最新的 1–2 份（留 5 份会把浏览器的
              5 MB 配额撑爆，导致任何修改都存不下来）。
            </div>
            <div className="row gap-8 wrap" style={{ marginBottom: 10 }}>
              <Button size="sm" icon="refresh" onClick={() => { setSnaps(listSnapshots()); toast('已刷新快照列表'); }}>查看快照</Button>
              {snaps.length > 0 && (
                <Button size="sm" variant="ghost" icon="trash" onClick={() => {
                  if (!confirm(`确定清理全部 ${snaps.length} 份快照？\n\n占用约 ${fmtBytes(usage.snapshotChars)}。这会释放本机存储空间，\n代价是这些历史回滚点没了（当前数据不受影响）。`)) return;
                  const freed = clearSnapshots();
                  setSnaps(listSnapshots());
                  toast(`已清理快照，释放约 ${fmtBytes(freed)}`, 'info');
                }}>清理全部快照</Button>
              )}
            </div>
            <div className="field__hint" style={{ lineHeight: 1.8 }}>
              本机存储已用 <b>{fmtBytes(usage.chars)}</b> / 上限约 {fmtBytes(LOCAL_QUOTA_CHARS)}
              （ 主数据 {fmtBytes(usage.mainChars)} · 快照 {fmtBytes(usage.snapshotChars)} / {usage.snapshotCount} 份 ）。
              {usage.snapshotChars > 0 && usage.snapshotChars >= usage.mainChars && (
                <> 快照比主数据还占地方，<b>建议先点「清理全部快照」</b>。</>
              )}
            </div>
            {bigKeys.length > 0 && (
              <div className="field__hint" style={{ marginTop: 6, lineHeight: 1.9 }}>
                占用最大的几项：
                {bigKeys.map((b) => (
                  <span key={b.key} className="mono" style={{ fontSize: 11, marginLeft: 8 }}>
                    {b.key.replace(/^qz\.cloud\.[^.]+/, 'qz.cloud.*').slice(0, 46)} <b>{fmtBytes(b.chars)}</b>
                  </span>
                ))}
                <div style={{ marginTop: 4 }}>
                  上面写着 <span className="mono">qz.cloud.*</span> 的是<b>整站数据本身</b>（删不掉，删了就没数据了）——
                  要减的是它里面的内容：<b>岗位库</b>里早已截止/不投的岗位占大头时，去「岗位追踪 → 更多 → 清理岗位库」批量删除；
                  <span className="mono">qz.agent.*</span> 是 AI 会话历史，可在右侧 AI 面板里删掉旧会话。
                </div>
              </div>
            )}
            {snaps.length > 0 && (
              <div className="col gap-6" style={{ marginTop: 10 }}>
                {snaps.map((s) => (
                  <div className="list-row" key={s.key} style={{ padding: '8px 10px' }}>
                    <span className="tx-3" style={{ fontSize: 11, minWidth: 30 }}>{s.tag}</span>
                    <span className="grow tx-2 mono truncate" style={{ fontSize: 11 }}>{s.label}</span>
                    <span className="tx-4" style={{ fontSize: 11 }}>{new Date(s.at).toLocaleString('zh-CN')}</span>
                    <span className="tx-4" style={{ fontSize: 11, minWidth: 52, textAlign: 'right' }}>{fmtBytes(s.size)}</span>
                    <Button size="sm" icon="upload" onClick={() => {
                      const raw = readSnapshot(s.key);
                      if (raw && importAll(raw)) toast('已从快照恢复');
                      else toast('快照恢复失败', 'err');
                    }}>恢复</Button>
                    <Button size="sm" variant="ghost" icon="trash" aria-label="删除快照" onClick={() => { removeSnapshot(s.key); setSnaps(listSnapshots()); }} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="divider" />

          {/* ⑦ 危险操作单独放最后 */}
          <div>
            <div className="h-sub" style={{ marginBottom: 8, color: '#fda4af' }}>⑦ 清空全部数据</div>
            <div className="field__hint" style={{ marginBottom: 10, lineHeight: 1.8 }}>
              这个操作会清空<b>资料库、投递、岗位、日历、题库、面试复盘、Offer、材料清单、简历备注</b>等全部内容，并且
              <b>本机与云端账号一起清空</b> —— 你的其他设备下次打开也会变成空白，不只是清掉这台电脑上的副本。<br />
              清空后请在本页停留几秒再关，给云端同步留出写入时间。
            </div>
            <div className="row gap-8 wrap">
              <Button size="sm" icon="download" onClick={doExport}>先导出备份</Button>
              <Button size="sm" variant="danger" icon="trash"
                onClick={() => {
                  if (!confirm('确定清空全部数据？\n\n这会同时清空云端账号里的数据，其他设备下次打开也会变空。\n当前内容会先在本机自动存一份快照，可回滚。')) return;
                  resetAll();
                  toast('已清空全部数据（本机快照可回滚）', 'info');
                }}>清空全部数据</Button>
            </div>
            <div className="field__hint" style={{ marginTop: 8 }}>
              想撤销：下面⑥「本机自动备份」里有一份清空前的快照，点「恢复」即可拉回来（仅限本机）。
            </div>
          </div>
          </>)}
<div className="tx-4" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
            秋招网申辅助中心 · 云端版 · 数据存储在你自己的 Supabase 账号（行级安全策略隔离）· 邮件能力为可选的本地邮件桥。
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 云端外壳：会话 → 云端数据 → 渲染
 * ------------------------------------------------------------------ */

type BootState =
  | { st: 'loading' }
  | { st: 'anon' }
  | { st: 'ready'; userId: string; email: string; boot: CloudBoot };

function CloudApp({ agentOnly }: { agentOnly: boolean }) {
  /* 只读演示模式（?demo=1）：直接以演示数据启动，不读也不写云端与本机缓存。
     实现见 lib/demoMode.tsx，只在带这个参数时被动态载入。 */
  const DEMO = typeof location !== 'undefined' && new URLSearchParams(location.search).get('demo') === '1';
  const [boot, setBoot] = useState<BootState>({ st: 'loading' });
  /* 演示模式时从 #/xxx 读来的落地板块；生产环境恒为 undefined */
  const [demoView, setDemoView] = useState<string | undefined>(() => {
    /* 演示模式的落地板块：#/calendar → 'calendar'。
       生产环境这段恒为 undefined（导航状态只存在 store 里，不走 URL）。 */
    if (typeof location === 'undefined') return undefined;
    if (new URLSearchParams(location.search).get('demo') !== '1') return undefined;
    const v = (location.hash || '').replace(/^#\/?/, '').split('?')[0].trim();
    return v || undefined;
  });
  /* 重置密码回跳：必须在进站之前插一屏「设置新密码」。
     少了这一屏，用户点完邮件只会被直接登录、密码其实没改 —— 这是线上站最容易踩死的死胡同。 */
  const [recovery, setRecovery] = useState(INITIAL_RECOVERY);

  const openFor = useCallback(async (userId: string, email: string) => {
    if (DEMO) {
      const m = await import('./lib/demoMode');
      setBoot({ st: 'ready', userId, email, boot: await m.demoBoot() });
      return;
    }
    try {
      const r = await loadCloudState(userId);
      setBoot({ st: 'ready', userId, email, boot: { ok: true, state: r.state, migrated: r.migrated, savedAt: r.savedAt } });
    } catch (e) {
      /* 云端读不到时**绝不能当成「云端是空的」** —— 那会用本机这份可能过期的数据把云端覆盖掉。
         这里退回本机缓存把界面撑起来，同时禁止回写（boot.ok === false），直到用户在设置里点「重试」。 */
      setBoot({ st: 'ready', userId, email, boot: { ok: false, error: (e as Error).message } });
    }
  }, []);

  useEffect(() => {
    if (!DEMO) return;
    let alive = true;
    /* 演示数据见 src/lib/demoSeed.ts —— 只有带 ?demo=1 时才会被载入 */
    void import('./lib/demoMode').then((m) => m.demoBootState()).then((st) => {
      if (!alive) return;
      setDemoView(st.initialView);
      /* 证明用日志：演示模式落地板块。生产路径不会打这一行 */
      console.info('[demo] initialView =', st.initialView);
      setBoot(st as BootState);
    });
    return () => { alive = false; };
  }, [DEMO]);

  useEffect(() => {
    if (DEMO) return;
    /* 没有配 Supabase 时**不能**碰 supabase.auth：那会走进惰性报错的替身，
       抛出的异常会把这一屏也打掉。配置守卫已经在下方渲染层拦住了这种情况，
       这里只是让副作用也一起短路。 */
    if (!SUPABASE_CONFIGURED) return;
    let alive = true;
    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (!alive) return;
      if (session?.user) void openFor(session.user.id, session.user.email || '');
      else setBoot({ st: 'anon' });
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!alive) return;
      /* 只认「登录 / 登出」两种跃迁：TOKEN_REFRESHED 与 INITIAL_SESSION 每次焦点切换都会触发，
         若照单全收就会反复重读云端并重建 StoreProvider，把用户正在填的表单清空。 */
      if (event === 'SIGNED_OUT' || !session?.user) setBoot({ st: 'anon' });
      else if (event === 'SIGNED_IN') void openFor(session.user.id, session.user.email || '');
    });

    return () => { alive = false; subscription.unsubscribe(); };
  }, [openFor]);

  const logout = useCallback(async () => {
    if (!confirm('退出登录？本机缓存会保留，重新登录后数据照旧。')) return;
    await supabase.auth.signOut();
    setBoot({ st: 'anon' });
  }, []);

  /* 配置缺失时 boot 永远停在 loading（副作用已被短路），必须先拦一道，
     否则用户看到一个永远转不完的「正在连接云端」—— 比黑屏好一点，但同样是死胡同。 */
  if (!SUPABASE_CONFIGURED && !DEMO) return <MissingConfig />;

  if (boot.st === 'loading') {
    return (
      <div className="aurora">
        <div className="aurora__blob aurora__blob--1" /><div className="aurora__blob aurora__blob--2" />
        <div className="login-wrap"><div className="tx-3" style={{ fontSize: 13 }}>正在连接云端…</div></div>
      </div>
    );
  }
  /* 顺序要紧：recovery 必须排在 anon 之前。
     重置链接的 token 可能已过期，那时 supabase-js 建不出会话、boot 会落到 anon，
     若先判 anon 就把刚点完邮件的用户丢回登录页，他根本不知道还能去哪改密码。 */
  if (recovery) return <SetPassword mode="recovery" onDone={() => setRecovery(false)} />;
  if (boot.st === 'anon') return <Login />;

  return (
    /* key 绑定 userId：换账号时强制重建 Provider，避免上个账号的状态泄漏到新账号界面 */
    <StoreProvider key={boot.userId} userId={boot.userId} boot={boot.boot} demo={DEMO} initialView={demoView as never}>
      {DEMO && <DemoBanner />}
      {agentOnly
        ? <><AgentPanel fullPage /><Toaster /></>
        : <Shell userEmail={boot.email} onLogout={logout} />}
    </StoreProvider>
  );
}

/**
 * 没配 Supabase 时的着陆页。
 *
 * 存在的理由：`createClient('')` 会在**模块求值阶段**抛 `supabaseUrl is required.`，
 * React 根本没机会渲染 —— 页面全白、控制台一条错误，使用者完全不知道该怎么办。
 * 2026-09-24 线上黑屏就是这么来的（Vercel 项目丢了环境变量）。
 * 开源模板被 clone 下来、还没配库时，看到的就是这一页。
 */
function MissingConfig() {
  return (
    <div className="aurora">
      <div className="aurora__blob aurora__blob--1" /><div className="aurora__blob aurora__blob--2" />
      <div className="login-wrap">
        <div className="login-card glass card" style={{ maxWidth: 560 }}>
          <div className="card__title" style={{ marginBottom: 14 }}>
            <Icon name="settings" size={18} /> 还差一步：配置你的数据库
          </div>
          <div className="tx-2" style={{ fontSize: 13.5, lineHeight: 1.75 }}>
            本站没有自己的服务器，数据存在<b>你自己的 Supabase</b> 里。当前构建没有读到连接信息，
            所以还没法登录。
          </div>
          <div className="tx-3" style={{ fontSize: 12.5, lineHeight: 1.9, marginTop: 14 }}>
            <div>① 在项目根目录把 <code>.env.example</code> 复制为 <code>.env.local</code></div>
            <div>② 填入两行（Supabase 后台 → Project Settings → API）：</div>
          </div>
          <pre className="mono" style={{
            fontSize: 11.5, lineHeight: 1.7, marginTop: 10, padding: '10px 12px',
            borderRadius: 10, background: 'var(--glass-bg)', border: '1px solid var(--glass-brd)',
            overflowX: 'auto', whiteSpace: 'pre',
          }}>{`VITE_SUPABASE_URL=https://<你的项目>.supabase.co
VITE_SUPABASE_ANON_KEY=<你的 anon public key>`}</pre>
          <div className="tx-3" style={{ fontSize: 12, lineHeight: 1.7, marginTop: 12 }}>
            改完<b>重新构建</b>（<code>npm run build</code>）才会生效；部署到 Vercel 的话，
            这两个变量要配在 Project Settings → Environment Variables，然后再部署一次。
          </div>
          <div className="tx-3" style={{ fontSize: 11.5, lineHeight: 1.7, marginTop: 12, opacity: .85 }}>
            提示：<code>anon key</code> 是公开信息，会随页面发给访客，安全性由数据库的 RLS 策略保证；
            但 <code>service_role key</code> 绝不能填进来。
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  /* ?agent=1 → 「独立窗口」模式：整页只有 AI 助手，便于单独开一个浏览器标签长期对话 */
  const agentOnly = typeof location !== 'undefined' && new URLSearchParams(location.search).get('agent') === '1';
  return <CloudApp agentOnly={agentOnly} />;
}
