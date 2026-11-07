
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

// Extra velden voor geschreven Bijbelstudies
function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();

    if (!columns.some(item => item.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

ensureColumn("videos", "bible_reference", "TEXT");
ensureColumn("videos", "study_content", "TEXT");

// Uploadinstellingen
const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        callback(null, `${Date.now()}-${require("crypto").randomUUID()}${extension}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, callback) => {
        if (!file.mimetype.startsWith("video/")) {
            return callback(new Error("Alleen videobestanden zijn toegestaan."));
        }
        callback(null, true);
    }
});

// Controleren of iemand is ingelogd
function authenticate(req, res, next) {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Je moet eerst inloggen." });
    }

    try {
        req.user = jwt.verify(header.slice(7), JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ error: "Je sessie is ongeldig." });
    }
}

// Alleen beheerder toestaan
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

// Startpagina server
app.get("/", (req, res) => {
    res.send("Welkom bij de FaithTube-server!");
});

// REGISTREREN
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

        res.status(201).json({
            message: "Je account is aangemaakt!",
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
            }, JWT_SECRET, { expiresIn: "7d" });

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
        }, JWT_SECRET, { expiresIn: "7d" });

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

// EIGEN ACCOUNT BEKIJKEN
app.get("/me", authenticate, (req, res) => {
    if (req.user.role === "admin") {
        return res.json({ user: req.user });
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

            if (hasVideo && (typeof description !== "string" || !description.trim())) {
                fs.unlinkSync(req.file.path);
                return res.status(400).json({
                    error: "Voeg een beschrijving toe bij je video."
                });
            }

            if (!hasVideo && (
                typeof studyContent !== "string" ||
                studyContent.trim().length < 30
            )) {
                return res.status(400).json({
                    error: "Schrijf je volledige Bijbelstudie (minimaal 30 tekens)."
                });
            }

        } else {
            if (!hasVideo) {
                return res.status(400).json({ error: "Kies een videobestand." });
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

        const videoUrl = hasVideo ? `/uploads/${req.file.filename}` : "";

        const result = db.prepare(`
            INSERT INTO videos
            (
                title,
                description,
                category,
                video_url,
                user_id,
                approved,
                bible_reference,
                study_content
            )
            VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        `).run(
            title.trim(),
            (description || "").trim(),
            category,
            videoUrl,
            req.user.role === "admin" ? null : req.user.id,
            category === "Bijbelstudie" ? bibleReference.trim() : null,
            category === "Bijbelstudie" && !hasVideo ? studyContent.trim() : null
        );

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

// GOEDGEKEURDE VIDEO'S BEKIJKEN
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

// WACHTENDE VIDEO'S VOOR BEHEERDER
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
        const filename = path.basename(video.video_url);
        const filePath = path.join(uploadDir, filename);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    db.prepare("DELETE FROM comments WHERE video_id = ?").run(req.params.id);
    db.prepare("DELETE FROM videos WHERE id = ?").run(req.params.id);

    res.json({ success: true });
});

// REACTIES BIJ EEN VIDEO
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
