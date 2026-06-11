-- Fix: update_vote_count trigger function referenced "reports" without schema prefix.
-- Supabase runs triggers with an empty search_path for security, causing 42P01.
-- Solution: qualify the table with public. and set search_path explicitly.

CREATE OR REPLACE FUNCTION update_vote_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.reports
    SET vote_count = vote_count + 1
    WHERE id = NEW.report_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.reports
    SET vote_count = GREATEST(vote_count - 1, 0)
    WHERE id = OLD.report_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
