import React, { useRef, useState } from 'react';
import { Icon } from './Icon';
import { getPhoto, setPhotoFromFile, clearPhoto } from '../../lib/photo';

/**
 * 证件照位：照片来自本机 localStorage（见 lib/photo.ts），站点不打包任何个人图片。
 * 点击可上传/替换，右侧小按钮可移除。
 */
export function PhotoSlot({ size = 92, editable = true }: { size?: number; editable?: boolean }) {
  const [photo, setPhoto] = useState<string | null>(() => getPhoto());
  const [err, setErr] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  const pick = async (f?: File) => {
    if (!f) return;
    setErr('');
    try { setPhoto(await setPhotoFromFile(f)); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="col gap-6" style={{ alignItems: 'center' }}>
      <input ref={ref} type="file" accept="image/*" hidden
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {photo ? (
        <img src={photo} alt="证件照" className="profile-photo"
          style={{ width: size, height: size, cursor: editable ? 'pointer' : 'default' }}
          onClick={() => editable && ref.current?.click()} />
      ) : (
        <button type="button" onClick={() => editable && ref.current?.click()}
          className="profile-photo"
          style={{
            width: size, height: size, display: 'grid', placeItems: 'center', gap: 4,
            border: '1.5px dashed var(--glass-brd-strong)', background: 'var(--glass-bg)',
            color: 'var(--tx-3)', cursor: editable ? 'pointer' : 'default',
          }}
          title={editable ? '点击上传证件照（仅存本机浏览器）' : '未上传证件照'}>
          <Icon name="user" size={Math.round(size / 3)} />
          <span style={{ fontSize: 10 }}>{editable ? '上传照片' : '未上传'}</span>
        </button>
      )}
      {editable && photo && (
        <button className="copy-btn" onClick={() => { clearPhoto(); setPhoto(null); }}>移除</button>
      )}
      {err && <span className="badge badge--danger" style={{ fontSize: 10 }}>{err}</span>}
      {editable && !err && <span className="tx-4" style={{ fontSize: 10 }}>仅存本机，不上云</span>}
    </div>
  );
}
