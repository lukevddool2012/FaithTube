const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL ontbreekt. Stel deze in bij de omgevingsvariabelen van Render.");
}

// Supabase vereist een versleutelde databaseverbinding.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
    console.error("Onverwachte fout in de PostgreSQL-verbinding:", error);
});

async function checkDatabaseConnection() {
    const result = await pool.query("SELECT NOW() AS database_time");
    return result.rows[0];
}

module.exports = { pool, checkDatabaseConnection };
