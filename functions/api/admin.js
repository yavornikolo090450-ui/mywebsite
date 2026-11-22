const COOKIE_NAME = "tower_bg_admin";
const SESSION_HOURS = 8;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

const ALLOWED_FILES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "video/mp4": "mp4",
    "video/webm": "webm"
};

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...extraHeaders
        }
    });
}

function safeEqual(first, second) {
    const encoder = new TextEncoder();
    const a = encoder.encode(String(first));
    const b = encoder.encode(String(second));

    let difference = a.length ^ b.length;
    const length = Math.max(a.length, b.length);

    for (let i = 0; i < length; i++) {
        difference |= (a[i] || 0) ^ (b[i] || 0);
    }

    return difference === 0;
}

async function makeSignature(value, secret) {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(value)
    );

    return btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

async function createSession(secret) {
    const expires = String(
        Date.now() + SESSION_HOURS * 60 * 60 * 1000
    );

    const signature = await makeSignature(expires, secret);

    return `${expires}.${signature}`;
}

async function verifySession(request, secret) {
    try {
        const cookies = request.headers.get("Cookie") || "";

        const cookie = cookies
            .split(";")
            .map(value => value.trim())
            .find(value => value.startsWith(COOKIE_NAME + "="));

        if (!cookie) return false;

        const token = cookie.slice(COOKIE_NAME.length + 1);
        const parts = token.split(".");

        if (parts.length !== 2) return false;

        const [expires, suppliedSignature] = parts;

        if (!/^\d+$/.test(expires)) return false;
        if (Number(expires) < Date.now()) return false;

        const expectedSignature = await makeSignature(
            expires,
            secret
        );

        return safeEqual(suppliedSignature, expectedSignature);

    } catch {
        return false;
    }
}

function sessionCookie(token) {
    return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`;
}

function clearSessionCookie() {
    return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

async function readRequest(request) {
    const contentType = request.headers.get("Content-Type") || "";

    if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();

        const files = form.getAll("media").filter(file =>
            file &&
            typeof file.arrayBuffer === "function" &&
            file.size > 0
        );

        return {
            action: String(form.get("action") || ""),
            username: "",
            password: "",
            title: String(form.get("title") || ""),
            description: String(form.get("description") || ""),
            id: form.get("id"),
            files
        };
    }

    const body = await request.json();

    return {
        ...body,
        files: []
    };
}

async function ensureTables(db) {
    await db.prepare(`
        CREATE TABLE IF NOT EXISTS updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            image_url TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    await db.prepare(`
        CREATE TABLE IF NOT EXISTS update_media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            update_id INTEGER NOT NULL,
            object_key TEXT NOT NULL,
            media_type TEXT NOT NULL,
            original_name TEXT
        )
    `).run();
}

async function publishUpdate(env, body) {
    const title = String(body.title || "").trim();
    const description = String(body.description || "");

    if (!title) {
        return json({ error: "Въведи заглавие на ъпдейта." }, 400);
    }

    if (body.files.length > 0 && !env.MEDIA) {
        return json({
            error: "R2 не е свързан. Първо трябва да настроим хранилището за снимки и видеоклипове."
        }, 500);
    }

    const uploaded = [];

    try {
        // Validate all files before uploading anything.
        for (const file of body.files) {
            if (!Object.prototype.hasOwnProperty.call(
                ALLOWED_FILES,
                file.type
            )) {
                return json({
                    error: `Този формат не се поддържа: ${file.name}`
                }, 400);
            }

            if (file.size > MAX_FILE_SIZE) {
                return json({
                    error: `Файлът ${file.name} е по-голям от 20 MB.`
                }, 400);
            }
        }

        // Upload media to the private R2 bucket.
        for (const file of body.files) {
            const extension = ALLOWED_FILES[file.type];
            const key = `${crypto.randomUUID()}.${extension}`;

            await env.MEDIA.put(key, file.stream(), {
                httpMetadata: {
                    contentType: file.type
                },
                customMetadata: {
                    originalName: file.name.slice(0, 200)
                }
            });

            uploaded.push({
                key,
                type: file.type,
                name: file.name
            });
        }

        const insertResult = await env.DB.prepare(`
            INSERT INTO updates (title, description, image_url)
            VALUES (?, ?, NULL)
        `).bind(title, description).run();

        const updateId = insertResult.meta.last_row_id;

        for (const media of uploaded) {
            await env.DB.prepare(`
                INSERT INTO update_media
                (update_id, object_key, media_type, original_name)
                VALUES (?, ?, ?, ?)
            `).bind(
                updateId,
                media.key,
                media.type,
                media.name
            ).run();
        }

        return json({
            success: true,
            message: "Ъпдейтът е публикуван!",
            id: updateId
        });

    } catch (error) {
        // Remove uploaded files if saving the update failed.
        if (env.MEDIA && uploaded.length > 0) {
            await Promise.allSettled(
                uploaded.map(media => env.MEDIA.delete(media.key))
            );
        }

        console.error("Publish error:", error);

        return json({
            error: "Не успяхме да публикуваме ъпдейта. Провери настройките на Cloudflare."
        }, 500);
    }
}

export async function onRequestPost({ request, env }) {
    try {
        // Only allow requests coming from this website.
        const origin = request.headers.get("Origin");

        if (origin && origin !== new URL(request.url).origin) {
            return json({ error: "Invalid request origin." }, 403);
        }

        const body = await readRequest(request);

        // LOGOUT
        if (body.action === "logout") {
            return json(
                { success: true },
                200,
                { "Set-Cookie": clearSessionCookie() }
            );
        }

        // LOGIN
        if (body.action === "login") {
            if (
                !env.ADMIN_USERNAME ||
                !env.ADMIN_PASSWORD ||
                !env.ADMIN_SESSION_SECRET
            ) {
                return json({
                    error: "Администраторските настройки още не са зададени в Cloudflare."
                }, 500);
            }

            const usernameCorrect = safeEqual(
                body.username || "",
                env.ADMIN_USERNAME
            );

            const passwordCorrect = safeEqual(
                body.password || "",
                env.ADMIN_PASSWORD
            );

            if (!usernameCorrect || !passwordCorrect) {
                return json({
                    error: "Грешно потребителско име или парола."
                }, 401);
            }

            const token = await createSession(
                env.ADMIN_SESSION_SECRET
            );

            return json(
                { success: true },
                200,
                { "Set-Cookie": sessionCookie(token) }
            );
        }

        // PROTECT ALL OTHER ACTIONS
        if (
            !env.ADMIN_SESSION_SECRET ||
            !await verifySession(request, env.ADMIN_SESSION_SECRET)
        ) {
            return json({
                error: "Моля, влез първо като администратор."
            }, 401);
        }

        if (!env.DB) {
            return json({
                error: "D1 базата данни не е свързана."
            }, 500);
        }

        await ensureTables(env.DB);

        // PUBLISH
        if (body.action === "publish") {
            return await publishUpdate(env, body);
        }

        // DELETE
        if (body.action === "delete") {
            const id = Number(body.id);

            if (!Number.isSafeInteger(id) || id < 1) {
                return json({ error: "Невалиден номер на ъпдейт." }, 400);
            }

            const mediaResult = await env.DB.prepare(`
                SELECT object_key
                FROM update_media
                WHERE update_id = ?
            `).bind(id).all();

            const keys = (mediaResult.results || [])
                .map(item => item.object_key);

            if (keys.length > 0 && !env.MEDIA) {
                return json({
                    error: "R2 не е свързан. Файловете не са изтрити."
                }, 500);
            }

            if (env.MEDIA && keys.length > 0) {
                await Promise.all(
                    keys.map(key => env.MEDIA.delete(key))
                );
            }

            await env.DB.prepare(`
                DELETE FROM update_media WHERE update_id = ?
            `).bind(id).run();

            await env.DB.prepare(`
                DELETE FROM updates WHERE id = ?
            `).bind(id).run();

            return json({
                success: true,
                message: "Ъпдейтът е изтрит."
            });
        }

        return json({ error: "Непозната команда." }, 400);

    } catch (error) {
        console.error("Admin function error:", error);

        return json({
            error: "Възникна сървърна грешка."
        }, 500);
    }
}