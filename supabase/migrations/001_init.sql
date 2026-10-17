-- 秋招网申辅助中心 - Supabase 数据库初始化脚本
-- 请在 Supabase Dashboard → SQL Editor 中运行此脚本

-- ============================================
-- 1. 个人资料表（存储用户填写的网申信息）
-- ============================================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- ============================================
-- 2. 网申记录表
-- ============================================
CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  company TEXT NOT NULL,
  position TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  channel TEXT,
  location TEXT,
  deadline TEXT,
  link TEXT,
  salary TEXT,
  notes TEXT,
  contact TEXT,
  submitted_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  timeline JSONB DEFAULT '[]'
);

-- ============================================
-- 3. 日历事件表
-- ============================================
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  type TEXT NOT NULL DEFAULT 'other',
  app_id UUID,
  note TEXT,
  source TEXT DEFAULT 'manual',
  done BOOLEAN
);

-- ============================================
-- 4. 岗位追踪表
-- ============================================
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  city TEXT,
  salary TEXT,
  source TEXT,
  url TEXT,
  jd TEXT,
  requirements TEXT,
  deadline TEXT,
  match JSONB,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT,
  updated_at TEXT
);

-- ============================================
-- 5. 笔试题库表
-- ============================================
CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'written',
  category TEXT NOT NULL DEFAULT '其他',
  content TEXT NOT NULL,
  answer TEXT,
  analysis TEXT,
  company TEXT,
  year TEXT,
  difficulty TEXT,
  mastered BOOLEAN DEFAULT FALSE,
  created_at TEXT
);

-- ============================================
-- 6. 公司背景表
-- ============================================
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  company TEXT NOT NULL,
  info JSONB DEFAULT '{}',
  updated_at TEXT
);

-- ============================================
-- 7. 应用状态表（存储主题、简历文本等）
-- ============================================
CREATE TABLE IF NOT EXISTS app_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  theme TEXT DEFAULT 'dark',
  resume_text TEXT,
  UNIQUE(user_id)
);

-- ============================================
-- 启用行级安全 (RLS)
-- ============================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_state ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 创建 RLS 策略（每个用户只能访问自己的数据）
-- ============================================

-- profiles
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = user_id);

-- applications
CREATE POLICY "Users can view own applications" ON applications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own applications" ON applications FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own applications" ON applications FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own applications" ON applications FOR DELETE USING (auth.uid() = user_id);

-- events
CREATE POLICY "Users can view own events" ON events FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own events" ON events FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own events" ON events FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own events" ON events FOR DELETE USING (auth.uid() = user_id);

-- jobs
CREATE POLICY "Users can view own jobs" ON jobs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own jobs" ON jobs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own jobs" ON jobs FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own jobs" ON jobs FOR DELETE USING (auth.uid() = user_id);

-- questions
CREATE POLICY "Users can view own questions" ON questions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own questions" ON questions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own questions" ON questions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own questions" ON questions FOR DELETE USING (auth.uid() = user_id);

-- companies
CREATE POLICY "Users can view own companies" ON companies FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own companies" ON companies FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own companies" ON companies FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own companies" ON companies FOR DELETE USING (auth.uid() = user_id);

-- app_state
CREATE POLICY "Users can view own state" ON app_state FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own state" ON app_state FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own state" ON app_state FOR UPDATE USING (auth.uid() = user_id);

-- ============================================
-- 创建索引（加速查询）
-- ============================================
CREATE INDEX idx_applications_user_id ON applications(user_id);
CREATE INDEX idx_events_user_id ON events(user_id);
CREATE INDEX idx_jobs_user_id ON jobs(user_id);
CREATE INDEX idx_questions_user_id ON questions(user_id);
CREATE INDEX idx_companies_user_id ON companies(user_id);
