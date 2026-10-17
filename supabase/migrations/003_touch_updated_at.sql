-- ============================================
-- 让 profiles.updated_at 真正由**数据库**来写
-- 请在 Supabase Dashboard → SQL Editor 中运行此脚本
-- ============================================
--
-- 为什么必须有这个触发器
-- ----------------------
-- 前端 src/lib/cloudState.ts 的 saveCloudState 是：
--     .upsert({ user_id, data, updated_at: savedAt }, { onConflict: 'user_id' })
--     .select('updated_at')
-- 也就是把本机时钟填进 updated_at，再把这一列读回来当「云端是什么时候写的」。
--
-- 而 001_init.sql 建的 profiles 表上**没有任何触发器**，列定义只有
--     updated_at TIMESTAMPTZ DEFAULT NOW()
-- 它的 DEFAULT 只在 INSERT 时生效；走 upsert 的 UPDATE 分支时，
-- 客户端传什么就存什么。所以那个时间戳其实是**写入设备的本机时钟**。
--
-- 实测证据（2026-09-23，真实项目库）：带上 ?on_conflict=user_id 写入
-- updated_at='2000-01-01T00:00:00.000Z'，读回来的就是 2000-01-01T00:00:00+00:00。
--
-- 后果正好是多设备防覆盖那套逻辑想避免的事
-- ----------------------------------------
-- 设备 A 时钟准、设备 B 时钟慢两小时：
--   B 后改的数据，updated_at 反而比 A 早 → A 重新获得焦点时判定「云端不比我的新」，
--   既不提醒也不拦截，A 下一次写入就把 B 的改动整片覆盖掉，全程没有任何提示。
-- 反之设备时钟偏快，会让所有设备都以为「云端更新了」，反复弹无意义的刷新提醒。
--
-- 装上触发器后：BEFORE INSERT OR UPDATE 把 NEW.updated_at 强制改成 NOW()，
-- 客户端传什么都会被覆盖，.select('updated_at') 读回的才是真正的服务端时间。
-- （NOW() 取的是事务时间，而 PostgREST 每个请求各自一个事务，等价于请求时刻。）

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_touch_updated_at ON public.profiles;

CREATE TRIGGER profiles_touch_updated_at
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

-- 自检：下面这条应当返回触发器名称 profiles_touch_updated_at
--   SELECT tgname FROM pg_trigger
--   WHERE tgrelid = 'public.profiles'::regclass AND NOT tgisinternal;
