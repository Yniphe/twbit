-- Runs only when initializing an empty PostgreSQL volume, as the bootstrap administrator.
DO $init$
BEGIN
    EXECUTE format('CREATE ROLE twbit LOGIN PASSWORD %L', btrim(pg_read_file('/run/secrets/postgres_password'), E' \t\r\n'));
END
$init$;
REVOKE ALL ON DATABASE twbit FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE twbit TO twbit;
CREATE SCHEMA twbit AUTHORIZATION twbit;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
