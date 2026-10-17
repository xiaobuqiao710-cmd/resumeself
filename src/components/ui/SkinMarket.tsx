import React from 'react';
import { Modal, Button } from './Kit';
import { Icon } from './Icon';
import { cn } from '../../lib/util';
import { SKINS, skinDef, type SkinDef } from '../../lib/skins';
import { useStore } from '../../store/store';

/**
 * 皮肤市场。
 *
 * 三件事决定了它的形态：
 *
 * ① **预览必须是真预览**。每张卡里的缩略图不是截图、也不是另画的一张小图，
 *    而是把 `data-skin` / `data-theme` 直接写在卡片内的一个 div 上，让它局部继承
 *    那套皮肤的真实 CSS 变量来作画（见 skins.css 顶部的约定 ①）。
 *    代价是零，收益是「预览与点下去之后看到的东西不可能不一致」——
 *    手绘预览最典型的翻车就是色板对不上，用户点完觉得被骗了。
 *
 * ② **点击即应用，不关弹窗**。换皮肤是"逛"出来的行为：看一眼、换一个、再看一眼。
 *    每次都要重新打开市场就完全没法比较。所以点完只弹一句提示，市场留着。
 *
 * ③ **不动数据**。这段文案必须写在最显眼处 —— 「换个皮肤会不会把我填的东西搞乱」
 *    是这类功能的头号顾虑，不主动说清就会变成犹豫的理由。
 */
export function SkinMarket({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { skin, setSkin, toast } = useStore();

  const apply = (s: SkinDef) => {
    if (s.id === skin) return;
    setSkin(s.id);
    toast(`已换上「${s.name}」`);
  };

  return (
    <Modal open={open} onClose={onClose} icon="palette" title="皮肤市场" wide
      footer={<Button variant="primary" onClick={onClose}>完成</Button>}>

      <div className="skmkt__lead">
        <Icon name="info" size={14} />
        <span>
          皮肤只换<b>外观</b> —— 底色、圆角、字体、质感。数据、布局、功能一个字都不动，
          随时可以换回来。选择会跟着账号同步到其它设备。
        </span>
      </div>

      <div className="skmkt">
        {SKINS.map((s) => {
          const on = s.id === skin;
          return (
            <button key={s.id} type="button"
              className={cn('skmkt__card', on && 'skmkt__card--on')}
              onClick={() => apply(s)}
              aria-pressed={on}
              title={on ? `${s.name}（使用中）` : `换成 ${s.name}`}>

              {/* 真预览：data-skin / data-theme 挂在卡片自己身上，变量就在这里解析 */}
              <div className="skpv" data-skin={s.skin} data-theme={s.theme} aria-hidden="true">
                {on && <span className="skpv__on"><Icon name="check" size={10} />使用中</span>}

                <div className="skpv__side">
                  <div className="skpv__logo" />
                  <div className="skpv__navrow"><i className="skpv__navdot" /><span className="skpv__line skpv__w70" /></div>
                  <div className="skpv__navrow"><i className="skpv__navdot" /><span className="skpv__line skpv__w55" /></div>
                  <div className="skpv__navrow"><i className="skpv__navdot" /><span className="skpv__line skpv__w70" /></div>
                </div>

                <div className="skpv__main">
                  <div className="skpv__head">
                    <span className="skpv__h" />
                    <span className="skpv__pill" />
                  </div>
                  <div className="skpv__row">
                    <div className="skpv__card">
                      <span className="skpv__line" /><span className="skpv__line skpv__line--sm" />
                    </div>
                    <div className="skpv__card">
                      <span className="skpv__line" /><span className="skpv__line skpv__line--sm" />
                    </div>
                  </div>
                  <div className="skpv__foot">
                    <span className="skpv__line skpv__line--sm skpv__w85" />
                  </div>
                </div>
              </div>

              <div className="skmkt__meta">
                <div className="skmkt__name">
                  {s.name}
                  <span className="skmkt__dots">
                    {s.swatch.map((c) => <i key={c} className="skmkt__dot" style={{ background: c }} />)}
                  </span>
                </div>
                <div className="skmkt__sub">{s.sub}</div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="skmkt__lead" style={{ marginTop: 16, marginBottom: 0 }}>
        <Icon name="sparkles" size={14} />
        <span>
          当前在用：<b>{skinDef(skin).name}</b>。
          每款皮肤自带明暗基调，没有单独的深 / 浅色开关 —— 想换明暗就换一张卡，
          点一下即生效，市场会留在原地方便你挨个比。
        </span>
      </div>
    </Modal>
  );
}

export default SkinMarket;
