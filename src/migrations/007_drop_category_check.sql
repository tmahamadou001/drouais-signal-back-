-- Migration 007: Drop hardcoded category CHECK constraint
-- Categories are now dynamic per tenant (tenant_categories table)
-- The static CHECK (category IN ('voirie','eclairage','dechets','autre')) blocks tenant custom categories

ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_category_check;
