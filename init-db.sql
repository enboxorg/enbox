-- Initialize DWN database
-- The DWN server will handle creating its own tables and schemas

-- Ensure the database exists (already created by POSTGRES_DB)
-- This file can be extended with any custom initialization if needed

-- Log successful initialization
DO $$
BEGIN
    RAISE NOTICE 'DWN database initialized successfully';
END $$;