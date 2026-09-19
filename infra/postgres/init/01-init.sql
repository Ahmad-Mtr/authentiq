-- Runs once, on first boot of an empty volume.

-- Storage for the local PLC directory.
CREATE DATABASE plc;

-- AppView index: vector search for talent discovery (G3).
\connect authentiq
CREATE EXTENSION IF NOT EXISTS vector;
