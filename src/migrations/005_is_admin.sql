-- Fonction réutilisable dans toutes les policies
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT auth.jwt() -> 'user_metadata' ->> 'role') = 'admin',
    false
  );
$$;