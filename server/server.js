
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = "lukevandendool2012@gmail.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!JWT_SECRET || !ADMIN_PASSWORD) {
    console.error("JWT_SECRET of ADMIN_PASSWORD ontbreekt.");
    process.exit(1);
}

const uploadDir = path.join(__dirname, "uploads");
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

// Bewaar profielgegevens van het aparte beheerdersaccount.
db.exec(`CREATE TABLE IF NOT EXISTS admin_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    profile_image TEXT DEFAULT "",
    bio TEXT DEFAULT ""
)`);

// Eenmalige opschoning op verzoek. De marker voorkomt dat accounts bij elke herstart verdwijnen.
db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL
)`);
const alreadyCleaned = db.prepare(
    "SELECT setting_value FROM app_settings WHERE setting_key = ?"
).get("initial_content_cleanup_v1");

if (!alreadyCleaned) {
    const clearOldContent = db.transaction(() => {
        db.exec(`
            DELETE FROM comments;
            DELETE FROM watch_history;
            DELETE FROM notifications;
            DELETE FROM follows;
            DELETE FROM videos;
            DELETE FROM users;
        `);
        db.prepare(
            "INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)"
        ).run("initial_content_cleanup_v1", "done");
    });
    clearOldContent();

    for (const file of fs.readdirSync(uploadDir)) {
        const filePath = path.join(uploadDir, file);
        if (fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
    }
    console.log("Eenmalige opschoning uitgevoerd; admin-profiel is behouden.");
}

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
    if (
        req.user.role !== "admin" ||
        req.user.id !== "faithtube-main-admin"
    ) {
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

// ACCOUNT REGISTREREN
app.post("/register", async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (
            typeof name !== "string" ||
            typeof email !== "string" ||
            typeof password !== "string" ||
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
app.post("/login", async (req, res) => {
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
            role: "visitor",
            verified: Boolean(user.verified)
        }, JWT_SECRET, { expiresIn: "30d" });

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: "visitor",
                verified: Boolean(user.verified)
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Inloggen is mislukt." });
    }
});

 // EIGEN ACCOUNT DEFINITIEF VERWIJDEREN
app.delete("/account", authenticate, (req, res) => {
    if (req.user.role === "admin" || req.user.id === "faithtube-main-admin") {
        return res.status(403).json({ error: "Het beheerdersaccount kan niet via deze functie worden verwijderd." });
    }
    const userId = Number(req.user.id);
    const ownedVideos = db.prepare("SELECT video_url FROM videos WHERE user_id = ?").all(userId);
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
        for (const video of ownedVideos) {
            if (video.video_url && video.video_url.startsWith("/uploads/")) {
                const filePath = path.join(uploadDir, path.basename(video.video_url));
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        }
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
        message: "Je profiel is opgeslagen!",
        user
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
app.post("/videos", authenticate, upload.single("video"), (req, res) => {
    try {
        const {
            title,
            description,
            category,
            bibleReference,
            studyContent
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
                if (req.file) fs.unlinkSync(req.file.path);
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
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({
                error: "Vul een geldige titel en categorie in."
            });
        }

        if (category === "Bijbelstudie") {
            if (typeof bibleReference !== "string" || !bibleReference.trim()) {
                if (req.file) fs.unlinkSync(req.file.path);
                return res.status(400).json({ error: "Vul de Bijbeltekst in." });
            }

            if (hasVideoSource && (typeof description !== "string" || !description.trim())) {
                fs.unlinkSync(req.file.path);
                return res.status(400).json({
                    error: "Voeg een beschrijving toe bij je video."
                });
            }

            if (!hasVideoSource && (
                typeof studyContent !== "string" ||
                studyContent.trim().length < 30
            )) {
                return res.status(400).json({
                    error: "Schrijf je volledige Bijbelstudie (minimaal 30 tekens)."
                });
            }
        } else {
            if (!hasVideoSource) {
                return res.status(400).json({ error: "Kies een videobestand of plak een geldige videolink." });
            }

            if (typeof description !== "string" || !description.trim()) {
                fs.unlinkSync(req.file.path);
                return res.status(400).json({
                    error: "Vul een beschrijving bij de video in."
                });
            }
        }

        if (req.user.role !== "admin" && !getUser(req.user.id)) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(401).json({ error: "Account niet gevonden." });
        }

        let thumbnailUrl = "";
        if (typeof req.body.thumbnailData === "string" && req.body.thumbnailData) {
            const match = req.body.thumbnailData.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
            if (!match) {
                if (req.file) fs.unlinkSync(req.file.path);
                return res.status(400).json({ error: "De thumbnail moet een JPG-, PNG- of WebP-afbeelding zijn." });
            }
            const imageBuffer = Buffer.from(match[2], "base64");
            if (!imageBuffer.length || imageBuffer.length > 3 * 1024 * 1024) {
                if (req.file) fs.unlinkSync(req.file.path);
                return res.status(400).json({ error: "De thumbnail mag maximaal 3 MB zijn." });
            }
            const extension = match[1] === "jpeg" ? "jpg" : match[1];
            const thumbnailFilename = `thumbnail-${Date.now()}-${require("crypto").randomUUID()}.${extension}`;
            fs.writeFileSync(path.join(uploadDir, thumbnailFilename), imageBuffer);
            thumbnailUrl = `/uploads/${thumbnailFilename}`;
        }

        const videoUrl = hasVideo ? `/uploads/${req.file.filename}` : validVideoLink;

        const result = db.prepare(`
            INSERT INTO videos
            (
                title, description, category, video_url, thumbnail_url,
                user_id, approved, bible_reference, study_content
            )
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(
            title.trim(),
            (description || "").trim(),
            category,
            videoUrl,
            thumbnailUrl,
            req.user.role === "admin" ? null : req.user.id,
            category === "Bijbelstudie" ? bibleReference.trim() : null,
            category === "Bijbelstudie" && !hasVideoSource ? studyContent.trim() : null
        );

        const submitter = req.user.role === "admin" ? "Beheerder" : (getUser(req.user.id)?.name || "Een gebruiker");
        db.prepare("INSERT INTO admin_notifications (message, video_id) VALUES (?, ?)")
            .run(submitter + " heeft een nieuwe " + category + " ingestuurd: " + title.trim(), result.lastInsertRowid);

        res.status(201).json({
            message: "Je inzending wacht op goedkeuring.",
            videoId: result.lastInsertRowid
        });

    } catch (error) {
        console.error(error);

        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({ error: "Je inzending is mislukt." });
    }
});

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
app.post("/admin/videos/:id/approve", authenticate, adminOnly, (req, res) => {
    const result = db.prepare(
        "UPDATE videos SET approved = 1 WHERE id = ?"
    ).run(req.params.id);

    res.json({ success: result.changes > 0 });
});

// VIDEO AFWIJZEN
app.delete("/admin/videos/:id", authenticate, adminOnly, (req, res) => {
    const video = db.prepare(
        "SELECT video_url FROM videos WHERE id = ?"
    ).get(req.params.id);

    if (video) {
        for (const mediaUrl of [video.video_url, video.thumbnail_url]) {
            if (typeof mediaUrl === "string" && mediaUrl.startsWith("/uploads/")) {
                const filename = path.basename(mediaUrl);
                const filePath = path.join(uploadDir, filename);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        }
    }

    db.prepare("DELETE FROM comments WHERE video_id = ?").run(req.params.id);
    db.prepare("DELETE FROM videos WHERE id = ?").run(req.params.id);

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
