import React from 'react';
import { Button } from './Kit';
import { Icon } from './Icon';
import { healIfStale, isStaleChunkError, reloadToLatest } from '../../lib/selfHeal';

interface State { error: Error | null; }

/**
 * 错误边界：任何板块渲染出错都不该白屏 —— 数据在 localStorage 里，只要不崩就能导出。
 * 出错时给出「导出数据」入口，避免用户以为数据丢了。
 *
 * 特别区分「版本过期」：新部署上线后旧标签页里的懒加载 chunk 已被删除，
 * 报 "Failed to fetch dynamically imported module"，这不是代码坏了，刷新即好，因此直接给刷新入口。
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode; label?: string }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 仅本地记录，不上报任何数据
    console.error('[秋招中心] 板块渲染出错', this.props.label || '', error, info.componentStack);
    // 版本过期导致 chunk 404：直接自愈刷新（15 秒冷却，避免循环）
    healIfStale(error.message);
  }

  private exportBackup = () => {
    try {
      const raw = localStorage.getItem('qz.cloud.default') || '{}';
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = `秋招数据备份-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { /* ignore */ }
  };

  render() {
    if (!this.state.error) return this.props.children;
    const stale = isStaleChunkError(this.state.error.message);
    return (
      <div className="glass card" style={{ margin: 8 }}>
        <div className="row gap-12" style={{ alignItems: 'flex-start' }}>
          <span className="acc__ico"><Icon name="alert" size={18} /></span>
          <div className="grow">
            <div className="h-sub">
              {stale
                ? `「${this.props.label || '当前板块'}」需要刷新到最新版`
                : `「${this.props.label || '当前板块'}」渲染出错`}
            </div>
            <div className="tx-3" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7 }}>
              {stale
                ? '网站刚发布了新版，这个页面还是旧版，所以加载不到对应文件。你的数据仍在浏览器本地，没有丢失 —— 点下面的按钮刷新一下即可恢复。'
                : '你的数据仍在浏览器本地，没有丢失。可以先导出备份，再刷新页面重试。'}
            </div>
            <pre className="tx-4 mono" style={{ fontSize: 11, marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
              {this.state.error.message}
            </pre>
            <div className="row gap-8" style={{ marginTop: 12 }}>
              {stale
                ? <Button size="sm" variant="primary" icon="refresh" onClick={reloadToLatest}>刷新到最新版</Button>
                : <Button size="sm" icon="refresh" onClick={() => this.setState({ error: null })}>重试</Button>}
              <Button size="sm" icon="download" onClick={this.exportBackup}>导出数据备份</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
