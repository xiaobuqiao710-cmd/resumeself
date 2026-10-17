import React from 'react';
import { Modal, Button } from './Kit';
import { Icon } from './Icon';
import { NAV_GROUPS } from '../layout/nav';
import { ADMIN_CONTACT } from '../modules/Login';
import type { ViewId } from '../../types';

/**
 * 新手指南 —— 回答新用户打开网站后的两个问题：「这玩意儿能帮我做什么？」「设置里那一堆是干嘛的？」
 *
 * 为什么要有它（而不是指望用户自己摸索）：
 *   站内有 7 个导航分组、14 个标签页、最多 5 个设置分页。作者自己清楚哪块在哪，新用户不清楚 ——
 *   他看到的是一个空荡荡的「今日总览」和一堆没见过的名词，最常见的反应是关掉页面。
 *   登录页左侧那一栏只讲了「有什么」，讲不了「怎么开始」和「设置要不要配」。这份指南补的就是这一段。
 *
 * 设计取舍：
 *   ① 内容**全部从 NAV_GROUPS 派生**（左侧导航的唯一事实来源）。改导航就等于改指南，
 *      不会出现「新增了板块但教程里没有」的漂移。设置那一节是手写的 —— 它描述的是
 *      「这一项要不要配、不配会怎样」，属于产品意图，从代码里推不出来。
 *   ② 首次进站自动弹一次（localStorage 记 qz.guideSeen），之后只从顶栏「?」和设置里进 ——
 *      每次都弹会变成骚扰。
 *   ③ 每一块都能点进对应板块，看完就能直接上手，而不是「读完还得自己找路」。
 */
export const GUIDE_SEEN_KEY = 'qz.guideSeen';

export function guideSeen(): boolean {
  /* 读不到 localStorage（隐私模式等）时按「看过了」处理：宁可少弹一次，也不要每次刷新都弹。 */
  try { return localStorage.getItem(GUIDE_SEEN_KEY) === '1'; } catch { return true; }
}

export function markGuideSeen(): void {
  try { localStorage.setItem(GUIDE_SEEN_KEY, '1'); } catch { /* ignore */ }
}

/** 建议的上手顺序。四步，每步都能点进去 —— 空站最难的就是「我该从哪下手」。 */
const STEPS: { icon: string; title: string; desc: string; go: ViewId }[] = [
  {
    icon: 'layers', title: '先把「我的资料」填一遍', go: 'database',
    desc: '网申资料库有 12 大板块（个人信息、教育、实习、项目、获奖…）。填完之后每个字段旁边都有复制按钮，'
      + '网申时直接粘进企业表单 —— 这是回报最高的一步，后面投几十家都靠它。',
  },
  {
    icon: 'target', title: '把岗位装进「岗位库」', go: 'jobs',
    desc: '手上已经有整理好的汇总表（Markdown / 表格文本）就直接拖进「设置 → 数据与备份 → ①」，'
      + '或者把桌面上任意 .md / .json / .csv / .ics 拖到「② 从本机文件导入」，它会自己判断该进哪个板块；'
      + '站内会解析成结构化岗位，反复导入也不会重复堆积；零散看到的就手加一条。'
      + '填了截止日会进顶部提醒条，也能导出成手机日历的 ICS；想让日程出现在「日历与截止」页，'
      + '用岗位上的「转入网申记录」。',
  },
  {
    icon: 'building', title: '投出去，然后在看板里流转', go: 'applications',
    desc: '投一家就在「投递记录」建一条，状态从「待投递」一路推到「已收 Offer」。'
      + '状态一改，岗位库和截止提醒会自动对账，不会两处各说各话。',
  },
  {
    icon: 'bell', title: '让它替你记事', go: 'calendar',
    desc: '截止提醒有三条腿：打开网站时的顶部提醒条、浏览器系统通知（装成 PWA 后手机同样生效）、'
      + '以及能导入手机日历的 ICS 文件。想要真的「到点响」，导 ICS 进手机日历最稳。',
  },
];

/** 设置里的五页。用户最常问的就是「这五项我要不要配、不配会怎样」，所以每项都标了「必要性」。 */
const SETTINGS_ITEMS: { icon: string; name: string; need: string; tone: string; desc: string }[] = [
  {
    icon: 'user', name: '云端与同步', need: '必看', tone: 'badge--ok',
    desc: '你的账号、当前同步状态、「立即同步到云端」、修改密码、退出登录。数据存在你自己的账号里，'
      + '换电脑或手机登录同一个账号就能看到同一份。旧「本机版」站点的数据也能搬过来：'
      + '先在旧站「导出 JSON 备份」，再回到这里「导入并合并」。'
      + '（未登录时这一页不显示，设置里只有其余四项。）',
  },
  {
    icon: 'sun', name: '外观与提醒', need: '建议看一眼', tone: 'badge--muted',
    desc: '深色 / 浅色切换；开启浏览器系统通知；设置提前几天提醒（默认 7、3、1 天）以及提醒哪几类事。'
      + '想让它真的提醒你，记得把 ICS 导入手机日历。',
  },
  {
    icon: 'mail', name: '邮件桥', need: '可选 · 不装完全不影响', tone: 'badge--muted',
    desc: '一个跑在你自己电脑上的小程序，让「邮件中心」能读你的邮箱。浏览器没法直接说 IMAP 协议，'
      + '也不该把邮箱密码交给任何网站，所以中间需要它。不装它，其它板块一切照常。',
  },
  {
    icon: 'sparkles', name: 'AI 助手', need: '可选 · 有它更好用', tone: 'badge--muted',
    desc: '填任意 OpenAI 兼容接口的 Key（DeepSeek、智谱、Kimi 等）即可解锁：JD 智能录入、简历匹配度、'
      + '公司背景、题库 AI 分类与参考答案、邮件代写、资料一键生成，以及把「邮件中心」收件箱里的邮件'
      + '自动同步成投递状态。Key 只存这台设备、不会同步到云端账号，换设备要重填。'
      + '另外顶栏的 ✨ 打开的是一个对话式助手：可以直接用中文让它查站内数据、改岗位与投递状态、加日历、'
      + '清理重复岗位 —— 涉及删除的操作会先弹一张确认卡，你点了才动。'
      + '再往下还有一个可选的「联网搜索」Key（博查）：填了之后这个助手就能去互联网上查招聘公告、'
      + '岗位待遇、笔试面试经验，并在回答里附上来源链接。不填它就只查站内数据。',
  },
  {
    icon: 'download', name: '数据与备份', need: '重要', tone: 'badge--ok',
    desc: '批量导入秋招汇总表、从本机文件导入（把桌面上的 .md / .json / .csv / .ics 拖进来，'
      + '自动识别该进岗位库还是题库 / 日历 / 人脉，确认后再写入；题库里的题还能按「仓库」归到某家公司或某个行业）、'
      + '导出整站 JSON 备份、导入并合并、'
      + '导出岗位 CSV / 日历 ICS、快照回滚，以及「清空全部数据」。换设备、想留底、想重来，都从这里走。',
  },
];

/** 常见问题。挑的都是「用户真正会卡住」的，不是凑数的。 */
const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: '忘记密码了怎么办？',
    a: <>本站走<b>人工重置</b>：在登录页点「忘记密码」→「复制我的邮箱」，把邮箱发给站长{ADMIN_CONTACT ? <>（<b>{ADMIN_CONTACT}</b>）</> : ''}，
      站长核对后给你一个临时密码，登录后到<b>「设置 → 云端与同步 → 修改密码」</b>改成你自己的。
      之所以不给自助重置，是因为免费发信通道额度极小、邮件经常发不出去或进垃圾箱 —— 点了没反应比没有这个功能更糟。</>,
  },
  {
    q: '数据存在哪？会不会丢？',
    a: <>存在<b>你自己的账号</b>里（云端数据库），同时在本机浏览器留一份完整副本 —— 断网、云端临时不可用时站点照常能打开。
      想额外留底，到「设置 → 数据与备份 → 导出 JSON 备份」存一份文件即可。</>,
  },
  {
    q: '别人能看到我的数据吗？',
    a: <>不能。每一张表都启用了<b>行级安全策略（RLS）</b>，在数据库层面就只允许你自己的账号读写你自己的那几行 ——
      就算有人拿到公开的接口地址也读不到。AI Key、邮件桥令牌这类敏感配置更是只存在本机、压根不上传。</>,
  },
  {
    q: '手机上能用吗？',
    a: <>能，浏览器直接打开就行。想要截止提醒在手机上真的响，用浏览器的「添加到主屏幕」装成 PWA，
      再开启系统通知；最稳的办法仍然是导出 ICS 导入手机日历。</>,
  },
  {
    q: 'AI 功能要额外花钱吗？',
    a: <>本站不收费、不放广告。AI 是「接你自己的 Key」—— 请求直连你选的那家服务商，本站不代转、不留存，
      费用也直接结算给那家（很多家都有免费额度）。不填 Key 照样能管岗位、投递、资料与提醒；只有上面那些 AI 专属功能会提示你去填 Key（站内有简单的关键词兜底，能认出常见汇总表格式）。</>,
  },
];

export function Guide({ open, onClose, onNavigate, onOpenSettings }: {
  open: boolean;
  onClose: () => void;
  onNavigate?: (v: ViewId) => void;
  onOpenSettings?: () => void;
}) {
  const go = (v?: ViewId) => {
    if (!v) return;
    onNavigate?.(v);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} wide icon="sparkles" title="三分钟上手"
      footer={<Button variant="primary" onClick={onClose}>知道了，开始用</Button>}>
      <div className="guide">
        <p className="guide__lead">
          秋招要同时盯着<b>岗位、截止日、投递进度、网申资料、笔面复盘、Offer 对比</b>这几摊事。
          本站把它们收进一个地方，而且<b>互相对账</b> —— 你在投递记录里把状态推进一步，
          岗位库和截止提醒会跟着变，不用两处各记一遍。
        </p>

        <h3 className="guide__h">一、左侧导航那七块，分别能帮你做什么</h3>
        <div className="guide__grid">
          {NAV_GROUPS.map((g) => (
            <div className="guide__card" key={g.id}>
              <button className="guide__cardhead" onClick={() => go(g.tabs[0].id)}>
                <span className="guide__ico"><Icon name={g.icon} size={16} /></span>
                <b>{g.label}</b>
                <Icon name="chevronR" size={13} />
              </button>
              <ul className="guide__tabs">
                {g.tabs.map((t) => (
                  <li key={t.id}>
                    <button className="guide__tab" onClick={() => go(t.id)}>{t.label}</button>
                    <span className="tx-4"> · {t.desc}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <h3 className="guide__h">二、建议这么开始（按顺序做，别一上来就铺开）</h3>
        <ol className="guide__steps">
          {STEPS.map((s) => (
            <li key={s.title}>
              <span className="guide__ico"><Icon name={s.icon} size={16} /></span>
              <span className="guide__stepbody">
                <button className="guide__stepTitle" onClick={() => go(s.go)}>{s.title} →</button>
                <span className="tx-3">{s.desc}</span>
              </span>
            </li>
          ))}
        </ol>

        <h3 className="guide__h">
          三、设置里那几项，分别管什么
          {onOpenSettings && (
            <button className="guide__inlineBtn" onClick={() => { onClose(); onOpenSettings(); }}>
              直接打开设置 →
            </button>
          )}
        </h3>
        <div className="guide__settings">
          {SETTINGS_ITEMS.map((it) => (
            <div className="guide__sitem" key={it.name}>
              <div className="guide__shead">
                <span className="guide__ico"><Icon name={it.icon} size={15} /></span>
                <b>{it.name}</b>
                <span className={`badge ${it.tone}`}>{it.need}</span>
              </div>
              <div className="tx-3 guide__sdesc">{it.desc}</div>
            </div>
          ))}
        </div>

        <h3 className="guide__h">四、几个一定会遇到的问题</h3>
        <div className="guide__faq">
          {FAQ.map((f) => (
            <details className="guide__qa" key={f.q}>
              <summary>{f.q}</summary>
              <div className="tx-3">{f.a}</div>
            </details>
          ))}
        </div>

        <div className="guide__foot">
          <Icon name="info" size={13} />
          <span>
            想再看一遍：点右上角的 <b>ⓘ 教程按钮</b>，或「设置」弹窗最上面那条。
            本站不收费、不放广告，数据只属于你自己的账号。
          </span>
        </div>
      </div>
    </Modal>
  );
}
