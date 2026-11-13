
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const webpush = require("web-push");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const db = require("./database");
const dropbox = require("./dropbox");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

// Eenvoudige bescherming tegen herhaald proberen in te loggen of accounts aan te maken.
const authRateLimits = new Map();
function limitAuthAttempts(req, res, next) {
    const key = String(req.ip || req.socket.remoteAddress || "unknown");
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const maxAttempts = 10;
    let entry = authRateLimits.get(key);
    if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
    }
    if (entry.count >= maxAttempts) {
        return res.status(429).json({ error: "Te veel pogingen. Probeer het over 15 minuten opnieuw." });
    }
    entry.count += 1;
    authRateLimits.set(key, entry);
    next();
}

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = "lukevandendool2012@gmail.com";
const ADDITIONAL_ADMIN_EMAIL = "zilanzaal1504@gmail.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;


if (!JWT_SECRET || !ADMIN_PASSWORD) {
    console.error("JWT_SECRET of ADMIN_PASSWORD ontbreekt.");
    process.exit(1);
}

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(uploadDir));

// Extra databasevelden voor Bijbelstudies
function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();

    if (!columns.some(item => item.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

ensureColumn("videos", "bible_reference", "TEXT");
ensureColumn("videos", "study_content", "TEXT");
ensureColumn("users", "profile_image", "TEXT");
ensureColumn("users", "bio", "TEXT");
ensureColumn("videos", "views_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("videos", "thumbnail_url", "TEXT");

// Kanalen volgen
db.exec(`
    CREATE TABLE IF NOT EXISTS follows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        follower_id INTEGER NOT NULL,
        followed_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(follower_id, followed_id)
    );
`);

// Kijkgeschiedenis en meldingen
db.exec(`
    CREATE TABLE IF NOT EXISTS watch_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        video_id INTEGER NOT NULL,
        watched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, video_id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);


// Meldingen voor het beheerdersaccount over nieuwe inzendingen.
db.exec(`CREATE TABLE IF NOT EXISTS admin_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    video_id INTEGER,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Web push-abonnementen per gebruiker.
db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    subscription_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
ensureColumn("videos", "captions_url", "TEXT");
ensureColumn("videos", "dropbox_video_path", "TEXT");
ensureColumn("videos", "dropbox_thumbnail_path", "TEXT");

// Meldingen van gebruikers over ongepaste inhoud.
db.exec(`CREATE TABLE IF NOT EXISTS video_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    reporter_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    details TEXT DEFAULT "",
    status TEXT NOT NULL DEFAULT "open",
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Bewaar profielgegevens van het aparte beheerdersaccount.
db.exec(`CREATE TABLE IF NOT EXISTS admin_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    profile_image TEXT DEFAULT "",
    bio TEXT DEFAULT ""
)`);

// App-instellingen worden bewaard voor migraties en eenmalige accountinstellingen.
// BELANGRIJK: serverstart mag nooit bestaande gebruikers, video's of uploads wissen.
db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL
    )
`);

// Houd Zilans account beheerder. Stel het wachtwoord alleen in via Render.
(async () => {
    const configuredPassword = process.env.ZILAN_ADMIN_PASSWORD;
    if (configuredPassword) {
        if (configuredPassword.length < 8 || configuredPassword.length > 72) {
            throw new Error("ZILAN_ADMIN_PASSWORD moet 8 tot 72 tekens bevatten.");
        }
        const passwordReset = db.prepare(
            "SELECT setting_value FROM app_settings WHERE setting_key = ?"
        ).get("zilan_admin_password_reset_v2");

        if (!passwordReset) {
            const passwordHash = await bcrypt.hash(configuredPassword, 12);
            const existing = db.prepare(
                "SELECT id FROM users WHERE lower(email) = ?"
            ).get(ADDITIONAL_ADMIN_EMAIL);

            if (existing) {
                db.prepare(
                    "UPDATE users SET name = ?, password = ?, role = 'admin', verified = 1 WHERE id = ?"
                ).run("Zilan Zaal", passwordHash, existing.id);
            } else {
                db.prepare(
                    "INSERT INTO users (name, email, password, role, verified) VALUES (?, ?, ?, 'admin', 1)"
                ).run("Zilan Zaal", ADDITIONAL_ADMIN_EMAIL, passwordHash);
            }

            db.prepare(
                "INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)"
            ).run("zilan_admin_password_reset_v2", "done");
        }
    }

    db.prepare(
        "UPDATE users SET name = ?, role = 'admin', verified = 1 WHERE lower(email) = ?"
    ).run("Zilan Zaal", ADDITIONAL_ADMIN_EMAIL);
})().catch(error => {
    console.error("Zilans beheerdersaccount instellen is mislukt:", error);
    process.exit(1);
});

// Video uploads
const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        callback(null, `${Date.now()}-${require("crypto").randomUUID()}${extension}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024, fieldSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, callback) => {
        if (!file.mimetype.startsWith("video/")) {
            return callback(new Error("Alleen videobestanden zijn toegestaan."));
        }
        callback(null, true);
    }
});

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || "";
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || "";
const vapidSubject = process.env.VAPID_SUBJECT || "mailto:beheer@faithtube.nl";
const pushEnabled = Boolean(vapidPublicKey && vapidPrivateKey);
if (pushEnabled) webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
async function sendPushToUser(userId, payload) {
    if (!pushEnabled) return;
    const rows = db.prepare("SELECT id, subscription_json FROM push_subscriptions WHERE user_id = ?").all(userId);
    for (const row of rows) {
        try { await webpush.sendNotification(JSON.parse(row.subscription_json), JSON.stringify(payload)); }
        catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(row.id);
            else console.error("Pushmelding mislukt:", error.message);
        }
    }
}

// Inlogcontrole
function authenticate(req, res, next) {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Je moet eerst inloggen." });
    }

    try {
        req.user = jwt.verify(header.slice(7), JWT_SECRET);
        if (req.user.role !== "admin" && !getUser(req.user.id)) {
            return res.status(401).json({ error: "Dit account bestaat niet meer. Maak een nieuw account aan." });
        }
        next();
    } catch {
        return res.status(401).json({ error: "Je sessie is ongeldig." });
    }
}

// Beheerderscontrole
function adminOnly(req, res, next) {
    if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Geen beheerderstoegang." });
    }

    next();
}

// Gebruiker ophalen
function getUser(id) {
    return db.prepare(`
        SELECT id, name, email, role, verified
        FROM users
        WHERE id = ?
    `).get(id);
}

// Server startpagina
app.get("/", (req, res) => {
    res.send("Welkom bij de FaithTube-server!");
});

// Dropbox-koppeling: alleen beheerders mogen de koppeling starten.
const dropboxOAuthStates = new Map();
app.get("/dropbox/status", authenticate, adminOnly, (req, res) => {
    res.json({
        configured: dropbox.isConfigured(),
        appReady: Boolean(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET && process.env.DROPBOX_REDIRECT_URI)
    });
});

app.get("/dropbox/connect", authenticate, adminOnly, (req, res) => {
    const appKey = process.env.DROPBOX_APP_KEY;
    const redirectUri = process.env.DROPBOX_REDIRECT_URI;
    if (!appKey || !process.env.DROPBOX_APP_SECRET || !redirectUri) {
        return res.status(503).json({
            error: "Vul eerst DROPBOX_APP_KEY, DROPBOX_APP_SECRET en DROPBOX_REDIRECT_URI in bij Render."
        });
    }

    const state = crypto.randomBytes(32).toString("hex");
    dropboxOAuthStates.set(state, {
        email: req.user.email,
        expiresAt: Date.now() + 10 * 60 * 1000
    });

    const authorizationUrl = new URL("https://www.dropbox.com/oauth2/authorize");
    authorizationUrl.searchParams.set("client_id", appKey);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("token_access_type", "offline");
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("scope", "files.content.read files.content.write files.metadata.read");

    res.json({ authorizationUrl: authorizationUrl.toString() });
});

app.get("/dropbox/callback", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const stateData = dropboxOAuthStates.get(state);
    dropboxOAuthStates.delete(state);

    if (!stateData || Date.now() > stateData.expiresAt) {
        return res.status(400).send("Deze Dropbox-koppeling is verlopen. Start de koppeling opnieuw vanuit het FaithTube-beheerdersdashboard.");
    }
    if (req.query.error) {
        return res.status(400).send("Dropbox-toestemming is niet gegeven. Ga terug naar FaithTube en probeer het opnieuw.");
    }

    try {
        const credentials = Buffer.from(
            process.env.DROPBOX_APP_KEY + ":" + process.env.DROPBOX_APP_SECRET
        ).toString("base64");
        const tokenResponse = await fetch("https://api.dropbox.com/oauth2/token", {
            method: "POST",
            headers: {
                Authorization: "Basic " + credentials,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                code: String(req.query.code || ""),
                grant_type: "authorization_code",
                redirect_uri: process.env.DROPBOX_REDIRECT_URI
            })
        });
        const tokenData = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || !tokenData.refresh_token) {
            console.error("Dropbox OAuth-uitwisseling mislukt:", tokenData.error_description || tokenData.error || tokenResponse.status);
            return res.status(400).send("Dropbox kon de toestemming niet afronden. Controleer de App Key, App Secret en Redirect URI in Render en Dropbox.");
        }

        const safeToken = String(tokenData.refresh_token).replace(/[&<>"]/g, "");
        return res.type("html").send(`<!doctype html><html lang="nl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Dropbox koppelen</title><body style="font:16px Arial;max-width:680px;margin:40px auto;padding:20px;line-height:1.5"><h1>Dropbox is gemachtigd</h1><p>De Dropbox-toestemming voor FaithTube is gelukt. Nog één stap: kopieer deze geheime refresh token en voeg hem bij Render toe als omgevingsvariabele <b>DROPBOX_REFRESH_TOKEN</b>.</p><textarea id="token" readonly style="width:100%;height:90px;box-sizing:border-box">${safeToken}</textarea><p><button onclick="navigator.clipboard.writeText(document.getElementById('token').value)">Kopieer geheime token</button></p><p>Ga daarna naar Render → FaithTube-server → Environment, voeg de variabele toe en deploy opnieuw. Deel deze token met niemand en plak hem niet in GitHub of in een chat.</p></body></html>`);
    } catch (error) {
        console.error("Dropbox OAuth callback mislukt:", error);
        return res.status(500).send("Dropbox koppelen is mislukt. Controleer de serverinstellingen en probeer het opnieuw.");
    }
});

// ACCOUNT REGISTREREN
app.post("/register", limitAuthAttempts, async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (
            typeof name !== "string" ||
            typeof email !== "string" ||            typeof password !== "string" ||
            name.trim().length < 2 ||
            name.trim().length > 60 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
            password.length < 8 ||
            password.length > 72
        ) {
            return res.status(400).json({
                error: "Controleer je naam, e-mailadres en wachtwoord (minimaal 8 tekens)."
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const exists = db.prepare(
            "SELECT id FROM users WHERE email = ?"
        ).get(normalizedEmail);

        if (exists) {
            return res.status(409).json({
                error: "Dit e-mailadres bestaat al."
            });
        }

        const hash = await bcrypt.hash(password, 12);

        const result = db.prepare(`
            INSERT INTO users (name, email, password, role)
            VALUES (?, ?, ?, 'visitor')
        `).run(name.trim(), normalizedEmail, hash);

        const token = jwt.sign({
            id: result.lastInsertRowid,
            name: name.trim(),
            email: normalizedEmail,
            role: "visitor",
            verified: false
        }, JWT_SECRET, { expiresIn: "30d" });

        res.status(201).json({
            message: "Je account is aangemaakt!",
            token,
            userId: result.lastInsertRowid
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Registreren is mislukt." });
    }
});

// INLOGGEN
app.post("/login", limitAuthAttempts, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (typeof email !== "string" || typeof password !== "string") {
            return res.status(400).json({ error: "Vul je gegevens in." });
        }

        const normalizedEmail = email.trim().toLowerCase();

        // Beheerdersaccount
        if (
            normalizedEmail === ADMIN_EMAIL &&
            password === ADMIN_PASSWORD
        ) {
            const token = jwt.sign({
                id: "faithtube-main-admin",
                name: "FaithTube beheerder",
                email: ADMIN_EMAIL,
                role: "admin",
                verified: true
            }, JWT_SECRET, { expiresIn: "30d" });

            return res.json({
                token,
                user: {
                    id: "faithtube-main-admin",
                    name: "FaithTube beheerder",
                    email: ADMIN_EMAIL,
                    role: "admin",
                    verified: true
                }
            });
        }

        // Bezoekersaccount
        const user = db.prepare(
            "SELECT * FROM users WHERE email = ?"
        ).get(normalizedEmail);

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({
                error: "E-mailadres of wachtwoord is onjuist."
            });
        }

        const token = jwt.sign({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            verified: Boolean(user.verified)
        }, JWT_SECRET, { expiresIn: "30d" });

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                verified: Boolean(user.verified)
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Inloggen is mislukt." });
    }
});

 // EIGEN ACCOUNT DEFINITIEF VERWIJDEREN
app.delete("/account", authenticate, async (req, res) => {
    if (req.user.role === "admin" || req.user.id === "faithtube-main-admin") {
        return res.status(403).json({ error: "Het beheerdersaccount kan niet via deze functie worden verwijderd." });
    }
    const userId = Number(req.user.id);
    const ownedVideos = db.prepare("SELECT video_url, thumbnail_url, dropbox_video_path, dropbox_thumbnail_path FROM videos WHERE user_id = ?").all(userId);
    const removeAccount = db.transaction(() => {
        db.prepare("DELETE FROM comments WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM comments WHERE video_id IN (SELECT id FROM videos WHERE user_id = ?)").run(userId);
        db.prepare("DELETE FROM follows WHERE follower_id = ? OR followed_id = ?").run(userId, userId);
        db.prepare("DELETE FROM watch_history WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM notifications WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM videos WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    });
    try {
        removeAccount();
        for (const video of ownedVideos) await deleteVideoMedia(video);
        res.json({ success: true, message: "Je account en de bijbehorende gegevens zijn definitief verwijderd." });
    } catch (error) {
        console.error("Account verwijderen mislukt:", error);
        res.status(500).json({ error: "Je account kon niet worden verwijderd. Probeer het later opnieuw." });
    }
});

// PROFIEL BEKIJKEN
app.get("/profile/:id", authenticate, (req, res) => {
    if (req.user.role === "admin" && req.params.id === req.user.id) {
        const saved = db.prepare(
            "SELECT name, profile_image, bio FROM admin_profile WHERE id = 1"
        ).get() || {};

        return res.json({
            user: {
                id: req.user.id,
                name: saved.name || req.user.name,
                profile_image: saved.profile_image || "",
                bio: saved.bio || "",
                verified: true,
                role: "admin",
                email: req.user.email
            }
        });
    }

    const user = db.prepare(`
        SELECT id, name, profile_image, bio, verified
        FROM users
        WHERE id = ?
    `).get(req.params.id);

    if (!user) {
        return res.status(404).json({
            error: "Profiel niet gevonden."
        });
    }

    res.json({ user });
});

// EIGEN PROFIEL AANPASSEN
app.put("/profile", authenticate, (req, res) => {
    const { name, bio, profileImage } = req.body;

    if (
        typeof name !== "string" ||
        name.trim().length < 2 ||
        name.trim().length > 60
    ) {
        return res.status(400).json({
            error: "Je naam moet tussen 2 en 60 tekens bevatten."
        });
    }

    if (bio !== undefined && (
        typeof bio !== "string" || bio.length > 500
    )) {
        return res.status(400).json({
            error: "Je biografie mag maximaal 500 tekens bevatten."
        });
    }

    if (profileImage !== undefined && (
        typeof profileImage !== "string" ||
        profileImage.length > 500000
    )) {
        return res.status(400).json({
            error: "De profielfoto is ongeldig of te groot."
        });
    }

    if (req.user.role === "admin") {
        db.prepare(`
            INSERT INTO admin_profile (id, name, profile_image, bio)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                profile_image = excluded.profile_image,
                bio = excluded.bio
        `).run(name.trim(), profileImage || "", bio || "");

        return res.json({
            message: "Je beheerderprofiel is opgeslagen!",
            user: {
                id: req.user.id,
                name: name.trim(),
                profile_image: profileImage || "",
                bio: bio || "",
                verified: true,
                role: "admin",
                email: req.user.email
            }
        });
    }

    if (
        typeof name !== "string" ||
        name.trim().length < 2 ||
        name.trim().length > 60
    ) {
        return res.status(400).json({
            error: "Je naam moet tussen 2 en 60 tekens bevatten."
        });
    }

    if (bio !== undefined && (
        typeof bio !== "string" || bio.length > 500
    )) {
        return res.status(400).json({
            error: "Je biografie mag maximaal 500 tekens bevatten."
        });
    }

    if (profileImage !== undefined && (
        typeof profileImage !== "string" ||
        profileImage.length > 500000
    )) {
        return res.status(400).json({
            error: "De profielfoto is ongeldig of te groot."
        });
    }

    const result = db.prepare(`
        UPDATE users
        SET name = ?,
            bio = ?,
            profile_image = ?
        WHERE id = ?
    `).run(
        name.trim(),
        bio || "",
        profileImage || "",
        req.user.id
    );

    if (!result.changes) {
        return res.status(404).json({
            error: "Account niet gevonden."
        });
    }

    const user = db.prepare(`
        SELECT id, name, profile_image, bio, verified
        FROM users
        WHERE id = ?
    `).get(req.user.id);

    res.json({
        message: "Je profiel is opgeslagen!",        user
    });
});
// EIGEN ACCOUNT BEKIJKEN
app.get("/me", authenticate, (req, res) => {
    if (req.user.role === "admin") {
        const saved = db.prepare(
            "SELECT name, profile_image, bio FROM admin_profile WHERE id = 1"
        ).get() || {};

        return res.json({
            user: {
                ...req.user,
                name: saved.name || req.user.name,
                profile_image: saved.profile_image || "",
                bio: saved.bio || ""
            }
        });
    }

    const user = getUser(req.user.id);

    if (!user) {
        return res.status(404).json({ error: "Account niet gevonden." });
    }

    res.json({ user });
});

// VIDEO OF BIJBELSTUDIE INSTUREN
app.post("/videos", authenticate, upload.single("video"), async (req, res) => {
    let uploadedDropboxVideoPath = "";
    let uploadedDropboxThumbnailPath = "";
    let localThumbnailPath = "";

    const removeTemporaryVideo = () => {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    };

    try {
        const {
            title,
            description,
            category,
            bibleReference,
            studyContent,
            captionsUrl
        } = req.body;

        const hasVideo = Boolean(req.file);
        const videoLink = typeof req.body.videoUrl === "string" ? req.body.videoUrl.trim() : "";
        let validVideoLink = "";
        if (videoLink) {
            try {
                const parsedLink = new URL(videoLink);
                if (!["http:", "https:"].includes(parsedLink.protocol)) throw new Error("Ongeldig protocol");
                validVideoLink = parsedLink.href;
            } catch {
                removeTemporaryVideo();
                return res.status(400).json({ error: "Vul een geldige videolink in die begint met https:// of http://." });
            }
        }

        const hasVideoSource = hasVideo || Boolean(validVideoLink);
        const allowed = ["Preek", "Worship", "Bijbelstudie"];
        if (
            typeof title !== "string" ||
            title.trim().length < 2 ||
            title.trim().length > 150 ||
            !allowed.includes(category)
        ) {
            removeTemporaryVideo();
            return res.status(400).json({ error: "Vul een geldige titel en categorie in." });
        }

        if (category === "Bijbelstudie") {
            if (typeof bibleReference !== "string" || !bibleReference.trim()) {
                removeTemporaryVideo();
                return res.status(400).json({ error: "Vul de Bijbeltekst in." });
            }
            if (hasVideoSource && (typeof description !== "string" || !description.trim())) {
                removeTemporaryVideo();
                return res.status(400).json({ error: "Voeg een beschrijving toe bij je video." });
            }
            if (!hasVideoSource && (typeof studyContent !== "string" || studyContent.trim().length < 30)) {
                return res.status(400).json({ error: "Schrijf je volledige Bijbelstudie (minimaal 30 tekens)." });
            }
        } else {
            if (!hasVideoSource) {
                removeTemporaryVideo();
                return res.status(400).json({ error: "Kies een videobestand of plak een geldige videolink." });
            }
            if (typeof description !== "string" || !description.trim()) {
                removeTemporaryVideo();
                return res.status(400).json({ error: "Vul een beschrijving bij de video in." });
            }
        }

        if (req.user.role !== "admin" && !getUser(req.user.id)) {
            removeTemporaryVideo();
            return res.status(401).json({ error: "Account niet gevonden." });
        }

        let thumbnailBuffer = null;
        let thumbnailExtension = "";
        if (typeof req.body.thumbnailData === "string" && req.body.thumbnailData) {
            const match = req.body.thumbnailData.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
            if (!match) {
                removeTemporaryVideo();
                return res.status(400).json({ error: "De thumbnail moet een JPG-, PNG- of WebP-afbeelding zijn." });
            }
            thumbnailBuffer = Buffer.from(match[2], "base64");
            if (!thumbnailBuffer.length || thumbnailBuffer.length > 3 * 1024 * 1024) {
                removeTemporaryVideo();
                return res.status(400).json({ error: "De thumbnail mag maximaal 3 MB zijn." });
            }
            thumbnailExtension = match[1] === "jpeg" ? "jpg" : match[1];
        }

        let validCaptionsUrl = null;
        if (typeof captionsUrl === "string" && captionsUrl.trim()) {
            try {
                const parsed = new URL(captionsUrl.trim());
                if (!["http:", "https:"].includes(parsed.protocol) || !parsed.pathname.toLowerCase().endsWith(".vtt")) throw new Error("invalid WebVTT URL");
                validCaptionsUrl = parsed.href;
            } catch {
                removeTemporaryVideo();
                return res.status(400).json({ error: "Gebruik een geldige link naar een ondertitelbestand dat eindigt op .vtt." });
            }
        }

        const useDropbox = dropbox.isConfigured();
        let videoUrl = validVideoLink;
        let thumbnailUrl = "";

        if (hasVideo) {
            if (useDropbox) {
                const extension = path.extname(req.file.originalname).toLowerCase() || ".mp4";
                uploadedDropboxVideoPath = "/videos/" + Date.now() + "-" + crypto.randomUUID() + extension;
                await dropbox.uploadFile(req.file.path, uploadedDropboxVideoPath);
                removeTemporaryVideo();
            } else {
                videoUrl = "/uploads/" + req.file.filename;
            }
        }

        if (thumbnailBuffer) {
            if (useDropbox) {
                uploadedDropboxThumbnailPath = "/thumbnails/" + Date.now() + "-" + crypto.randomUUID() + "." + thumbnailExtension;
                await dropbox.uploadBuffer(thumbnailBuffer, uploadedDropboxThumbnailPath);
            } else {
                const thumbnailFilename = "thumbnail-" + Date.now() + "-" + crypto.randomUUID() + "." + thumbnailExtension;
                localThumbnailPath = path.join(uploadDir, thumbnailFilename);
                fs.writeFileSync(localThumbnailPath, thumbnailBuffer);
                thumbnailUrl = "/uploads/" + thumbnailFilename;
            }
        }

        const result = db.prepare(`
            INSERT INTO videos
            (
                title, description, category, video_url, thumbnail_url, captions_url,
                user_id, approved, bible_reference, study_content,
                dropbox_video_path, dropbox_thumbnail_path
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        `).run(
            title.trim(),
            (description || "").trim(),
            category,
            videoUrl,
            thumbnailUrl,
            validCaptionsUrl,
            req.user.role === "admin" ? null : req.user.id,
            category === "Bijbelstudie" ? bibleReference.trim() : null,
            category === "Bijbelstudie" && !hasVideoSource ? studyContent.trim() : null,
            uploadedDropboxVideoPath || null,
            uploadedDropboxThumbnailPath || null
        );

        const videoId = result.lastInsertRowid;
        if (uploadedDropboxVideoPath || uploadedDropboxThumbnailPath) {
            if (uploadedDropboxVideoPath) videoUrl = "/media/video/" + videoId;
            if (uploadedDropboxThumbnailPath) thumbnailUrl = "/media/thumbnail/" + videoId;
            db.prepare("UPDATE videos SET video_url = ?, thumbnail_url = ? WHERE id = ?")
                .run(videoUrl, thumbnailUrl, videoId);
        }

        const submitter = req.user.role === "admin" ? "Beheerder" : (getUser(req.user.id)?.name || "Een gebruiker");
        const adminMessage = submitter + " heeft een nieuwe " + category + " ingestuurd: " + title.trim();
        db.prepare("INSERT INTO admin_notifications (message, video_id) VALUES (?, ?)")
            .run(adminMessage, videoId);

        await sendPushToUser("faithtube-main-admin", {
            title: "Nieuwe video ingestuurd op FaithTube",
            body: adminMessage,
            url: "/"
        });

        res.status(201).json({
            message: "Je inzending wacht op goedkeuring.",
            videoId
        });
    } catch (error) {
        console.error("Video upload mislukt:", error);
        removeTemporaryVideo();
        if (localThumbnailPath && fs.existsSync(localThumbnailPath)) fs.unlinkSync(localThumbnailPath);
        if (uploadedDropboxVideoPath) await dropbox.deleteFile(uploadedDropboxVideoPath);
        if (uploadedDropboxThumbnailPath) await dropbox.deleteFile(uploadedDropboxThumbnailPath);
        res.status(500).json({ error: error.message || "Je inzending is mislukt." });
    }
});

// Video- en thumbnailbestanden uit Dropbox worden via tijdelijke Dropbox-links afgespeeld.
app.get("/media/video/:id", async (req, res) => {
    try {
        const video = db.prepare("SELECT dropbox_video_path FROM videos WHERE id = ?").get(req.params.id);
        if (!video || !video.dropbox_video_path) return res.status(404).send("Video niet gevonden.");
        const link = await dropbox.getTemporaryLink(video.dropbox_video_path);
        res.redirect(302, link);
    } catch (error) {
        console.error("Video uit Dropbox openen mislukt:", error);
        res.status(502).send("De video kan momenteel niet uit Dropbox worden geladen.");
    }
});

app.get("/media/thumbnail/:id", async (req, res) => {
    try {
        const video = db.prepare("SELECT dropbox_thumbnail_path FROM videos WHERE id = ?").get(req.params.id);
        if (!video || !video.dropbox_thumbnail_path) return res.status(404).send("Thumbnail niet gevonden.");
        const link = await dropbox.getTemporaryLink(video.dropbox_thumbnail_path);
        res.redirect(302, link);
    } catch (error) {
        console.error("Thumbnail uit Dropbox openen mislukt:", error);
        res.status(502).send("De thumbnail kan momenteel niet worden geladen.");
    }
});

async function deleteVideoMedia(video) {
    if (!video) return;
    if (video.dropbox_video_path) await dropbox.deleteFile(video.dropbox_video_path);
    if (video.dropbox_thumbnail_path) await dropbox.deleteFile(video.dropbox_thumbnail_path);

    for (const mediaUrl of [video.video_url, video.thumbnail_url]) {
        if (typeof mediaUrl === "string" && mediaUrl.startsWith("/uploads/")) {
            const filePath = path.join(uploadDir, path.basename(mediaUrl));
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    }
}

// KANALEN MET GOEDGEKEURDE VIDEO'S
app.get("/channels", authenticate, (req, res) => {
    const channels = db.prepare(`
        SELECT
            users.id,
            users.name,
            users.profile_image,
            users.bio,
            users.verified,
            COUNT(videos.id) AS video_count,
            MAX(videos.created_at) AS latest_video
        FROM users
        INNER JOIN videos ON videos.user_id = users.id
        WHERE videos.approved = 1
        GROUP BY users.id
        ORDER BY latest_video DESC
    `).all();

    res.json(channels);
});

// KANALEN DIE IK VOLG
app.get("/follows", authenticate, (req, res) => {
    if (req.user.role === "admin") return res.json([]);

    const channels = db.prepare(`
        SELECT users.id, users.name, users.profile_image, users.verified
        FROM follows
        INNER JOIN users ON users.id = follows.followed_id
        WHERE follows.follower_id = ?
        ORDER BY follows.created_at DESC
    `).all(req.user.id);

    res.json(channels);
});

// KANAAL VOLGEN
app.post("/follows/:userId", authenticate, (req, res) => {
    if (req.user.role === "admin") {
        return res.status(403).json({ error: "Gebruik een bezoekersaccount om kanalen te volgen." });
    }

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0 || userId === Number(req.user.id)) {
        return res.status(400).json({ error: "Ongeldig kanaal." });
    }

    const channel = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
    if (!channel) return res.status(404).json({ error: "Kanaal niet gevonden." });

    db.prepare(
        "INSERT OR IGNORE INTO follows (follower_id, followed_id) VALUES (?, ?)"
    ).run(req.user.id, userId);

    res.json({ success: true });
});

// KANAAL NIET MEER VOLGEN
app.delete("/follows/:userId", authenticate, (req, res) => {
    if (req.user.role === "admin") {
        return res.status(403).json({ error: "Gebruik een bezoekersaccount om kanalen te beheren." });
    }

    const userId = Number(req.params.userId);
    db.prepare(
        "DELETE FROM follows WHERE follower_id = ? AND followed_id = ?"
    ).run(req.user.id, userId);

    res.json({ success: true });
});

// KIJKGESCHIEDENIS
app.get("/history", authenticate, (req, res) => {
    if (req.user.role === "admin") return res.json([]);

    const history = db.prepare(`
        SELECT video_id, watched_at
        FROM watch_history
        WHERE user_id = ?
        ORDER BY watched_at DESC
        LIMIT 100
    `).all(req.user.id);

    res.json(history);
});

app.delete("/history", authenticate, (req, res) => {
    if (req.user.role !== "admin") {
        db.prepare("DELETE FROM watch_history WHERE user_id = ?").run(req.user.id);
    }
    res.json({ success: true });
});

// VIDEO WEERGEVEN EN OPSLAAN IN KIJKGESCHIEDENIS
app.post("/videos/:id/view", authenticate, (req, res) => {
    const video = db.prepare(
        "SELECT id FROM videos WHERE id = ? AND approved = 1"
    ).get(req.params.id);

    if (!video) return res.status(404).json({ error: "Video niet gevonden." });

    db.prepare(
        "UPDATE videos SET views_count = views_count + 1 WHERE id = ?"
    ).run(video.id);

    if (req.user.role !== "admin" && getUser(req.user.id)) {
        db.prepare(`
            INSERT INTO watch_history (user_id, video_id, watched_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, video_id) DO UPDATE SET
                watched_at = CURRENT_TIMESTAMP
        `).run(req.user.id, video.id);
    }
    res.json({ success: true });
});

app.get("/push/public-key", authenticate, (req, res) => {
    res.json({ enabled: pushEnabled, publicKey: pushEnabled ? vapidPublicKey : "" });
});
app.post("/push/subscribe", authenticate, (req, res) => {
    if (!pushEnabled) return res.status(503).json({ error: "Pushmeldingen zijn nog niet geconfigureerd." });
    const sub = req.body.subscription;
    if (!sub || typeof sub.endpoint !== "string" || !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") return res.status(400).json({ error: "Ongeldig push-abonnement." });
    db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, subscription_json) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, subscription_json = excluded.subscription_json").run(req.user.id, sub.endpoint, JSON.stringify(sub));
    res.status(201).json({ success: true });
});
app.delete("/push/subscribe", authenticate, (req, res) => {
    const endpoint = typeof req.body.endpoint === "string" ? req.body.endpoint : "";
    db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(req.user.id, endpoint);
    res.json({ success: true });
});

// MELDINGEN
app.get("/notifications", authenticate, (req, res) => {
    if (req.user.role === "admin") {
        return res.json(db.prepare(`
            SELECT id, message, is_read, created_at, video_id
            FROM admin_notifications
            ORDER BY created_at DESC
            LIMIT 100
        `).all());
    }

    const items = db.prepare(`
        SELECT id, message, is_read, created_at
        FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 100
    `).all(req.user.id);

    res.json(items);
});

app.post("/notifications/:id/read", authenticate, (req, res) => {
    if (req.user.role === "admin") {
        const result = db.prepare("UPDATE admin_notifications SET is_read = 1 WHERE id = ?").run(req.params.id);
        if (!result.changes) return res.status(404).json({ error: "Melding niet gevonden." });
        return res.json({ success: true });
    }

    const result = db.prepare(`
        UPDATE notifications
        SET is_read = 1
        WHERE id = ? AND user_id = ?
    `).run(req.params.id, req.user.id);

    if (!result.changes) {
        return res.status(404).json({ error: "Melding niet gevonden." });
    }

    res.json({ success: true });
});

// GOEDGEKEURDE VIDEO'S
app.get("/videos", (req, res) => {
    const videos = db.prepare(`
        SELECT
            videos.*,
            users.name AS author_name,
            users.verified AS author_verified
        FROM videos
        LEFT JOIN users ON users.id = videos.user_id
        WHERE videos.approved = 1
        ORDER BY users.verified DESC, videos.created_at DESC
    `).all();

    res.json(videos);
});

// WACHTENDE VIDEO'S BEHEERDER
app.get("/admin/videos", authenticate, adminOnly, (req, res) => {
    const videos = db.prepare(`
        SELECT videos.*, users.name AS author_name
        FROM videos
        LEFT JOIN users ON users.id = videos.user_id
        WHERE videos.approved = 0
        ORDER BY videos.created_at DESC
    `).all();

    res.json(videos);
});

// VIDEO GOEDKEUREN
app.post("/admin/videos/:id/approve", authenticate, adminOnly, async (req, res) => {
    const video = db.prepare("SELECT id, title, user_id FROM videos WHERE id = ?").get(req.params.id);
    if (!video) return res.status(404).json({ error: "Video niet gevonden." });
    const result = db.prepare("UPDATE videos SET approved = 1 WHERE id = ?").run(req.params.id);
    if (video.user_id) {
        const message = "Je video " + video.title + " is goedgekeurd en staat nu op FaithTube.";
        db.prepare("INSERT INTO notifications (user_id, message) VALUES (?, ?)").run(video.user_id, message);
        await sendPushToUser(video.user_id, { title: "Je video staat op FaithTube!", body: video.title, url: "/" });
    }
    res.json({ success: result.changes > 0 });
});

// VIDEO AFWIJZEN
app.delete("/admin/videos/:id", authenticate, adminOnly, async (req, res) => {
    const video = db.prepare(
        "SELECT video_url, thumbnail_url, dropbox_video_path, dropbox_thumbnail_path FROM videos WHERE id = ?"
    ).get(req.params.id);

    db.prepare("DELETE FROM comments WHERE video_id = ?").run(req.params.id);
    db.prepare("DELETE FROM videos WHERE id = ?").run(req.params.id);
    await deleteVideoMedia(video);

    res.json({ success: true });
});

// REACTIES BIJ VIDEO
app.get("/videos/:id/comments", (req, res) => {
    const comments = db.prepare(`
        SELECT
            comments.id,
            comments.comment,
            comments.created_at,
            users.name AS author_name
        FROM comments
        JOIN users ON users.id = comments.user_id
        JOIN videos ON videos.id = comments.video_id
        WHERE comments.video_id = ? AND videos.approved = 1
        ORDER BY comments.created_at ASC
    `).all(req.params.id);

    res.json(comments);
});

// REACTIE PLAATSEN
app.post("/videos/:id/comments", authenticate, (req, res) => {
    const text = req.body.comment;

    if (typeof text !== "string" || !text.trim() || text.length > 2000) {
        return res.status(400).json({ error: "Ongeldige reactie." });
    }

    if (req.user.role === "admin") {
        return res.status(403).json({
            error: "Gebruik een bezoekersaccount om te reageren."
        });
    }

    const video = db.prepare(
        "SELECT id FROM videos WHERE id = ? AND approved = 1"
    ).get(req.params.id);

    if (!video || !getUser(req.user.id)) {
        return res.status(404).json({
            error: "Video of account niet gevonden."
        });
    }

    const result = db.prepare(`
        INSERT INTO comments (video_id, user_id, comment)
        VALUES (?, ?, ?)
    `).run(req.params.id, req.user.id, text.trim());

    res.status(201).json({ commentId: result.lastInsertRowid });
});

// VIDEO RAPPORTEREN
app.post("/videos/:id/report", authenticate, (req, res) => {
    if (req.user.role === "admin") return res.status(403).json({ error: "Beheerders kunnen geen meldingen indienen." });
    const videoId = Number(req.params.id);
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    const details = typeof req.body.details === "string" ? req.body.details.trim() : "";
    const reasons = ["Ongepaste inhoud", "Auteursrecht", "Misleidende informatie", "Spam", "Anders"];
    if (!Number.isInteger(videoId) || videoId <= 0 || !reasons.includes(reason) || details.length > 1000) return res.status(400).json({ error: "Kies een geldige reden en maximaal 1000 tekens uitleg." });
    const video = db.prepare("SELECT id FROM videos WHERE id = ? AND approved = 1").get(videoId);
    if (!video) return res.status(404).json({ error: "Video niet gevonden." });
    const existing = db.prepare("SELECT id FROM video_reports WHERE video_id = ? AND reporter_id = ? AND status = 'open'").get(videoId, req.user.id);
    if (existing) return res.status(409).json({ error: "Je hebt deze video al gemeld." });
    db.prepare("INSERT INTO video_reports (video_id, reporter_id, reason, details) VALUES (?, ?, ?, ?)").run(videoId, req.user.id, reason, details);
    res.status(201).json({ success: true, message: "Je melding is verstuurd." });
});

app.get("/admin/reports", authenticate, adminOnly, (req, res) => {
    const reports = db.prepare("SELECT video_reports.id, video_reports.reason, video_reports.details, videos.title AS video_title, users.name AS reporter_name FROM video_reports LEFT JOIN videos ON videos.id = video_reports.video_id LEFT JOIN users ON users.id = video_reports.reporter_id WHERE video_reports.status = 'open' ORDER BY video_reports.created_at ASC").all();
    res.json(reports);
});

app.post("/admin/reports/:id/status", authenticate, adminOnly, (req, res) => {
    const status = req.body.status;
    if (!["resolved", "dismissed"].includes(status)) return res.status(400).json({ error: "Ongeldige afhandeling." });
    const result = db.prepare("UPDATE video_reports SET status = ? WHERE id = ? AND status = 'open'").run(status, req.params.id);
    if (!result.changes) return res.status(404).json({ error: "Melding niet gevonden." });
    res.json({ success: true });
});

// ALLE ACCOUNTS BEKIJKEN
app.get("/admin/users", authenticate, adminOnly, (req, res) => {
    const users = db.prepare(`
        SELECT id, name, email, verified, created_at
        FROM users
        ORDER BY created_at DESC
    `).all();

    res.json(users);
});

// GEBRUIKER VERIFIEREN
app.post("/admin/users/:id/verify", authenticate, adminOnly, (req, res) => {
    const result = db.prepare(
        "UPDATE users SET verified = 1 - verified WHERE id = ?"
    ).run(req.params.id);

    res.json({ success: result.changes > 0 });
});

// BEZOEKERSACCOUNT VERWIJDEREN
app.delete("/admin/users/:id", authenticate, adminOnly, (req, res) => {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: "Ongeldig account." });
    }

    const user = db.prepare(
        "SELECT id FROM users WHERE id = ?"
    ).get(userId);

    if (!user) {
        return res.status(404).json({ error: "Account niet gevonden." });
    }

    const removeAccount = db.transaction(() => {
        db.prepare(
            "DELETE FROM comments WHERE user_id = ?"
        ).run(userId);

        db.prepare(
            "UPDATE videos SET user_id = NULL WHERE user_id = ?"
        ).run(userId);

        db.prepare(
            "DELETE FROM users WHERE id = ?"
        ).run(userId);
    });

    removeAccount();

    res.json({
        success: true,
        message: "Het bezoekersaccount is verwijderd."
    });
});

// ALLE REACTIES BEHEREN
app.get("/admin/comments", authenticate, adminOnly, (req, res) => {
    const comments = db.prepare(`
        SELECT
            comments.id,
            comments.comment,
            comments.created_at,
            users.name AS author_name,
            videos.title AS video_title
        FROM comments
        JOIN users ON users.id = comments.user_id
        JOIN videos ON videos.id = comments.video_id
        ORDER BY comments.created_at DESC
    `).all();

    res.json(comments);
});

// REACTIE VERWIJDEREN
app.delete("/admin/comments/:id", authenticate, adminOnly, (req, res) => {
    const result = db.prepare(
        "DELETE FROM comments WHERE id = ?"
    ).run(req.params.id);

    res.json({ success: result.changes > 0 });
});

// FOUTAFHANDELING
app.use((error, req, res, next) => {
    console.error(error);

    res.status(400).json({
        error: error.message || "Er ging iets mis."
    });
});

// SERVER STARTEN
app.listen(PORT, () => {
    console.log(`FaithTube draait op poort ${PORT}`);
});