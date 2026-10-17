-- 秋招网申辅助中心 - 简历存储 Bucket 初始化
-- 请在 Supabase Dashboard → SQL Editor 中运行此脚本

-- ============================================
-- 创建 resumes 存储 Bucket
-- ============================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('resumes', 'resumes', false)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 存储策略：用户只能访问自己的简历文件
-- ============================================

-- 允许用户上传文件到自己的目录
CREATE POLICY "Users can upload own resumes"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- 允许用户查看自己的简历文件
CREATE POLICY "Users can view own resumes"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- 允许用户删除自己的简历文件
CREATE POLICY "Users can delete own resumes"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
);

-- 允许用户更新自己的简历文件
CREATE POLICY "Users can update own resumes"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'resumes' AND
  (storage.foldername(name))[1] = auth.uid()::text
);
