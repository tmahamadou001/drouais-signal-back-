-- Migration 008: Add map_radius_km to tenant_configs
-- Defines the allowed perimeter radius (in km) for report creation per tenant

ALTER TABLE tenant_configs
  ADD COLUMN IF NOT EXISTS map_radius_km INTEGER NOT NULL DEFAULT 15;
