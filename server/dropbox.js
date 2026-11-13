const fs = require("fs");

let cachedAccessToken = "";
let accessTokenExpiresAt = 0;

function isConfigured() {
    return Boolean(
        process.env.DROPBOX_APP_KEY &&
        process.env.DROPBOX_APP_SECRET &&
        process.env.DROPBOX_REFRESH_TOKEN
    );
}

async function getAccessToken() {
    if (!isConfigured()) {
        throw new Error("Dropbox is nog niet volledig ingesteld op de server.");
    }

    if (cachedAccessToken && Date.now() < accessTokenExpiresAt - 60000) {
        return cachedAccessToken;
    }

    const credentials = Buffer.from(
        process.env.DROPBOX_APP_KEY + ":" + process.env.DROPBOX_APP_SECRET
    ).toString("base64");

    const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: process.env.DROPBOX_REFRESH_TOKEN
    });

    const response = await fetch("https://api.dropbox.com/oauth2/token", {
        method: "POST",
        headers: {
            Authorization: "Basic " + credentials,
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
        console.error("Dropbox token vernieuwen mislukt:", data.error_description || data.error || response.status);
        throw new Error("FaithTube kan geen verbinding maken met Dropbox. Controleer de Dropbox-instellingen op Render.");
    }

    cachedAccessToken = data.access_token;
    accessTokenExpiresAt = Date.now() + Number(data.expires_in || 14400) * 1000;
    return cachedAccessToken;
}

async function apiJson(endpoint, args) {
    const token = await getAccessToken();
    const response = await fetch("https://api.dropboxapi.com/2/" + endpoint, {
        method: "POST",
        headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(args || {})
    });

    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {}

    if (!response.ok) {
        const detail = data.error_summary || data.error_description || raw || response.status;
        console.error("Dropbox API-fout (" + endpoint + "):", detail);
        throw new Error("Dropbox kon de bestandsbewerking niet uitvoeren.");
    }
    return data;
}

async function contentRequest(endpoint, args, buffer) {
    const token = await getAccessToken();
    const response = await fetch("https://content.dropboxapi.com/2/" + endpoint, {
        method: "POST",
        headers: {
            Authorization: "Bearer " + token,
            "Dropbox-API-Arg": JSON.stringify(args || {}),
            "Content-Type": "application/octet-stream"
        },
        body: buffer
    });

    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {}

    if (!response.ok) {
        const detail = data.error_summary || data.error_description || raw || response.status;
        console.error("Dropbox uploadfout (" + endpoint + "):", detail);
        throw new Error("Uploaden naar Dropbox is mislukt. Controleer de opslagruimte en app-rechten.");
    }
    return data;
}

async function ensureFolder(folderPath) {
    try {
        await apiJson("files/create_folder_v2", { path: folderPath, autorename: false });
    } catch (error) {
        // Dropbox geeft een conflict als de map al bestaat.
        if (!String(error.message).includes("bestandsbewerking")) throw error;
    }
}

async function uploadBuffer(buffer, destinationPath) {
    const parent = destinationPath.slice(0, destinationPath.lastIndexOf("/"));
    await ensureFolder(parent);
    return contentRequest("files/upload", {
        path: destinationPath,
        mode: "add",
        autorename: false,
        mute: true,
        strict_conflict: true
    }, buffer);
}

async function uploadFile(localPath, destinationPath) {
    const stats = fs.statSync(localPath);
    if (!stats.size) throw new Error("Het videobestand is leeg.");

    const parent = destinationPath.slice(0, destinationPath.lastIndexOf("/"));
    await ensureFolder(parent);

    // Voor kleinere bestanden is één uploadverzoek het eenvoudigst.
    if (stats.size <= 100 * 1024 * 1024) {
        return contentRequest("files/upload", {
            path: destinationPath,
            mode: "add",
            autorename: false,
            mute: true,
            strict_conflict: true
        }, fs.readFileSync(localPath));
    }

    // Grote video's worden in stukken verstuurd zodat ze niet volledig in het geheugen hoeven.
    const chunkSize = 8 * 1024 * 1024;
    const stream = fs.createReadStream(localPath, { highWaterMark: chunkSize });
    let sessionId = "";
    let offset = 0;

    try {
        for await (const chunk of stream) {
            if (!sessionId) {
                const started = await contentRequest(
                    "files/upload_session/start",
                    { close: false },
                    chunk
                );
                sessionId = started.session_id;
                offset = chunk.length;
                continue;
            }

            const isLast = offset + chunk.length >= stats.size;
            if (isLast) {
                return contentRequest("files/upload_session/finish", {
                    cursor: { session_id: sessionId, offset },
                    commit: {
                        path: destinationPath,
                        mode: "add",
                        autorename: false,
                        mute: true,
                        strict_conflict: true
                    }
                }, chunk);
            }

            await contentRequest("files/upload_session/append_v2", {
                cursor: { session_id: sessionId, offset },
                close: false
            }, chunk);
            offset += chunk.length;
        }

        // Een bestand van precies één chunk is al gestart; commit met een lege laatste chunk.
        if (sessionId && offset === stats.size) {
            return contentRequest("files/upload_session/finish", {
                cursor: { session_id: sessionId, offset },
                commit: {
                    path: destinationPath,
                    mode: "add",
                    autorename: false,
                    mute: true,
                    strict_conflict: true
                }
            }, Buffer.alloc(0));
        }

        throw new Error("Dropbox-upload is onvolledig.");
    } finally {
        stream.destroy();
    }
}

async function getTemporaryLink(path) {
    const result = await apiJson("files/get_temporary_link", { path });
    if (!result.link) throw new Error("Dropbox gaf geen afspeellink terug.");
    return result.link;
}

async function deleteFile(path) {
    if (!path) return;
    try {
        await apiJson("files/delete_v2", { path });
    } catch (error) {
        console.error("Dropbox-bestand verwijderen mislukt:", error.message);
    }
}

module.exports = {
    isConfigured,
    uploadBuffer,
    uploadFile,
    getTemporaryLink,
    deleteFile
};
