-- 018: Drop app_store tables — feature belongs in genie-os, not genie CLI.
DROP TABLE IF EXISTS app_versions CASCADE;
DROP TABLE IF EXISTS installed_apps CASCADE;
DROP TABLE IF EXISTS app_store CASCADE;
